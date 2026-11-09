/**
 * The dispute-window hold on publisher earnings, shared by payouts (services/payouts.ts) and
 * publisher refunds (postgres-ledger.ts). A settled fare is *held* (its publisher share is
 * clearing) while an agent may still dispute it, plus a safety margin, and while a dispute on it
 * is undecided. Kept apart from payouts.ts so the ledger can use it without an import cycle.
 */
import { DISPUTE_POLICY } from "@botfare/contracts/fare";
import { and, eq, exists, gte, inArray, not, or, type SQL, sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { disputes, receipts } from "../schema";

const HOUR_MS = 3_600_000;

/** Dispute statuses that hold a fare's earnings back from payouts until they are decided. */
export const PAYOUT_HOLD_DISPUTE_STATUSES = ["open", "pending_publisher"] as const;

/**
 * Extra time a fare stays clearing after its dispute window. Fare Court captures `now` before
 * its transaction and its dispute row is invisible until commit, so a payout running a moment
 * later (or on a service whose clock runs ahead) could otherwise see the fare as matured while a
 * dispute on it is being filed.
 */
export const PAYOUT_HOLD_MARGIN_MS = 10 * 60_000;

/** How long after settling a fare stops clearing (unless a dispute holds it): window + margin. */
export const PAYOUT_HOLD_MS = DISPUTE_POLICY.windowHours * HOUR_MS + PAYOUT_HOLD_MARGIN_MS;

export interface EarningsSplit {
  /** The publisher's whole earnings balance (ledger). */
  balanceMicros: number;
  /**
   * The publisher's share (amount minus BotFare's fee) of settled, unrefunded fares that an agent
   * may still dispute (settled less than DISPUTE_POLICY.windowHours plus PAYOUT_HOLD_MARGIN_MS
   * ago) or whose dispute is undecided (`open` or `pending_publisher`, any age).
   */
  clearingMicros: number;
  /** What a payout (or a refund of a fare that is not held) may take now: max(0, balance - clearing). */
  availableMicros: number;
  /** When the oldest in-window fare without an undecided dispute stops clearing; null if none. */
  nextReleaseAt: Date | null;
}

/** The SQL conditions on `receipts` that make a fare held at `now` (status not included). */
function holdConditions(db: DbOrTx, now: Date): { inWindow: SQL; undecidedDispute: SQL } {
  // Fare Court accepts a dispute while now - createdAt <= window, so a fare exactly at the
  // boundary (plus the margin) still counts as clearing.
  const inWindow = gte(receipts.createdAt, new Date(now.getTime() - PAYOUT_HOLD_MS));
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
  return { inWindow, undecidedDispute };
}

/**
 * Splits a publisher's earnings `balanceMicros` into clearing and available at `now`. Callers that
 * move money lock the earnings account first and pass its locked balance.
 */
export async function splitEarnings(
  db: DbOrTx,
  publisherUserId: string,
  balanceMicros: number,
  now: Date,
): Promise<EarningsSplit> {
  const { inWindow, undecidedDispute } = holdConditions(db, now);
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
    nextReleaseAt: oldest ? new Date(oldest.getTime() + PAYOUT_HOLD_MS) : null,
  };
}

/** Whether the receipt is itself held at `now` (in its window plus margin, or undecided dispute). */
export async function isReceiptHeld(db: DbOrTx, receiptId: string, now: Date): Promise<boolean> {
  const { inWindow, undecidedDispute } = holdConditions(db, now);
  const [row] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), or(inWindow, undecidedDispute)));
  return row !== undefined;
}
