/** Formatting for the research agent page (browser-safe). */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 3 → "3¢", 25 → "25¢", 100 → "$1.00". */
export function formatFare(cents: number): string {
  return cents < 100 ? `${cents}¢` : usd.format(cents / 100);
}

/** 25 → "$0.25". */
export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}

/** "http://localhost:4000/recipes/crispy-oven-potatoes" → "/recipes/crispy-oven-potatoes". */
export function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** "http://localhost:4000/recipes/x" → "localhost:4000". */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Integer-cents string from an x402 `amount` ("3" → 3), or null. */
export function centsFromAmount(amount: unknown): number | null {
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
  const cents = Number(amount);
  return Number.isSafeInteger(cents) ? cents : null;
}
