/**
 * Double-entry ledger in integer micro-dollars. Every posting moves money between accounts and
 * its entries sum to zero; `balance_micros` caches the sum of an account's entries and changes
 * only here, in the same database transaction as the entries. Wallets and earnings never go
 * negative (a CHECK constraint backs this up); platform and external accounts may.
 */
import { IdPrefix, newId } from "@botfare/contracts";
import { centsToMicros } from "@botfare/x402-paypal";
import { eq, sql } from "drizzle-orm";
import { Accounts, describeAccount } from "./accounts";
import type { Db, DbOrTx } from "./db";
import {
  type LedgerTransaction,
  type LedgerTransactionKind,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  type TopUp,
  topups,
} from "./schema";

export interface LedgerEntryInput {
  accountId: string;
  amountMicros: number;
}

export interface PostTransactionInput {
  kind: LedgerTransactionKind;
  /** One money event = one key, e.g. `topup:<captureId>` or `charge:<keyId>:<nonce>`. */
  idempotencyKey: string;
  memo?: string;
  entries: LedgerEntryInput[];
}

export interface PostedTransaction {
  transactionId: string;
  /** false when the idempotency key was already posted; nothing moved this time. */
  created: boolean;
}

/**
 * Posts balanced entries. Idempotent by key: a second call returns the first transaction and
 * moves nothing. Creates missing accounts and updates cached balances in account-ID order so
 * concurrent postings lock rows in the same order. Runs in a transaction (a savepoint if
 * `executor` is already one); throws if a wallet or earnings balance would go negative.
 */
export async function postTransaction(
  executor: DbOrTx,
  input: PostTransactionInput,
): Promise<PostedTransaction> {
  const entries = input.entries.filter((entry) => entry.amountMicros !== 0);
  validateEntries(entries);
  const deltas = new Map<string, number>();
  for (const entry of entries) {
    deltas.set(entry.accountId, (deltas.get(entry.accountId) ?? 0) + entry.amountMicros);
  }
  const accountIds = [...deltas.keys()].sort();
  const accounts = accountIds.map((id) => ({ id, ...describeAccount(id) }));

  return executor.transaction(async (tx) => {
    const id = newId(IdPrefix.transaction);
    const inserted = await tx
      .insert(ledgerTransactions)
      .values({ id, kind: input.kind, idempotencyKey: input.idempotencyKey, memo: input.memo })
      .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
      .returning({ id: ledgerTransactions.id });
    if (inserted.length === 0) {
      const [existing] = await tx
        .select()
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey));
      if (!existing) throw new Error(`Ledger transaction ${input.idempotencyKey} vanished`);
      if (existing.kind !== input.kind) {
        throw new Error(`Idempotency key ${input.idempotencyKey} was used for a ${existing.kind}`);
      }
      return { transactionId: existing.id, created: false };
    }

    await tx.insert(ledgerAccounts).values(accounts).onConflictDoNothing();
    await tx
      .insert(ledgerEntries)
      .values(entries.map((entry) => ({ transactionId: id, ...entry })));
    for (const accountId of accountIds) {
      const delta = deltas.get(accountId) ?? 0;
      if (delta === 0) continue;
      await tx
        .update(ledgerAccounts)
        .set({ balanceMicros: sql`${ledgerAccounts.balanceMicros} + ${delta}::bigint` })
        .where(eq(ledgerAccounts.id, accountId));
    }
    return { transactionId: id, created: true };
  });
}

function validateEntries(entries: LedgerEntryInput[]) {
  if (entries.length < 2) throw new Error("A ledger transaction needs at least two entries");
  let sum = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountMicros)) {
      throw new Error(`Entry for ${entry.accountId} is not an integer number of micros`);
    }
    sum += entry.amountMicros;
  }
  if (sum !== 0) throw new Error(`Unbalanced ledger transaction: entries sum to ${sum}`);
}

// ---------------------------------------------------------------------------------------------
// Money in

export interface CreditTopUpInput {
  ownerUserId: string;
  orderId: string;
  captureId: string;
  grossCents: number;
  /** PayPal's fee on the capture (`seller_receivable_breakdown.paypal_fee`); BotFare absorbs it. */
  feeCents: number;
}

/**
 * Credits a completed PayPal capture to the owner's wallet, once per capture ID. The wallet gets
 * the full gross; the PayPal fee is booked against BotFare's fees.
 */
export async function creditTopUp(
  db: DbOrTx,
  input: CreditTopUpInput,
): Promise<{ topup: TopUp; transactionId: string; created: boolean }> {
  if (!Number.isSafeInteger(input.grossCents) || input.grossCents <= 0) {
    throw new Error("grossCents must be a positive integer");
  }
  if (!Number.isSafeInteger(input.feeCents) || input.feeCents < 0) {
    throw new Error("feeCents must be a non-negative integer");
  }
  const gross = centsToMicros(input.grossCents);
  const fee = centsToMicros(input.feeCents);

  return db.transaction(async (tx) => {
    const posted = await postTransaction(tx, {
      kind: "topup",
      idempotencyKey: `topup:${input.captureId}`,
      memo: `PayPal capture ${input.captureId} (order ${input.orderId})`,
      entries: [
        { accountId: Accounts.wallet(input.ownerUserId), amountMicros: gross },
        { accountId: Accounts.paypalClearing, amountMicros: -gross },
        { accountId: Accounts.platformFees, amountMicros: -fee },
        { accountId: Accounts.paypalFees, amountMicros: fee },
      ],
    });
    if (posted.created) {
      await tx.insert(topups).values({
        id: newId(IdPrefix.topup),
        ownerUserId: input.ownerUserId,
        orderId: input.orderId,
        captureId: input.captureId,
        grossCents: input.grossCents,
        feeCents: input.feeCents,
        status: "completed",
        transactionId: posted.transactionId,
      });
    }
    const [topup] = await tx.select().from(topups).where(eq(topups.captureId, input.captureId));
    if (!topup) throw new Error(`Top-up for capture ${input.captureId} is missing`);
    return { topup, transactionId: posted.transactionId, created: posted.created };
  });
}

/** Free demo money for judges and test agents (kind `seed`), once per idempotency key. */
export async function seedWallet(
  db: DbOrTx,
  input: { ownerUserId: string; cents: number; idempotencyKey: string; memo?: string },
): Promise<PostedTransaction> {
  if (!Number.isSafeInteger(input.cents) || input.cents <= 0) {
    throw new Error("cents must be a positive integer");
  }
  const amount = centsToMicros(input.cents);
  return postTransaction(db, {
    kind: "seed",
    idempotencyKey: `seed:${input.idempotencyKey}`,
    memo: input.memo ?? "Demo balance",
    entries: [
      { accountId: Accounts.wallet(input.ownerUserId), amountMicros: amount },
      { accountId: Accounts.paypalClearing, amountMicros: -amount },
    ],
  });
}

/** The posting made with `idempotencyKey`, or null when nothing was posted with it yet. */
export async function getLedgerTransactionByKey(
  db: DbOrTx,
  idempotencyKey: string,
): Promise<LedgerTransaction | null> {
  const [row] = await db
    .select()
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey));
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------
// Balances and invariants

export async function accountBalanceMicros(db: DbOrTx, accountId: string): Promise<number> {
  const [row] = await db
    .select({ balance: ledgerAccounts.balanceMicros })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.id, accountId));
  return row?.balance ?? 0;
}

export function walletBalanceMicros(db: DbOrTx, userId: string): Promise<number> {
  return accountBalanceMicros(db, Accounts.wallet(userId));
}

export function earningsBalanceMicros(db: DbOrTx, userId: string): Promise<number> {
  return accountBalanceMicros(db, Accounts.earnings(userId));
}

/** Sum of every entry ever posted. Always 0 in a correct ledger. */
export async function ledgerTotalMicros(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMicros}), 0)` })
    .from(ledgerEntries);
  return Number(row?.total ?? 0);
}

export interface LedgerInvariantReport {
  ok: boolean;
  totalMicros: number;
  /** Accounts whose cached balance differs from the sum of their entries. */
  balanceMismatches: { accountId: string; cachedMicros: number; entriesMicros: number }[];
  /** Transactions whose entries do not sum to zero. */
  unbalancedTransactions: string[];
}

/** Checks the zero-sum rule overall and per transaction, and every cached balance. */
export async function checkLedgerInvariants(db: Db): Promise<LedgerInvariantReport> {
  const totalMicros = await ledgerTotalMicros(db);
  const mismatches = await db.execute<{ id: string; cached: string; entries: string }>(sql`
    select a.id, a.balance_micros as cached, coalesce(sum(e.amount_micros), 0) as entries
    from ${ledgerAccounts} a
    left join ${ledgerEntries} e on e.account_id = a.id
    group by a.id, a.balance_micros
    having a.balance_micros <> coalesce(sum(e.amount_micros), 0)
  `);
  const unbalanced = await db.execute<{ transaction_id: string }>(sql`
    select transaction_id from ${ledgerEntries}
    group by transaction_id
    having sum(amount_micros) <> 0
  `);
  const balanceMismatches = [...mismatches].map((row) => ({
    accountId: row.id,
    cachedMicros: Number(row.cached),
    entriesMicros: Number(row.entries),
  }));
  const unbalancedTransactions = [...unbalanced].map((row) => row.transaction_id);
  return {
    ok: totalMicros === 0 && balanceMismatches.length === 0 && unbalancedTransactions.length === 0,
    totalMicros,
    balanceMismatches,
    unbalancedTransactions,
  };
}
