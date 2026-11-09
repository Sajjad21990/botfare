/** Money and time formatting for the publisher dashboard. The ledger counts micro-dollars. */

const MICROS_PER_CENT = 10_000;

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd4 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** $12.34, or $0.0950 (4 decimals) when the amount has a sub-cent part. */
export function formatMicros(micros: number): string {
  return micros % MICROS_PER_CENT === 0 ? usd2.format(micros / 1e6) : usd4.format(micros / 1e6);
}

export function formatCents(cents: number): string {
  return usd2.format(cents / 100);
}

/** 3 → "3¢", 150 → "$1.50". */
export function formatPrice(cents: number): string {
  return cents < 100 ? `${cents}¢` : usd2.format(cents / 100);
}

/** Whole cents a payout would send now (the sub-cent remainder stays as earnings). */
export function withdrawableCents(micros: number): number {
  return Math.max(0, Math.floor(micros / MICROS_PER_CENT));
}

/**
 * When clearing earnings become available, relative to `nowMs`: "in 45 min", "in 3 h 20 min",
 * "any moment now" once the time has passed (the next refresh moves them to available).
 */
export function formatClearsIn(iso: string, nowMs: number): string {
  const ms = new Date(iso).getTime() - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "any moment now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
