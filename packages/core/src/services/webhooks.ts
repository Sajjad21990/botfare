/**
 * PayPal webhook events, after the route has verified the signature. Every event is recorded in
 * `webhook_events` and deduped by PayPal's event ID; every handler is idempotent, so an event
 * that failed earlier (PayPal retries it) is simply processed again.
 */
import type { PayPalClient } from "@botfare/paypal";
import { and, eq, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { payouts, paypalOrders, type WebhookEventStatus, webhookEvents } from "../schema";
import { errorMessage, MoneyFlowError, payPalAmountToCents } from "./money";
import {
  applyBatchStatus,
  applyPayoutUpdate,
  payoutStatusFromPayPal,
  syncPayoutBatch,
} from "./payouts";
import { creditCapturedOrder } from "./topups";

type WebhookPayPal = Pick<PayPalClient, "createPayoutBatch" | "getPayoutBatch">;

export interface WebhookResult {
  status: "processed" | "ignored" | "duplicate" | "failed";
  eventId?: string;
  eventType?: string;
  /** Why it was ignored or failed. */
  error?: string;
  /** For `failed`: true when PayPal should redeliver (answer non-2xx), false when retrying won't help. */
  retryable?: boolean;
}

const envelopeSchema = z.looseObject({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.record(z.string(), z.unknown()).default({}),
});

const moneySchema = z.looseObject({ value: z.string(), currency_code: z.string() });

const captureResourceSchema = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  amount: moneySchema,
  seller_receivable_breakdown: z
    .looseObject({ gross_amount: moneySchema.optional(), paypal_fee: moneySchema.optional() })
    .optional(),
  supplementary_data: z
    .looseObject({
      related_ids: z.looseObject({ order_id: z.string().optional() }).optional(),
    })
    .optional(),
});

const payoutItemResourceSchema = z.looseObject({
  payout_item_id: z.string().optional(),
  transaction_id: z.string().optional(),
  transaction_status: z.string().optional(),
  payout_batch_id: z.string().optional(),
  payout_item: z.looseObject({ sender_item_id: z.string().optional() }).optional(),
  errors: z.looseObject({ name: z.string().optional(), message: z.string().optional() }).optional(),
});

const payoutBatchResourceSchema = z.looseObject({
  batch_header: z.looseObject({
    payout_batch_id: z.string().optional(),
    batch_status: z.string(),
    sender_batch_header: z.looseObject({ sender_batch_id: z.string().optional() }).optional(),
  }),
});

type Outcome = { status: "processed" | "ignored"; error?: string };

export async function handlePayPalWebhookEvent(
  db: Db,
  paypal: WebhookPayPal,
  event: unknown,
): Promise<WebhookResult> {
  const parsed = envelopeSchema.safeParse(event);
  if (!parsed.success) {
    return { status: "failed", error: "Not a PayPal webhook event", retryable: false };
  }
  const { id: eventId, event_type: eventType, resource } = parsed.data;
  const base = { eventId, eventType };

  const inserted = await db
    .insert(webhookEvents)
    .values({
      paypalEventId: eventId,
      eventType,
      resourceId: resourceIdOf(resource),
      payload: event,
      status: "received",
    })
    .onConflictDoNothing({ target: webhookEvents.paypalEventId })
    .returning({ id: webhookEvents.id });
  if (inserted.length === 0) {
    const [existing] = await db
      .select({ status: webhookEvents.status })
      .from(webhookEvents)
      .where(eq(webhookEvents.paypalEventId, eventId));
    if (existing?.status !== "failed") return { ...base, status: "duplicate" };
  }

  try {
    const outcome = await dispatch(db, paypal, eventType, resource);
    await finish(db, eventId, outcome.status, outcome.error ?? null);
    return { ...base, ...outcome };
  } catch (err) {
    const error = errorMessage(err);
    await finish(db, eventId, "failed", error);
    // Our own refusals (amount mismatch, unknown order) won't change on redelivery.
    return { ...base, status: "failed", error, retryable: !(err instanceof MoneyFlowError) };
  }
}

async function dispatch(
  db: Db,
  paypal: WebhookPayPal,
  eventType: string,
  resource: Record<string, unknown>,
): Promise<Outcome> {
  if (eventType === "PAYMENT.CAPTURE.COMPLETED") return captureCompleted(db, resource);
  if (eventType === "PAYMENT.CAPTURE.DENIED" || eventType === "PAYMENT.CAPTURE.DECLINED") {
    return captureDenied(db, resource);
  }
  if (eventType.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    return payoutItemEvent(db, eventType, resource);
  }
  if (eventType.startsWith("PAYMENT.PAYOUTSBATCH.")) {
    return payoutBatchEvent(db, paypal, resource);
  }
  return { status: "ignored", error: `Unhandled event type ${eventType}` };
}

async function captureCompleted(db: Db, resource: Record<string, unknown>): Promise<Outcome> {
  const capture = captureResourceSchema.parse(resource);
  const orderId = capture.supplementary_data?.related_ids?.order_id;
  if (!orderId) return { status: "ignored", error: "Capture has no related order ID" };
  const [order] = await db.select().from(paypalOrders).where(eq(paypalOrders.orderId, orderId));
  if (!order) return { status: "ignored", error: `Order ${orderId} is not a BotFare top-up` };

  const gross = capture.seller_receivable_breakdown?.gross_amount ?? capture.amount;
  const fee = capture.seller_receivable_breakdown?.paypal_fee;
  await creditCapturedOrder(db, {
    orderId,
    captureId: capture.id,
    grossCents: payPalAmountToCents(gross.value),
    feeCents: fee ? payPalAmountToCents(fee.value) : 0,
    currency: gross.currency_code,
  });
  return { status: "processed" };
}

async function captureDenied(db: Db, resource: Record<string, unknown>): Promise<Outcome> {
  const capture = captureResourceSchema.partial({ amount: true }).parse(resource);
  const orderId = capture.supplementary_data?.related_ids?.order_id;
  if (!orderId) return { status: "ignored", error: "Capture has no related order ID" };
  const updated = await db
    .update(paypalOrders)
    .set({ status: "failed", captureId: capture.id, updatedAt: new Date() })
    // A captured order never goes back to failed.
    .where(and(eq(paypalOrders.orderId, orderId), ne(paypalOrders.status, "captured")))
    .returning({ status: paypalOrders.status });
  return updated.length ? { status: "processed" } : { status: "ignored", error: "Unknown order" };
}

async function payoutItemEvent(
  db: Db,
  eventType: string,
  resource: Record<string, unknown>,
): Promise<Outcome> {
  const item = payoutItemResourceSchema.parse(resource);
  const senderItemId = item.payout_item?.sender_item_id;
  const filters = [
    ...(senderItemId ? [eq(payouts.id, senderItemId)] : []),
    ...(item.payout_item_id ? [eq(payouts.paypalItemId, item.payout_item_id)] : []),
  ];
  if (filters.length === 0) return { status: "ignored", error: "Payout item has no IDs" };
  const [row] = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(or(...filters));
  if (!row) return { status: "ignored", error: "Not a BotFare payout item" };

  const status = payoutStatusFromPayPal(
    item.transaction_status ?? eventType.slice("PAYMENT.PAYOUTS-ITEM.".length),
  );
  if (!status) return { status: "ignored", error: `Unknown payout item status in ${eventType}` };
  const error = item.errors
    ? [item.errors.name, item.errors.message].filter(Boolean).join(": ")
    : null;
  await applyPayoutUpdate(db, row.id, {
    status,
    paypalBatchId: item.payout_batch_id ?? null,
    paypalItemId: item.payout_item_id ?? null,
    paypalTransactionId: item.transaction_id ?? null,
    error,
  });
  return { status: "processed" };
}

async function payoutBatchEvent(
  db: Db,
  paypal: WebhookPayPal,
  resource: Record<string, unknown>,
): Promise<Outcome> {
  const { batch_header: header } = payoutBatchResourceSchema.parse(resource);
  const batchKey = header.sender_batch_header?.sender_batch_id;
  const filters = [
    ...(batchKey ? [eq(payouts.batchKey, batchKey)] : []),
    ...(header.payout_batch_id ? [eq(payouts.paypalBatchId, header.payout_batch_id)] : []),
  ];
  if (filters.length === 0) return { status: "ignored", error: "Payout batch has no IDs" };
  const [row] = await db
    .select({ batchKey: payouts.batchKey })
    .from(payouts)
    .where(or(...filters));
  if (!row) return { status: "ignored", error: "Not a BotFare payout batch" };

  if (header.payout_batch_id) {
    await db
      .update(payouts)
      .set({ paypalBatchId: header.payout_batch_id, updatedAt: new Date() })
      .where(eq(payouts.batchKey, row.batchKey));
  }
  await applyBatchStatus(db, row.batchKey, header.batch_status);
  if (header.batch_status.toUpperCase() === "SUCCESS" && header.payout_batch_id) {
    // Item events can lag or be missing in sandbox; pull the item statuses now.
    await syncPayoutBatch(db, paypal, row.batchKey);
  }
  return { status: "processed" };
}

async function finish(db: Db, eventId: string, status: WebhookEventStatus, error: string | null) {
  await db
    .update(webhookEvents)
    .set({ status, error, processedAt: new Date() })
    .where(eq(webhookEvents.paypalEventId, eventId));
}

function resourceIdOf(resource: Record<string, unknown>): string | null {
  const header = resource.batch_header as { payout_batch_id?: unknown } | undefined;
  for (const candidate of [resource.id, resource.payout_item_id, header?.payout_batch_id]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}
