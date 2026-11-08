/**
 * Publisher payouts through PayPal Payouts. Earnings move to `paypal:clearing` in the same
 * database transaction that creates the payout row (kind `payout`, key `payout:<id>`); PayPal is
 * called afterwards. A definitive PayPal refusal, or a later FAILED / RETURNED / UNCLAIMED /
 * BLOCKED / REFUNDED / REVERSED item, moves the money back exactly once (kind `payout_reversal`,
 * key `reversal:<id>`). An indeterminate failure (network, 5xx) leaves the row pending; the retry
 * reuses the same `sender_batch_id`, which PayPal dedupes for 30 days.
 */
import { IdPrefix, newId } from "@botfare/contracts";
import type { PayoutItem, PayPalClient } from "@botfare/paypal";
import { centsToMicros } from "@botfare/x402-paypal";
import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { Accounts } from "../accounts";
import type { Db, DbOrTx, Tx } from "../db";
import { postTransaction } from "../ledger";
import {
  ledgerAccounts,
  type Payout,
  type PayoutStatus,
  payouts,
  sites,
  type User,
  users,
} from "../schema";
import {
  centsToPayPalAmount,
  errorMessage,
  isDefinitivePayPalFailure,
  MoneyFlowError,
} from "./money";

export const DEFAULT_PAYOUT_MINIMUM_CENTS = 100;
export const PAYOUT_NOTE = "BotFare earnings";

type PayoutPayPal = Pick<PayPalClient, "createPayoutBatch">;
type SyncPayPal = Pick<PayPalClient, "createPayoutBatch" | "getPayoutBatch">;

/** Statuses that mean the money did not reach the publisher; each triggers one reversal. */
export const REVERSED_PAYOUT_STATUSES = ["failed", "returned", "unclaimed", "reversed"] as const;
/** Statuses that may still change at PayPal. */
export const OPEN_PAYOUT_STATUSES = ["pending", "processing"] as const;

// ---------------------------------------------------------------------------------------------
// Payout email

const emailSchema = z.email().transform((email) => email.trim().toLowerCase());

export async function setPayoutEmail(
  db: DbOrTx,
  input: { userId: string; email: string | null },
): Promise<User> {
  const email = input.email === null ? null : emailSchema.parse(input.email.trim());
  const [user] = await db
    .update(users)
    .set({ payoutEmail: email })
    .where(eq(users.id, input.userId))
    .returning();
  if (!user) throw new MoneyFlowError("not_found", "User not found");
  return user;
}

/** The publisher's payout email, falling back to the payout email of their first site. */
export async function getPayoutEmail(db: DbOrTx, userId: string): Promise<string | null> {
  const [user] = await db
    .select({ payoutEmail: users.payoutEmail })
    .from(users)
    .where(eq(users.id, userId));
  if (user?.payoutEmail) return user.payoutEmail;
  const [site] = await db
    .select({ payoutEmail: sites.payoutEmail })
    .from(sites)
    .where(eq(sites.ownerUserId, userId))
    .orderBy(asc(sites.createdAt), asc(sites.id));
  return site?.payoutEmail ?? null;
}

// ---------------------------------------------------------------------------------------------
// Creating payouts

/** A fresh PayPal `sender_batch_id`; one per "Withdraw now" or per daily run. */
export function newPayoutBatchKey(kind: "withdraw" | "daily"): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `botfare-${kind}-${day}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** "Withdraw now": pays out the publisher's whole-cent earnings in a batch of its own. */
export async function requestPayout(
  db: Db,
  paypal: PayoutPayPal,
  input: { publisherUserId: string; minimumCents?: number },
): Promise<Payout> {
  const minimumCents = validMinimum(input.minimumCents);
  const receiverEmail = await getPayoutEmail(db, input.publisherUserId);
  if (!receiverEmail) {
    throw new MoneyFlowError("no_payout_email", "Add a PayPal payout email first");
  }
  const batchKey = newPayoutBatchKey("withdraw");
  const payout = await db.transaction((tx) =>
    reservePayout(tx, {
      publisherUserId: input.publisherUserId,
      receiverEmail,
      batchKey,
      minimumCents,
    }),
  );
  if (!payout) {
    throw new MoneyFlowError(
      "below_minimum",
      `Payouts start at ${centsToPayPalAmount(minimumCents)} USD`,
    );
  }
  await submitPayoutBatch(db, paypal, batchKey);
  return (await getPayout(db, payout.id)) ?? payout;
}

export interface DailyPayoutRun {
  /** Null when nobody was eligible and PayPal was not called. */
  batchKey: string | null;
  payouts: Payout[];
  /** Publishers with enough earnings but no payout email. */
  skippedNoEmail: string[];
}

/** One Payouts batch with one item per publisher whose earnings reach the minimum. */
export async function runDailyPayouts(
  db: Db,
  paypal: PayoutPayPal,
  input: { minimumCents?: number } = {},
): Promise<DailyPayoutRun> {
  const minimumCents = validMinimum(input.minimumCents);
  const candidates = await db
    .select({ userId: ledgerAccounts.ownerUserId })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, "earnings"),
        gte(ledgerAccounts.balanceMicros, centsToMicros(minimumCents)),
      ),
    )
    .orderBy(asc(ledgerAccounts.id));

  const batchKey = newPayoutBatchKey("daily");
  const created: Payout[] = [];
  const skippedNoEmail: string[] = [];
  for (const { userId } of candidates) {
    if (!userId) continue;
    const receiverEmail = await getPayoutEmail(db, userId);
    if (!receiverEmail) {
      skippedNoEmail.push(userId);
      continue;
    }
    const payout = await db.transaction((tx) =>
      reservePayout(tx, { publisherUserId: userId, receiverEmail, batchKey, minimumCents }),
    );
    if (payout) created.push(payout);
  }
  if (created.length === 0) return { batchKey: null, payouts: [], skippedNoEmail };

  await submitPayoutBatch(db, paypal, batchKey);
  const rows = await db.select().from(payouts).where(eq(payouts.batchKey, batchKey));
  return { batchKey, payouts: rows, skippedNoEmail };
}

/**
 * Locks the earnings account, takes its whole cents, posts the payout and inserts the row.
 * Returns null when the amount is below the minimum.
 */
async function reservePayout(
  tx: Tx,
  input: { publisherUserId: string; receiverEmail: string; batchKey: string; minimumCents: number },
): Promise<Payout | null> {
  const earningsId = Accounts.earnings(input.publisherUserId);
  const [account] = await tx
    .select({ balance: ledgerAccounts.balanceMicros })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.id, earningsId))
    .for("update");
  const amountCents = Math.floor((account?.balance ?? 0) / centsToMicros(1));
  if (amountCents < input.minimumCents || amountCents <= 0) return null;

  const id = newId(IdPrefix.payout);
  const amountMicros = centsToMicros(amountCents);
  const posted = await postTransaction(tx, {
    kind: "payout",
    idempotencyKey: `payout:${id}`,
    memo: `Payout ${id} to ${input.receiverEmail}`,
    entries: [
      { accountId: earningsId, amountMicros: -amountMicros },
      { accountId: Accounts.paypalClearing, amountMicros },
    ],
  });
  const [row] = await tx
    .insert(payouts)
    .values({
      id,
      batchKey: input.batchKey,
      publisherUserId: input.publisherUserId,
      receiverEmail: input.receiverEmail,
      amountCents,
      status: "pending",
      transactionId: posted.transactionId,
    })
    .returning();
  if (!row) throw new Error(`Failed to insert payout ${id}`);
  return row;
}

/**
 * Sends every item of a batch to PayPal (also the retry after an indeterminate failure: same
 * `sender_batch_id`, same `PayPal-Request-Id`, same items).
 */
async function submitPayoutBatch(db: Db, paypal: PayoutPayPal, batchKey: string): Promise<void> {
  const rows = await db
    .select()
    .from(payouts)
    .where(eq(payouts.batchKey, batchKey))
    .orderBy(asc(payouts.id));
  if (rows.length === 0) return;
  try {
    const result = await paypal.createPayoutBatch({
      senderBatchId: batchKey,
      requestId: batchKey,
      emailSubject: "You have a payout from BotFare",
      emailMessage: "Your BotFare earnings from paid AI agent requests.",
      items: rows.map((row) => ({
        receiver: row.receiverEmail,
        amount: centsToPayPalAmount(row.amountCents),
        currency: "USD",
        note: PAYOUT_NOTE,
        senderItemId: row.id,
      })),
    });
    await db
      .update(payouts)
      .set({ paypalBatchId: result.batchId, error: null, updatedAt: new Date() })
      .where(eq(payouts.batchKey, batchKey));
    await applyBatchStatus(db, batchKey, result.batchStatus);
  } catch (err) {
    if (isDefinitivePayPalFailure(err)) {
      for (const row of rows) await reversePayout(db, row.id, "failed", errorMessage(err));
      return;
    }
    // Indeterminate: PayPal may have the batch. Stay pending; syncPendingPayouts retries.
    await db
      .update(payouts)
      .set({ error: `Retrying: ${errorMessage(err)}`, updatedAt: new Date() })
      .where(and(eq(payouts.batchKey, batchKey), eq(payouts.status, "pending")));
  }
}

// ---------------------------------------------------------------------------------------------
// Status updates and reversals

/** Maps a PayPal item `transaction_status` to ours. Null for statuses we don't track. */
export function payoutStatusFromPayPal(transactionStatus: string): PayoutStatus | null {
  switch (transactionStatus.toUpperCase()) {
    case "SUCCESS":
    case "SUCCEEDED":
      return "success";
    case "PENDING":
    case "ONHOLD":
    case "HELD":
    case "NEW":
      return "processing";
    case "FAILED":
    case "BLOCKED":
    case "DENIED":
    case "CANCELED":
    case "CANCELLED":
      return "failed";
    case "RETURNED":
      return "returned";
    case "UNCLAIMED":
      return "unclaimed";
    case "REFUNDED":
    case "REVERSED":
      return "reversed";
    default:
      return null;
  }
}

function isReversedStatus(status: PayoutStatus): boolean {
  return (REVERSED_PAYOUT_STATUSES as readonly string[]).includes(status);
}

export interface PayoutItemUpdate {
  status: PayoutStatus;
  paypalBatchId?: string | null;
  paypalItemId?: string | null;
  paypalTransactionId?: string | null;
  error?: string | null;
}

/**
 * Applies a status from PayPal (sync or webhook) to one payout. Failure statuses move the money
 * back to earnings exactly once. A payout that was already reversed keeps its reversal.
 */
export async function applyPayoutUpdate(
  db: Db,
  payoutId: string,
  update: PayoutItemUpdate,
): Promise<Payout | null> {
  const ids = {
    ...(update.paypalBatchId && { paypalBatchId: update.paypalBatchId }),
    ...(update.paypalItemId && { paypalItemId: update.paypalItemId }),
    ...(update.paypalTransactionId && { paypalTransactionId: update.paypalTransactionId }),
  };
  if (isReversedStatus(update.status)) {
    if (Object.keys(ids).length) {
      await db.update(payouts).set(ids).where(eq(payouts.id, payoutId));
    }
    return reversePayout(db, payoutId, update.status, update.error ?? null);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for("update");
    if (!row) return null;
    if (row.reversalTransactionId) {
      // Money already returned to earnings; never move it again automatically.
      const note =
        update.status === "success"
          ? "PayPal reported SUCCESS after the payout was reversed"
          : null;
      const [updated] = await tx
        .update(payouts)
        .set({ ...ids, ...(note && { error: note }), updatedAt: new Date() })
        .where(eq(payouts.id, payoutId))
        .returning();
      return updated ?? row;
    }
    const [updated] = await tx
      .update(payouts)
      .set({
        ...ids,
        status: update.status,
        error: update.status === "success" ? null : (update.error ?? row.error),
        updatedAt: new Date(),
      })
      .where(eq(payouts.id, payoutId))
      .returning();
    return updated ?? row;
  });
}

/** Moves a payout's amount back to earnings once and records the failure status. */
async function reversePayout(
  db: Db,
  payoutId: string,
  status: PayoutStatus,
  error: string | null,
): Promise<Payout | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for("update");
    if (!row) return null;
    const amountMicros = centsToMicros(row.amountCents);
    const posted = await postTransaction(tx, {
      kind: "payout_reversal",
      idempotencyKey: `reversal:${row.id}`,
      memo: `Payout ${row.id} ${status}`,
      entries: [
        { accountId: Accounts.paypalClearing, amountMicros: -amountMicros },
        { accountId: Accounts.earnings(row.publisherUserId), amountMicros },
      ],
    });
    const [updated] = await tx
      .update(payouts)
      .set({
        status,
        error: error ?? row.error,
        reversalTransactionId: posted.transactionId,
        updatedAt: new Date(),
      })
      .where(eq(payouts.id, row.id))
      .returning();
    return updated ?? row;
  });
}

/** Batch-level status from PayPal (create response, webhook or sync). */
export async function applyBatchStatus(
  db: Db,
  batchKey: string,
  batchStatus: string,
  error?: string,
): Promise<void> {
  const status = batchStatus.toUpperCase();
  if (status === "DENIED" || status === "CANCELED" || status === "CANCELLED") {
    const rows = await db
      .select({ id: payouts.id })
      .from(payouts)
      .where(and(eq(payouts.batchKey, batchKey), inArray(payouts.status, OPEN_PAYOUT_STATUSES)));
    for (const row of rows) {
      await reversePayout(db, row.id, "failed", error ?? `PayPal batch ${status}`);
    }
    return;
  }
  if (status === "PROCESSING" || status === "SUCCESS") {
    await db
      .update(payouts)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(payouts.batchKey, batchKey), eq(payouts.status, "pending")));
  }
}

/** Refreshes one payout from PayPal; resubmits its batch if PayPal never confirmed it. */
export async function syncPayout(
  db: Db,
  paypal: SyncPayPal,
  payoutId: string,
): Promise<Payout | null> {
  const row = await getPayout(db, payoutId);
  if (!row) return null;
  await syncPayoutBatch(db, paypal, row.batchKey);
  return getPayout(db, payoutId);
}

/** Refreshes every open payout (one PayPal call per batch). For a cron or a dashboard button. */
export async function syncPendingPayouts(
  db: Db,
  paypal: SyncPayPal,
): Promise<{ batches: number; errors: { batchKey: string; error: string }[] }> {
  const open = await db
    .selectDistinct({ batchKey: payouts.batchKey })
    .from(payouts)
    .where(inArray(payouts.status, OPEN_PAYOUT_STATUSES));
  const errors: { batchKey: string; error: string }[] = [];
  for (const { batchKey } of open) {
    try {
      await syncPayoutBatch(db, paypal, batchKey);
    } catch (err) {
      errors.push({ batchKey, error: errorMessage(err) });
    }
  }
  return { batches: open.length, errors };
}

/** Refreshes every item of one batch (`sender_batch_id`) from PayPal. */
export async function syncPayoutBatch(db: Db, paypal: SyncPayPal, batchKey: string): Promise<void> {
  const rows = await db.select().from(payouts).where(eq(payouts.batchKey, batchKey));
  const paypalBatchId = rows.find((row) => row.paypalBatchId)?.paypalBatchId;
  if (!paypalBatchId) {
    if (rows.some((row) => row.status === "pending")) {
      await submitPayoutBatch(db, paypal, batchKey);
    }
    return;
  }
  const batch = await paypal.getPayoutBatch(paypalBatchId);
  await applyBatchStatus(db, batchKey, batch.batchStatus);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const item of batch.items) {
    const row = item.senderItemId ? byId.get(item.senderItemId) : undefined;
    if (!row) continue;
    const status = payoutStatusFromPayPal(item.transactionStatus);
    if (!status) continue;
    await applyPayoutUpdate(db, row.id, {
      status,
      paypalBatchId,
      paypalItemId: item.payoutItemId,
      error: itemError(item),
    });
  }
}

function itemError(item: PayoutItem): string | null {
  return item.errors ? `${item.errors.name}: ${item.errors.message}`.slice(0, 500) : null;
}

// ---------------------------------------------------------------------------------------------
// Reads

export async function getPayout(db: DbOrTx, payoutId: string): Promise<Payout | null> {
  const [row] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  return row ?? null;
}

/** The publisher's payouts, newest first. */
export function listPayouts(
  db: DbOrTx,
  publisherUserId: string,
  options: { limit?: number } = {},
): Promise<Payout[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
  return db
    .select()
    .from(payouts)
    .where(eq(payouts.publisherUserId, publisherUserId))
    .orderBy(desc(payouts.createdAt), desc(payouts.id))
    .limit(limit);
}

/** Payouts whose batch never reached PayPal (indeterminate failure); used by tests and ops. */
export function listUnsubmittedPayouts(db: DbOrTx): Promise<Payout[]> {
  return db
    .select()
    .from(payouts)
    .where(and(eq(payouts.status, "pending"), isNull(payouts.paypalBatchId)));
}

function validMinimum(minimumCents: number | undefined): number {
  const value = minimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MoneyFlowError("invalid_amount", "minimumCents must be a positive integer");
  }
  return value;
}
