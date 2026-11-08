/** Money and time formatting for the wallet (browser-safe). */

const MICROS_PER_CENT = 10_000;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** 1234 → "$12.34". */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/** Micro-dollars as USD: cents when whole, 4 decimals for sub-cent amounts (e.g. "$0.0015"). */
export function formatMicros(micros: number): string {
  return micros % MICROS_PER_CENT === 0
    ? usd.format(micros / 1_000_000)
    : usdPrecise.format(micros / 1_000_000);
}

/** A price cap in cents, short: 10 → "10¢", 150 → "$1.50". */
export function formatCap(cents: number): string {
  return cents < 100 ? `${cents}¢` : formatCents(cents);
}

/** "12.34" (dollars typed by the user) → 1234, or null if it is not a positive whole-cent amount. */
export function parseDollarsToCents(text: string): number | null {
  const match = /^\$?\s*(\d{0,7})(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const cents = Number(match[1] || 0) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

/** Fixed, timezone-free rendering used on the server and for the first client render. */
export function formatUtcDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

const localDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const localDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatLocalDateTime(iso: string): string {
  return localDateTime.format(new Date(iso));
}

export function formatLocalDate(iso: string): string {
  return localDate.format(new Date(iso));
}
