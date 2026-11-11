/** Plain-language wording for BotFare's signed statements (browser-safe, no React). */
import type { DetectionSignal } from "@botfare/contracts";
import type { BotFareStatement, StatementKind } from "@botfare/contracts/receipts";
import { SIGNAL_DESCRIPTIONS, signalLabel } from "../publisher/detection-copy";

const MICROS_PER_CENT = 10_000;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** 30000 → "3¢", 1_500_000 → "$1.50", 15000 → "$0.0150"... sub-cent amounts keep 4 decimals. */
export function formatFareMicros(micros: number): string {
  if (micros % MICROS_PER_CENT !== 0) return usdPrecise.format(micros / 1_000_000);
  const cents = micros / MICROS_PER_CENT;
  return cents < 100 ? `${cents}¢` : usd.format(cents / 100);
}

export function formatMoneyMicros(micros: number): string {
  return micros % MICROS_PER_CENT === 0
    ? usd.format(micros / 1_000_000)
    : usdPrecise.format(micros / 1_000_000);
}

/** Percent of a whole, rounded to at most one decimal: (28500, 30000) → "95". */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return "0";
  const value = Math.round((part / whole) * 1000) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** Local date and time in the viewer's time zone. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateTime.format(date);
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export const KIND_LABELS: Record<StatementKind, string> = {
  payment: "Payment",
  delivery: "Delivery",
  refund: "Refund",
};

export const KIND_SUMMARIES: Record<StatementKind, string> = {
  payment: "BotFare signed this when it settled the payment, after the site served the page.",
  delivery: "BotFare signed this when the site reported a hash of the exact bytes it sent.",
  refund: "BotFare signed this when it refunded the fare.",
};

/** Why the request was charged: the detection signal's name and what it means. */
export function signalCopy(signal: DetectionSignal | null): { label: string; detail: string } {
  if (!signal) return { label: "Not recorded", detail: "This receipt has no detection signal." };
  return { label: signalLabel(signal), detail: SIGNAL_DESCRIPTIONS[signal] };
}

/** One line that says what a statement records, in plain words. */
export function headline(statement: BotFareStatement): string {
  switch (statement.kind) {
    case "payment": {
      const p = statement.payment;
      const site = hostOf(p.siteOrigin) ?? p.payTo;
      const path = pathOf(p.resource);
      // A resource on another host than the site's registered origin shows its own host.
      const resourceHost = hostOf(p.resource);
      const where = resourceHost && resourceHost !== site ? `${resourceHost}${path}` : path;
      return `Paid ${formatFareMicros(p.amountMicros)} to ${site}${where ? ` for ${where}` : ""}`;
    }
    case "delivery": {
      const d = statement.delivery;
      return `Delivered ${d.contentLength.toLocaleString("en-US")} bytes of ${d.contentType || "content"} (HTTP ${d.status})`;
    }
    case "refund": {
      const r = statement.refund;
      return `Refunded ${formatFareMicros(r.refundedMicros)} ${
        r.via === "dispute" ? "through Fare Court" : "by the publisher"
      }`;
    }
  }
}

export function statementTime(statement: BotFareStatement): string {
  switch (statement.kind) {
    case "payment":
      return statement.payment.settledAt;
    case "delivery":
      return statement.delivery.attestedAt;
    case "refund":
      return statement.refund.refundedAt;
  }
}
