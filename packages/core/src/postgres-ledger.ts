import { type DetectionSignal, detectionSignalSchema, IdPrefix, newId } from "@botfare/contracts";
import {
  type AgentKeyRecord,
  type ChargeRequest,
  type ChargeResult,
  centsToMicros,
  ErrorReason,
  type LedgerDecision,
  PLATFORM_FEE_BPS,
  type PrepaidLedgerPort,
} from "@botfare/x402-paypal";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { Accounts, PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION, pgError } from "./accounts";
import type { Db, DbOrTx } from "./db";
import { postTransaction } from "./ledger";
import {
  type AgentKey,
  agentKeys,
  ledgerAccounts,
  type Receipt,
  receipts,
  type Site,
  sites,
} from "./schema";

/** A refusal from the ledger port (not exported by the plug-in by name). */
type LedgerRefusal = Exclude<LedgerDecision, { ok: true }>;

/** BotFare's 5% of a paid request, rounded down to whole micros. */
export function platformFeeMicros(amountMicros: number): number {
  return Math.floor((amountMicros * PLATFORM_FEE_BPS) / 10_000);
}

type Evaluation = { ok: true; key: AgentKey; site: Site } | LedgerRefusal;

/**
 * A charge request as the facilitator may pass it: the plug-in's ChargeRequest plus the payment
 * requirements' `extra`, where the publisher middleware puts `botfareSignal` (why it asked for
 * payment). Older facilitators leave `extra` out; the receipt then records no signal.
 */
export type ChargeRequestWithExtra = ChargeRequest & { extra?: Record<string, unknown> | null };

/** The detection signal in payment requirements' `extra`, or null when absent or unknown. */
export function detectionSignalFromExtra(extra: unknown): DetectionSignal | null {
  if (!extra || typeof extra !== "object") return null;
  const parsed = detectionSignalSchema.safeParse((extra as Record<string, unknown>).botfareSignal);
  return parsed.success ? parsed.data : null;
}

/**
 * The x402 ledger port on Postgres. `check` only reads; `charge` re-runs every check and moves
 * the money in one database transaction, holding the agent key row and then the wallet row
 * `FOR UPDATE`, so concurrent charges cannot both pass the balance or daily-cap check. The
 * receipt ID is the x402 `transaction`. Nonces are single-use per key, forever.
 */
export class PostgresPrepaidLedger implements PrepaidLedgerPort {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, options: { now?: () => Date } = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  async getAgentKey(keyId: string): Promise<AgentKeyRecord | null> {
    const [key] = await this.db
      .select({ keyId: agentKeys.id, publicJwk: agentKeys.publicJwk, status: agentKeys.status })
      .from(agentKeys)
      .where(eq(agentKeys.id, keyId));
    return key ?? null;
  }

  async check(request: ChargeRequest): Promise<LedgerDecision> {
    const evaluation = await this.evaluate(this.db, request, false);
    return evaluation.ok ? { ok: true } : evaluation;
  }

  async charge(request: ChargeRequestWithExtra): Promise<ChargeResult> {
    const amountMicros = centsToMicros(request.amountCents);
    const feeMicros = platformFeeMicros(amountMicros);
    try {
      return await this.db.transaction(async (tx): Promise<ChargeResult> => {
        const evaluation = await this.evaluate(tx, request, true);
        if (!evaluation.ok) return evaluation;
        const { key, site } = evaluation;

        const receiptId = newId(IdPrefix.receipt);
        const posted = await postTransaction(tx, {
          kind: "charge",
          idempotencyKey: `charge:${key.id}:${request.nonce}`,
          memo: `Receipt ${receiptId}`,
          entries: [
            { accountId: Accounts.wallet(key.ownerUserId), amountMicros: -amountMicros },
            {
              accountId: Accounts.earnings(site.ownerUserId),
              amountMicros: amountMicros - feeMicros,
            },
            { accountId: Accounts.platformFees, amountMicros: feeMicros },
          ],
        });
        if (!posted.created) return this.nonceUsed(tx, request);

        await tx.insert(receipts).values({
          id: receiptId,
          agentKeyId: key.id,
          ownerUserId: key.ownerUserId,
          siteId: site.id,
          publisherUserId: site.ownerUserId,
          resourceUrl: request.resourceUrl ?? null,
          amountCents: request.amountCents,
          amountMicros,
          feeMicros,
          nonce: request.nonce,
          status: "settled",
          transactionId: posted.transactionId,
          detectionSignal: detectionSignalFromExtra(request.extra),
          createdAt: this.now(),
        });
        return { ok: true, transaction: receiptId };
      });
    } catch (err) {
      // Backstops for races the row locks should already prevent.
      const pg = pgError(err);
      if (pg?.code === PG_UNIQUE_VIOLATION) return this.nonceUsed(this.db, request);
      if (pg?.code === PG_CHECK_VIOLATION) {
        return {
          ok: false,
          reason: ErrorReason.InsufficientFunds,
          message: "Wallet balance too low",
        };
      }
      throw err;
    }
  }

  /** Every rule in the order the in-memory ledger applies them. `lock` takes the row locks. */
  private async evaluate(
    executor: DbOrTx,
    request: ChargeRequest,
    lock: boolean,
  ): Promise<Evaluation> {
    const keyQuery = executor.select().from(agentKeys).where(eq(agentKeys.id, request.keyId));
    const [key] = lock ? await keyQuery.for("update") : await keyQuery;
    if (!key) return { ok: false, reason: ErrorReason.UnknownKey, message: "Unknown agent key" };
    if (key.status !== "active") {
      return { ok: false, reason: ErrorReason.KeyRevoked, message: "Agent key is revoked" };
    }

    const used = await this.nonceUsed(executor, request);
    if (used.originalTransaction) return used;

    const [site] = await executor.select().from(sites).where(eq(sites.id, request.payTo));
    if (!site) {
      return { ok: false, reason: ErrorReason.SiteNotAllowed, message: "Unknown site" };
    }
    if (key.allowedSiteIds && !key.allowedSiteIds.includes(site.id)) {
      return {
        ok: false,
        reason: ErrorReason.SiteNotAllowed,
        message: "Key may not pay this site",
      };
    }
    if (key.perRequestMaxCents !== null && request.amountCents > key.perRequestMaxCents) {
      return { ok: false, reason: ErrorReason.OverPerRequestMax, message: "Over per-request max" };
    }
    if (key.dailyCapCents !== null) {
      const spent = await this.spentTodayCents(executor, key.id);
      if (spent + request.amountCents > key.dailyCapCents) {
        return { ok: false, reason: ErrorReason.OverDailyCap, message: "Over daily cap" };
      }
    }

    const walletQuery = executor
      .select({ balance: ledgerAccounts.balanceMicros })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.id, Accounts.wallet(key.ownerUserId)));
    const [wallet] = lock ? await walletQuery.for("update") : await walletQuery;
    if ((wallet?.balance ?? 0) < centsToMicros(request.amountCents)) {
      return {
        ok: false,
        reason: ErrorReason.InsufficientFunds,
        message: "Wallet balance too low",
      };
    }
    return { ok: true, key, site };
  }

  /** Settled spend for the key in the current UTC day, in cents. Refunded receipts don't count. */
  private async spentTodayCents(executor: DbOrTx, keyId: string): Promise<number> {
    const now = this.now();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const [row] = await executor
      .select({ total: sql<string>`coalesce(sum(${receipts.amountCents}), 0)` })
      .from(receipts)
      .where(
        and(
          eq(receipts.agentKeyId, keyId),
          eq(receipts.status, "settled"),
          gte(receipts.createdAt, dayStart),
          lt(receipts.createdAt, dayEnd),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /** A refusal naming the receipt this nonce was charged under, or one without it if unused. */
  private async nonceUsed(executor: DbOrTx, request: ChargeRequest): Promise<LedgerRefusal> {
    const [original] = await executor
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.agentKeyId, request.keyId), eq(receipts.nonce, request.nonce)));
    return {
      ok: false,
      reason: ErrorReason.NonceUsed,
      message: "Payment already used",
      originalTransaction: original?.id,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Refunds (a publisher action, not part of the x402 handshake)

export type RefundResult =
  | { ok: true; receipt: Receipt; refundTransactionId: string; alreadyRefunded: boolean }
  | { ok: false; reason: "not_found" | "insufficient_earnings"; message: string };

/**
 * Reverses a settled receipt of `siteId` exactly once: the wallet gets the full amount back,
 * taken from the publisher's earnings and BotFare's fee. A second call returns the first refund.
 * Fails with `insufficient_earnings` if the publisher was already paid out.
 */
export async function refundReceipt(
  db: Db,
  input: { receiptId: string; siteId: string; memo?: string },
): Promise<RefundResult> {
  try {
    return await db.transaction(async (tx): Promise<RefundResult> => {
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, input.receiptId), eq(receipts.siteId, input.siteId)))
        .for("update");
      if (!receipt) return { ok: false, reason: "not_found", message: "No such receipt" };
      if (receipt.status === "refunded" && receipt.refundTransactionId) {
        return {
          ok: true,
          receipt,
          refundTransactionId: receipt.refundTransactionId,
          alreadyRefunded: true,
        };
      }

      // Same lock order as charge (wallet before earnings and fees) so the two cannot deadlock.
      const wallet = Accounts.wallet(receipt.ownerUserId);
      await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.id, wallet))
        .for("update");
      const posted = await postTransaction(tx, {
        kind: "refund",
        idempotencyKey: `refund:${receipt.id}`,
        memo: input.memo ?? `Refund of ${receipt.id}`,
        entries: [
          { accountId: wallet, amountMicros: receipt.amountMicros },
          {
            accountId: Accounts.earnings(receipt.publisherUserId),
            amountMicros: -(receipt.amountMicros - receipt.feeMicros),
          },
          { accountId: Accounts.platformFees, amountMicros: -receipt.feeMicros },
        ],
      });
      const [updated] = await tx
        .update(receipts)
        .set({ status: "refunded", refundTransactionId: posted.transactionId })
        .where(eq(receipts.id, receipt.id))
        .returning();
      if (!updated) throw new Error(`Receipt ${receipt.id} vanished during refund`);
      return {
        ok: true,
        receipt: updated,
        refundTransactionId: posted.transactionId,
        alreadyRefunded: false,
      };
    });
  } catch (err) {
    if (pgError(err)?.code === PG_CHECK_VIOLATION) {
      return {
        ok: false,
        reason: "insufficient_earnings",
        message: "Publisher earnings are too low to refund this receipt",
      };
    }
    throw err;
  }
}
