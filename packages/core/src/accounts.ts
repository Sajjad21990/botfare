import type { LedgerAccountKind } from "./schema";

/** Ledger account IDs. Wallets belong to agent owners; earnings belong to site owners. */
export const Accounts = {
  wallet: (userId: string) => `wallet:${userId}`,
  earnings: (userId: string) => `earnings:${userId}`,
  /** BotFare's 5% take, minus the PayPal fees it absorbs on top-ups. */
  platformFees: "platform:fees",
  /** Money held at PayPal on BotFare's behalf: top-ups in, payouts out. */
  paypalClearing: "paypal:clearing",
  /** Fees PayPal kept on captures. */
  paypalFees: "paypal:fees",
} as const;

/** Kind and owner of an account, derived from its ID. */
export function describeAccount(accountId: string): {
  kind: LedgerAccountKind;
  ownerUserId: string | null;
} {
  const [prefix, rest] = splitOnce(accountId);
  if (prefix === "wallet" && rest) return { kind: "wallet", ownerUserId: rest };
  if (prefix === "earnings" && rest) return { kind: "earnings", ownerUserId: rest };
  if (accountId === Accounts.platformFees) return { kind: "platform", ownerUserId: null };
  if (prefix === "paypal" && rest) return { kind: "external", ownerUserId: null };
  throw new Error(`Unknown ledger account ${accountId}`);
}

function splitOnce(id: string): [string, string] {
  const colon = id.indexOf(":");
  return colon < 0 ? [id, ""] : [id.slice(0, colon), id.slice(colon + 1)];
}

/** Postgres error fields, unwrapped from drizzle's DrizzleQueryError if needed. */
export function pgError(err: unknown): { code?: string; constraint_name?: string } | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") {
      return current as { code?: string; constraint_name?: string };
    }
    current = candidate.cause;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_CHECK_VIOLATION = "23514";
