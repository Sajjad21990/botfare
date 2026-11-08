import type { Money } from "@x402/core/types";

const MICROS_PER_CENT = 10_000;

/** Parses "$0.03", "0.03" or 0.03 into integer cents. Rejects sub-cent and non-positive prices. */
export function moneyToCents(money: Money): number {
  const text = typeof money === "number" ? String(money) : money.trim();
  const match = /^\$?(\d+)(?:\.(\d{1,2}))?(?:\s*USD)?$/.exec(text);
  if (!match) {
    throw new Error(`Unsupported USD price "${text}": use whole cents, e.g. "$0.03"`);
  }
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`Price must be at least one cent, got "${text}"`);
  }
  return cents;
}

/** Parses an x402 atomic `amount` (integer cents as a string). */
export function parseAtomicCents(amount: string): number {
  if (!/^[1-9]\d*$/.test(amount)) {
    throw new Error(`Invalid USD atomic amount "${amount}"`);
  }
  const cents = Number(amount);
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount too large: "${amount}"`);
  return cents;
}

/** The ledger keeps micro-dollars (1 USD = 1,000,000) so fee splits stay exact. */
export function centsToMicros(cents: number): number {
  return cents * MICROS_PER_CENT;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
