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

const usdExact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

/**
 * Money as people read it: "3¢" under a dollar, "$2.04" from a dollar up, "$0.00" for nothing.
 * Rounds to the cent (a sub-cent amount above zero reads "<1¢"); put `formatMoneyExact` in a
 * `title` for the exact figure.
 */
export function formatMoney(micros: number): string {
  if (micros === 0) return usd.format(0);
  const sign = micros < 0 ? "-" : "";
  const cents = Math.round(Math.abs(micros) / MICROS_PER_CENT);
  if (cents >= 100) return `${sign}${usd.format(cents / 100)}`;
  return cents === 0 ? `${sign}<1¢` : `${sign}${cents}¢`;
}

/** The exact amount for a tooltip: "$1.406", "$0.0285", "$2.00". */
export function formatMoneyExact(micros: number): string {
  return usdExact.format(micros / 1_000_000);
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
