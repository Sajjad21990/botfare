/**
 * Wallet top-ups through PayPal Orders v2. `startTopUp` creates the order and binds it to the
 * user; `completeTopUp` (the return page) and the PAYMENT.CAPTURE.COMPLETED webhook both credit
 * the wallet through `creditCapturedOrder`, which is idempotent by capture ID, so the wallet is
 * credited exactly once whichever arrives first.
 */
import type { PayPalClient } from "@botfare/paypal";
import { eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../db";
import { creditTopUp, walletBalanceMicros } from "../ledger";
import { type PayPalOrder, paypalOrders, type TopUp, topups } from "../schema";
import { centsToPayPalAmount, hasPayPalIssue, MoneyFlowError, payPalAmountToCents } from "./money";

/** The only top-up amounts the wallet offers: $5, $10, $20. */
export const TOP_UP_AMOUNTS_CENTS = [500, 1000, 2000] as const;
export const TOP_UP_DESCRIPTION = "BotFare wallet top-up";

export interface StartTopUpInput {
  ownerUserId: string;
  amountCents: number;
  returnUrl: string;
  cancelUrl: string;
}

export async function startTopUp(
  db: DbOrTx,
  paypal: Pick<PayPalClient, "createOrder">,
  input: StartTopUpInput,
): Promise<{ orderId: string; approveUrl: string }> {
  if (!(TOP_UP_AMOUNTS_CENTS as readonly number[]).includes(input.amountCents)) {
    throw new MoneyFlowError("invalid_amount", "Top-ups are $5, $10 or $20");
  }
  const order = await paypal.createOrder({
    amount: centsToPayPalAmount(input.amountCents),
    currency: "USD",
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
    description: TOP_UP_DESCRIPTION,
    customId: input.ownerUserId,
  });
  await db.insert(paypalOrders).values({
    orderId: order.id,
    ownerUserId: input.ownerUserId,
    amountCents: input.amountCents,
    status: "created",
  });
  return { orderId: order.id, approveUrl: order.approveUrl };
}

export interface CompleteTopUpResult {
  status: "captured" | "pending" | "failed";
  /** The owner's wallet balance after this call. */
  walletMicros: number;
  captureId?: string;
  grossCents?: number;
  feeCents?: number;
}

/**
 * Captures an approved order and credits the wallet. Refuses orders the user does not own.
 * Safe to call repeatedly: the capture uses a request ID derived from the order ID, and the
 * credit is idempotent by capture ID.
 */
export async function completeTopUp(
  db: Db,
  paypal: Pick<PayPalClient, "captureOrder">,
  input: { ownerUserId: string; orderId: string },
): Promise<CompleteTopUpResult> {
  const order = await getOwnedOrder(db, input);
  if (order.status !== "created") return orderResult(db, order);

  let capture: Awaited<ReturnType<PayPalClient["captureOrder"]>>;
  try {
    capture = await paypal.captureOrder(order.orderId, {
      requestId: `botfare-capture-${order.orderId}`,
    });
  } catch (err) {
    if (hasPayPalIssue(err, "ORDER_ALREADY_CAPTURED")) {
      // Captured elsewhere (another tab, or a request whose response we lost). The capture
      // webhook credits it; until then the order reads as pending.
      return orderResult(db, (await findOrder(db, order.orderId)) ?? order);
    }
    if (hasPayPalIssue(err, "ORDER_NOT_APPROVED") || hasPayPalIssue(err, "PAYER_ACTION_REQUIRED")) {
      throw new MoneyFlowError("not_approved", "The payment has not been approved in PayPal yet");
    }
    if (hasPayPalIssue(err, "INSTRUMENT_DECLINED") || hasPayPalIssue(err, "ORDER_EXPIRED")) {
      await markOrderFailed(db, order.orderId);
      return { status: "failed", walletMicros: await walletBalanceMicros(db, order.ownerUserId) };
    }
    throw err;
  }

  if (capture.captureStatus === "COMPLETED") {
    const credited = await creditCapturedOrder(db, {
      orderId: order.orderId,
      captureId: capture.captureId,
      grossCents: payPalAmountToCents(capture.gross),
      feeCents: capture.fee === null ? 0 : payPalAmountToCents(capture.fee),
      currency: capture.currency,
    });
    return capturedResult(db, credited.topup);
  }
  if (capture.captureStatus === "DECLINED" || capture.captureStatus === "FAILED") {
    await markOrderFailed(db, order.orderId);
    return { status: "failed", walletMicros: await walletBalanceMicros(db, order.ownerUserId) };
  }
  // PENDING: PayPal sends PAYMENT.CAPTURE.COMPLETED once it clears.
  await db
    .update(paypalOrders)
    .set({ captureId: capture.captureId, updatedAt: new Date() })
    .where(eq(paypalOrders.orderId, order.orderId));
  return { status: "pending", walletMicros: await walletBalanceMicros(db, order.ownerUserId) };
}

export interface CreditCapturedOrderInput {
  orderId: string;
  captureId: string;
  grossCents: number;
  feeCents: number;
  currency: string;
}

/**
 * Credits a COMPLETED capture of one of our orders to the order owner's wallet, once per
 * capture ID, after checking currency and amount against the order. Used by `completeTopUp`
 * and the PAYMENT.CAPTURE.COMPLETED webhook.
 */
export async function creditCapturedOrder(
  db: Db,
  input: CreditCapturedOrderInput,
): Promise<{ order: PayPalOrder; topup: TopUp; created: boolean }> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(paypalOrders)
      .where(eq(paypalOrders.orderId, input.orderId))
      .for("update");
    if (!order) throw new MoneyFlowError("not_found", `Unknown PayPal order ${input.orderId}`);
    if (input.currency !== "USD" || input.grossCents !== order.amountCents) {
      throw new MoneyFlowError(
        "amount_mismatch",
        `Capture ${input.captureId} is ${input.currency} ${centsToPayPalAmount(input.grossCents)}, expected USD ${centsToPayPalAmount(order.amountCents)}`,
      );
    }
    const credited = await creditTopUp(tx, {
      ownerUserId: order.ownerUserId,
      orderId: order.orderId,
      captureId: input.captureId,
      grossCents: input.grossCents,
      feeCents: input.feeCents,
    });
    const [updated] = await tx
      .update(paypalOrders)
      .set({ status: "captured", captureId: input.captureId, updatedAt: new Date() })
      .where(eq(paypalOrders.orderId, order.orderId))
      .returning();
    return { order: updated ?? order, topup: credited.topup, created: credited.created };
  });
}

/** The order if `ownerUserId` created it; otherwise `not_found` (never reveals other users' orders). */
export async function getOwnedOrder(
  db: DbOrTx,
  input: { ownerUserId: string; orderId: string },
): Promise<PayPalOrder> {
  const order = await findOrder(db, input.orderId);
  if (!order || order.ownerUserId !== input.ownerUserId) {
    throw new MoneyFlowError("not_found", "Top-up not found");
  }
  return order;
}

async function findOrder(db: DbOrTx, orderId: string): Promise<PayPalOrder | null> {
  const [order] = await db.select().from(paypalOrders).where(eq(paypalOrders.orderId, orderId));
  return order ?? null;
}

async function markOrderFailed(db: DbOrTx, orderId: string) {
  await db
    .update(paypalOrders)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(paypalOrders.orderId, orderId));
}

async function orderResult(db: DbOrTx, order: PayPalOrder): Promise<CompleteTopUpResult> {
  if (order.status === "captured" && order.captureId) {
    const [topup] = await db.select().from(topups).where(eq(topups.captureId, order.captureId));
    if (topup) return capturedResult(db, topup);
  }
  const walletMicros = await walletBalanceMicros(db, order.ownerUserId);
  return { status: order.status === "failed" ? "failed" : "pending", walletMicros };
}

async function capturedResult(db: DbOrTx, topup: TopUp): Promise<CompleteTopUpResult> {
  return {
    status: "captured",
    walletMicros: await walletBalanceMicros(db, topup.ownerUserId),
    captureId: topup.captureId,
    grossCents: topup.grossCents,
    feeCents: topup.feeCents,
  };
}
