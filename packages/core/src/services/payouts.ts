/**
 * Publisher payouts through PayPal Payouts. Earnings move to `paypal:clearing` in the same
 * database transaction that creates the payout row (kind `payout`, key `payout:<id>`); PayPal is
 * called afterwards.
 *
 * - A refusal of the first attempt (a 4xx), or a later FAILED / RETURNED / BLOCKED / REFUNDED /
 *   REVERSED item, moves the money back exactly once (kind `payout_reversal`, key `reversal:<id>`).
 * - UNCLAIMED is not final: PayPal holds the money for 30 days and the receiver can still claim it
 *   (SUCCEEDED) or it comes back (RETURNED). The money stays in clearing until then.
 * - An indeterminate failure (network, timeout, 5xx) leaves the row pending. The retry reuses the
 *   same `sender_batch_id`; if PayPal already has the batch it answers 400 "Batch with given
 *   sender_batch_id already exists" with a link to it, and we adopt that batch. A retry is never
 *   reversed automatically: PayPal may hold the first attempt, so it waits for review instead.
 * - One caller at a time sends a batch (`submit_locked_until`), so Withdraw, Refresh and the cron
 *   cannot POST it concurrently.
 * - Dispute-window hold: only *available* earnings are paid. A fare stays *clearing* while an
 *   agent can still dispute it (DISPUTE_POLICY.windowHours after settle) and while a dispute on it
 *   is undecided, so a Fare Court refund always finds the publisher's share still in earnings.
 */
import { IdPrefix, newId } from "@botfare/contracts";
import { DISPUTE_POLICY } from "@botfare/contracts/fare";
import type { PayoutItem, PayPalClient } from "@botfare/paypal";
import { PayPalApiError } from "@botfare/paypal";
import { centsToMicros } from "@botfare/x402-paypal";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { Accounts } from "../accounts";
import type { Db, DbOrTx, Tx } from "../db";
import { earningsBalanceMicros, postTransaction } from "../ledger";
import {
  disputes,
  ledgerAccounts,
  type Payout,
  type PayoutStatus,
  payouts,
  receipts,
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
export const REVERSED_PAYOUT_STATUSES = ["failed", "returned", "reversed"] as const;
/**
 * Statuses that may still change at PayPal. `unclaimed` is one of them: the receiver has 30 days
 * to claim the money before PayPal returns it.
 */
export const OPEN_PAYOUT_STATUSES = ["pending", "processing", "unclaimed"] as const;

/** How long one caller may hold a batch while it waits for PayPal (the client has no timeout). */
const SUBMIT_LOCK_MS = 2 * 60 * 1000;

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

/** The publisher's payout email, falling back to the oldest of their sites that has one. */
export async function getPayoutEmail(db: DbOrTx, userId: string): Promise<string | null> {
  const [user] = await db
    .select({ payoutEmail: users.payoutEmail })
    .from(users)
    .where(eq(users.id, userId));
  if (user?.payoutEmail) return user.payoutEmail;
  const [site] = await db
    .select({ payoutEmail: sites.payoutEmail })
    .from(sites)
    .where(and(eq(sites.ownerUserId, userId), isNotNull(sites.payoutEmail)))
    .orderBy(asc(sites.createdAt), asc(sites.id))
    .limit(1);
  return site?.payoutEmail ?? null;
}

// ---------------------------------------------------------------------------------------------
// Available and clearing earnings (the dispute-window hold)

const HOUR_MS = 3_600_000;
const MICROS_PER_CENT = centsToMicros(1);

/** Dispute statuses that hold a fare's earnings back from payouts until they are decided. */
export const PAYOUT_HOLD_DISPUTE_STATUSES = ["open", "pending_publisher"] as const;

export interface EarningsSplit {
  /** The publisher's whole earnings balance (ledger). */
  balanceMicros: number;
  /**
   * The publisher's share (amount minus BotFare's fee) of settled, unrefunded fares that an agent
   * may still dispute (settled less than DISPUTE_POLICY.windowHours ago) or whose dispute is
   * undecided (`open` or `pending_publisher`, any age).
   */
  clearingMicros: number;
  /** What a payout may take now: max(0, balance - clearing). */
  availableMicros: number;
  /** When the oldest in-window fare without an undecided dispute stops clearing; null if none. */
  nextReleaseAt: Date | null;
}

/**
 * How much of a publisher's earnings a payout may take at `now`, and how much is still clearing.
 * Read-only; reservePayout runs the same split inside its transaction after locking the earnings.
 */
export async function publisherEarningsSplit(
  db: DbOrTx,
  publisherUserId: string,
  now: Date = new Date(),
): Promise<EarningsSplit> {
  const balanceMicros = await earningsBalanceMicros(db, publisherUserId);
  return splitEarnings(db, publisherUserId, balanceMicros, now);
}

async function splitEarnings(
  db: DbOrTx,
  publisherUserId: string,
  balanceMicros: number,
  now: Date,
): Promise<EarningsSplit> {
  const windowMs = DISPUTE_POLICY.windowHours * HOUR_MS;
  // Fare Court accepts a dispute while now - createdAt <= window, so a fare exactly at the
  // boundary still counts as clearing.
  const inWindow = gte(receipts.createdAt, new Date(now.getTime() - windowMs));
  const undecidedDispute = exists(
    db
      .select({ one: sql`1` })
      .from(disputes)
      .where(
        and(
          eq(disputes.receiptId, receipts.id),
          inArray(disputes.status, [...PAYOUT_HOLD_DISPUTE_STATUSES]),
        ),
      ),
  );
  const [row] = await db
    .select({
      clearing: sql<string>`coalesce(sum(${receipts.amountMicros} - ${receipts.feeMicros}), 0)`,
      oldest: sql<string | Date | null>`min(${receipts.createdAt}) filter (where ${and(
        inWindow,
        not(undecidedDispute),
      )})`,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.publisherUserId, publisherUserId),
        eq(receipts.status, "settled"),
        or(inWindow, undecidedDispute),
      ),
    );
  const clearingMicros = Number(row?.clearing ?? 0);
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    balanceMicros,
    clearingMicros,
    availableMicros: Math.max(0, balanceMicros - clearingMicros),
    nextReleaseAt: oldest ? new Date(oldest.getTime() + windowMs) : null,
  };
}

/** $1.23, or $0.0285 when the amount has a sub-cent part. */
function formatUsdMicros(micros: number): string {
  const digits = micros % MICROS_PER_CENT === 0 ? 2 : 4;
  return `$${(micros / 1_000_000).toFixed(digits)}`;
}

function belowMinimumError(split: EarningsSplit, minimumCents: number): MoneyFlowError {
  if (split.clearingMicros <= 0) {
    return new MoneyFlowError(
      "below_minimum",
      `Payouts start at ${centsToPayPalAmount(minimumCents)} USD`,
    );
  }
  const availableCents = Math.floor(split.availableMicros / MICROS_PER_CENT);
  return new MoneyFlowError(
    "below_minimum",
    `${formatUsdMicros(split.clearingMicros)} is still clearing (${DISPUTE_POLICY.windowHours}-hour dispute window); ` +
      `available now: $${centsToPayPalAmount(availableCents)}. Payouts start at $${centsToPayPalAmount(minimumCents)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Creating payouts

/** A fresh PayPal `sender_batch_id`; one per "Withdraw now" or per daily run. */
export function newPayoutBatchKey(kind: "withdraw" | "daily"): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `botfare-${kind}-${day}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * "Withdraw now": pays out the publisher's whole-cent *available* earnings (not those still
 * clearing in the dispute window) in a batch of its own.
 */
export async function requestPayout(
  db: Db,
  paypal: PayoutPayPal,
  input: { publisherUserId: string; minimumCents?: number; now?: Date },
): Promise<Payout> {
  const minimumCents = validMinimum(input.minimumCents);
  const receiverEmail = await getPayoutEmail(db, input.publisherUserId);
  if (!receiverEmail) {
    throw new MoneyFlowError("no_payout_email", "Add a PayPal payout email first");
  }
  const batchKey = newPayoutBatchKey("withdraw");
  const { payout, split } = await db.transaction((tx) =>
    reservePayout(tx, {
      publisherUserId: input.publisherUserId,
      receiverEmail,
      batchKey,
      minimumCents,
      now: input.now ?? new Date(),
    }),
  );
  if (!payout) throw belowMinimumError(split, minimumCents);
  await submitPayoutBatch(db, paypal, batchKey);
  return (await getPayout(db, payout.id)) ?? payout;
}

export interface DailyPayoutRun {
  /** Null when nobody was eligible and PayPal was not called. */
  batchKey: string | null;
  payouts: Payout[];
  /** Publishers with enough earnings but no payout email. */
  skippedNoEmail: string[];
  /**
   * Candidates with earnings still clearing in the dispute window: held back from their payout
   * (`payoutId` set) or the reason there is none (`payoutId` null: available is below the minimum).
   */
  clearing: ClearingHold[];
}

export interface ClearingHold {
  publisherUserId: string;
  payoutId: string | null;
  clearingMicros: number;
  availableMicros: number;
  nextReleaseAt: Date | null;
}

/**
 * One Payouts batch with one item per publisher whose *available* earnings reach the minimum.
 * Candidates are picked by balance; the reservation pays only what is available.
 */
export async function runDailyPayouts(
  db: Db,
  paypal: PayoutPayPal,
  input: { minimumCents?: number; now?: Date } = {},
): Promise<DailyPayoutRun> {
  const minimumCents = validMinimum(input.minimumCents);
  const now = input.now ?? new Date();
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
  const clearing: ClearingHold[] = [];
  for (const { userId } of candidates) {
    if (!userId) continue;
    const receiverEmail = await getPayoutEmail(db, userId);
    if (!receiverEmail) {
      skippedNoEmail.push(userId);
      continue;
    }
    const { payout, split } = await db.transaction((tx) =>
      reservePayout(tx, { publisherUserId: userId, receiverEmail, batchKey, minimumCents, now }),
    );
    if (payout) created.push(payout);
    if (split.clearingMicros > 0) {
      clearing.push({
        publisherUserId: userId,
        payoutId: payout?.id ?? null,
        clearingMicros: split.clearingMicros,
        availableMicros: split.availableMicros,
        nextReleaseAt: split.nextReleaseAt,
      });
    }
  }
  if (created.length === 0) return { batchKey: null, payouts: [], skippedNoEmail, clearing };

  await submitPayoutBatch(db, paypal, batchKey);
  const rows = await db.select().from(payouts).where(eq(payouts.batchKey, batchKey));
  return { batchKey, payouts: rows, skippedNoEmail, clearing };
}

/**
 * Locks the earnings account, takes the whole cents of what is available (the balance minus what
 * is still clearing in the dispute window), posts the payout and inserts the row. The payout is
 * null when that amount is below the minimum; the split says why.
 */
async function reservePayout(
  tx: Tx,
  input: {
    publisherUserId: string;
    receiverEmail: string;
    batchKey: string;
    minimumCents: number;
    now: Date;
  },
): Promise<{ payout: Payout | null; split: EarningsSplit }> {
  const earningsId = Accounts.earnings(input.publisherUserId);
  const [account] = await tx
    .select({ balance: ledgerAccounts.balanceMicros })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.id, earningsId))
    .for("update");
  // After the lock: a refund (which also takes this lock) cannot change the balance meanwhile.
  const split = await splitEarnings(tx, input.publisherUserId, account?.balance ?? 0, input.now);
  const amountCents = Math.floor(split.availableMicros / MICROS_PER_CENT);
  if (amountCents < input.minimumCents || amountCents <= 0) return { payout: null, split };

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
  return { payout: row, split };
}

/**
 * Sends every item of a batch to PayPal (also the retry after an indeterminate failure: same
 * `sender_batch_id`, same `PayPal-Request-Id`, same items). Does nothing while another caller is
 * sending the same batch.
 */
async function submitPayoutBatch(db: Db, paypal: PayoutPayPal, batchKey: string): Promise<void> {
  const now = new Date();
  // Claim the batch: a single UPDATE, so of two concurrent callers only one gets the rows.
  const claimed = await db
    .update(payouts)
    .set({
      submitAttempts: sql`${payouts.submitAttempts} + 1`,
      submitLockedUntil: new Date(now.getTime() + SUBMIT_LOCK_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(payouts.batchKey, batchKey),
        eq(payouts.status, "pending"),
        isNull(payouts.paypalBatchId),
        or(isNull(payouts.submitLockedUntil), lt(payouts.submitLockedUntil, now)),
      ),
    )
    .returning({ id: payouts.id, submitAttempts: payouts.submitAttempts });
  if (claimed.length === 0) return;
  const isRetry = claimed.some((row) => row.submitAttempts > 1);

  const rows = await db
    .select()
    .from(payouts)
    .where(eq(payouts.batchKey, batchKey))
    .orderBy(asc(payouts.id));
  const release = { submitLockedUntil: null, updatedAt: new Date() };
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
      .set({ ...release, paypalBatchId: result.batchId, error: null })
      .where(eq(payouts.batchKey, batchKey));
    await applyBatchStatus(db, batchKey, result.batchStatus);
  } catch (err) {
    const existing = duplicateBatch(err);
    if (existing) {
      // PayPal already has this batch (an earlier attempt went through): adopt it. Sync or the
      // webhooks then bring the item statuses.
      await db
        .update(payouts)
        .set({
          ...release,
          ...(existing.batchId
            ? { paypalBatchId: existing.batchId, error: null }
            : {
                error:
                  "Needs review: PayPal already has this batch but did not say which one. The money stays in clearing.",
              }),
        })
        .where(eq(payouts.batchKey, batchKey));
      return;
    }
    if (isDefinitivePayPalFailure(err) && !isRetry) {
      for (const row of rows) await reversePayout(db, row.id, "failed", errorMessage(err));
      return;
    }
    // Indeterminate, or a refused retry: PayPal may hold an earlier attempt, so never give the
    // money back here. Stay pending; syncPendingPayouts retries the same batch.
    const error = isDefinitivePayPalFailure(err)
      ? `Needs review: PayPal refused a retry of this batch (${errorMessage(err)})`
      : `Retrying: ${errorMessage(err)}`;
    await db
      .update(payouts)
      .set({ ...release, error: error.slice(0, 500) })
      .where(and(eq(payouts.batchKey, batchKey), eq(payouts.status, "pending")));
  }
}

const PAYOUT_BATCH_URL = /\/v1\/payments\/payouts\/([A-Za-z0-9]+)(?:[/?#]|$)/;

/**
 * PayPal's answer to a reused `sender_batch_id`: 400 USER_BUSINESS_ERROR with a detail on field
 * SENDER_BATCH_ID ("Batch with given sender_batch_id already exists") linking the existing batch.
 * Returns that batch's `payout_batch_id` (null when PayPal sent no link), or null for other errors.
 */
export function duplicateBatch(err: unknown): { batchId: string | null } | null {
  if (!(err instanceof PayPalApiError) || err.status !== 400) return null;
  const detail = err.details.find(
    (d) =>
      (typeof d.field === "string" && d.field.toUpperCase() === "SENDER_BATCH_ID") ||
      (typeof d.issue === "string" && /sender_batch_id already exists/i.test(d.issue)),
  );
  if (!detail) return null;
  const hrefs: string[] = [];
  const collect = (links: unknown) => {
    if (!Array.isArray(links)) return;
    for (const link of links) {
      const href = (link as { href?: unknown } | null)?.href;
      if (typeof href === "string") hrefs.push(href);
    }
  };
  collect(detail.link);
  collect(detail.links);
  collect((err.body as { links?: unknown } | null)?.links);
  for (const href of hrefs) {
    const match = PAYOUT_BATCH_URL.exec(href);
    if (match?.[1]) return { batchId: match[1] };
  }
  return { batchId: null };
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
      if (update.status === "success" && !row.redebitTransactionId) {
        return redebitPaidPayout(tx, row, ids);
      }
      // Money already returned to earnings; nothing else moves it automatically.
      const [updated] = await tx
        .update(payouts)
        .set({ ...ids, updatedAt: new Date() })
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

/**
 * PayPal paid an item we had already reversed (the money went back to earnings). Takes the
 * amount out of earnings again, once (kind `payout`, key `redebit:<id>`), so the ledger matches
 * what PayPal paid. If the publisher has already withdrawn those earnings, nothing can be taken
 * without going negative, so the row is flagged for review instead.
 */
async function redebitPaidPayout(
  tx: Tx,
  row: Payout,
  ids: Partial<Pick<Payout, "paypalBatchId" | "paypalItemId" | "paypalTransactionId">>,
): Promise<Payout> {
  const earningsId = Accounts.earnings(row.publisherUserId);
  const [account] = await tx
    .select({ balance: ledgerAccounts.balanceMicros })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.id, earningsId))
    .for("update");
  const amountMicros = centsToMicros(row.amountCents);
  if ((account?.balance ?? 0) < amountMicros) {
    const [flagged] = await tx
      .update(payouts)
      .set({
        ...ids,
        error:
          "Needs review: PayPal paid this payout after it was reversed, and the earnings were already withdrawn",
        updatedAt: new Date(),
      })
      .where(eq(payouts.id, row.id))
      .returning();
    return flagged ?? row;
  }
  const posted = await postTransaction(tx, {
    kind: "payout",
    idempotencyKey: `redebit:${row.id}`,
    memo: `Payout ${row.id} paid by PayPal after its reversal`,
    entries: [
      { accountId: earningsId, amountMicros: -amountMicros },
      { accountId: Accounts.paypalClearing, amountMicros },
    ],
  });
  const [updated] = await tx
    .update(payouts)
    .set({
      ...ids,
      status: "success",
      redebitTransactionId: posted.transactionId,
      error: "PayPal paid this payout after it was reversed; the earnings were taken again",
      updatedAt: new Date(),
    })
    .where(eq(payouts.id, row.id))
    .returning();
  return updated ?? row;
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
