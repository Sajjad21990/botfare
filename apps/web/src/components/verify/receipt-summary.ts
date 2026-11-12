/**
 * What /verify shows at a glance, derived only from the statements the browser just checked
 * (browser-safe, no React). A fact counts as proven only when its statement's signature verified
 * and the statement is about the receipt asked for; anything else is shown as not proven.
 */
import { DISPUTE_POLICY } from "@botfare/contracts/fare";
import type {
  DeliveryStatement,
  PaymentStatement,
  RefundStatement,
  StatementKind,
} from "@botfare/contracts/receipts";
import {
  deliverySummary,
  formatFareMicros,
  formatShareMicros,
  KIND_LABELS,
  pageLabel,
  percentOf,
} from "./statement-copy";
import type { CheckedStatement } from "./verify-lib";

export interface ReceiptOutcome {
  /** The receipt asked about (a lookup, or the one every pasted statement names). */
  receiptId: string | null;
  source: "lookup" | "pasted";
  statements: CheckedStatement[];
  /** Lookup only: statements BotFare has not issued for this receipt. */
  missing: StatementKind[];
  keyCount: number;
}

/** pass ✓, fail ✗, none – (nothing to check), refunded ↩ (a verified refund). */
export type CheckState = "pass" | "fail" | "none" | "refunded";

export interface CheckItem {
  id: "signed" | "payment" | "delivery" | "refund";
  label: string;
  state: CheckState;
  detail: string;
}

export interface TimelineItem {
  id: "paid" | "delivered" | "refunded" | "window";
  title: string;
  detail: string;
  at: string;
  /** Still ahead (the dispute window has not closed yet). */
  upcoming: boolean;
}

export interface Failure {
  /** The statement's JWS, as a stable key. */
  token: string;
  kind: StatementKind | null;
  title: string;
  reason: string;
}

export interface MoneySplit {
  amount: string;
  publisher: string;
  publisherPercent: string;
  fee: string;
  feePercent: string;
  /** Publisher share in percent of the fare, for the bar width (0-100). */
  publisherShare: number;
}

export interface ReceiptSummary {
  receiptId: string | null;
  total: number;
  valid: number;
  /** Every statement verified and is about this receipt. Only then is anything shown in green. */
  trusted: boolean;
  /** Statements that verified and are about this receipt (first of each kind). */
  payment: PaymentStatement | null;
  delivery: DeliveryStatement | null;
  refund: RefundStatement | null;
  /** The payment's claims as written, verified or not: the ticket shows them either way. */
  paymentAsWritten: PaymentStatement | null;
  failures: Failure[];
  checks: CheckItem[];
  timeline: TimelineItem[];
  split: MoneySplit | null;
}

/** The statement verified and is about the receipt asked for. */
export function isProven(checked: CheckedStatement, receiptId: string | null): boolean {
  return checked.result.ok && (!receiptId || checked.result.statement.sub === receiptId);
}

function kindOf(checked: CheckedStatement): StatementKind | null {
  return checked.result.ok
    ? checked.result.statement.kind
    : (checked.decoded?.kind ?? checked.slot ?? null);
}

function failureOf(checked: CheckedStatement, receiptId: string | null): Failure {
  const kind = kindOf(checked);
  const title = kind ? `${KIND_LABELS[kind]} statement` : "Statement";
  const { result } = checked;
  if (result.ok) {
    return {
      token: checked.token,
      kind,
      title,
      reason: `The signature is valid, but it is about ${result.statement.sub}, not ${receiptId}.`,
    };
  }
  const hint =
    result.error === "unknown_key"
      ? " BotFare never published this key, or another server signed it."
      : result.error === "bad_signature"
        ? " Someone changed it after BotFare signed it, or BotFare never signed it."
        : "";
  return { token: checked.token, kind, title, reason: `${result.message}.${hint}` };
}

export function summarizeReceipt(outcome: ReceiptOutcome, now: Date = new Date()): ReceiptSummary {
  const { receiptId, statements, source } = outcome;
  const total = statements.length;
  const proven = statements.filter((c) => isProven(c, receiptId));
  const valid = proven.length;
  const trusted = total > 0 && valid === total;

  const provenOf = <K extends StatementKind>(kind: K) => {
    for (const checked of proven) {
      if (checked.result.ok && checked.result.statement.kind === kind) {
        return checked.result.statement as Extract<
          PaymentStatement | DeliveryStatement | RefundStatement,
          { kind: K }
        >;
      }
    }
    return null;
  };
  const payment = provenOf("payment");
  const delivery = provenOf("delivery");
  const refund = provenOf("refund");

  const failed = (kind: StatementKind) =>
    statements.some((c) => kindOf(c) === kind && !isProven(c, receiptId));

  let paymentAsWritten: PaymentStatement | null = payment;
  if (!paymentAsWritten) {
    for (const checked of statements) {
      if (checked.decoded?.kind === "payment") {
        paymentAsWritten = checked.decoded;
        break;
      }
    }
  }

  const absent = (lookupDetail: string) =>
    source === "pasted" ? "Not in what you pasted" : lookupDetail;
  const notValid = "Signature not valid";

  const checks: CheckItem[] = [
    {
      id: "signed",
      label: "Signed by BotFare",
      state: total === 0 ? "none" : trusted ? "pass" : "fail",
      detail:
        total === 0
          ? "No signed statements"
          : trusted
            ? total === 1
              ? "The signature is valid"
              : total === 2
                ? "Both signatures are valid"
                : `All ${total} signatures are valid`
            : `${total - valid} of ${total} not valid`,
    },
    payment
      ? payment.payment.resource
        ? {
            id: "payment",
            label: "Payment for this page",
            state: "pass",
            detail: `${formatFareMicros(payment.payment.amountMicros)} for ${pageLabel(payment.payment.resource)}`,
          }
        : {
            id: "payment",
            label: "Payment for this page",
            state: "none",
            detail: "The statement names no page",
          }
      : {
          id: "payment",
          label: "Payment for this page",
          state: failed("payment") ? "fail" : "none",
          detail: failed("payment") ? notValid : absent("No payment statement"),
        },
    delivery
      ? {
          id: "delivery",
          label: "Delivery recorded",
          state: "pass",
          detail: deliverySummary(delivery.delivery),
        }
      : {
          id: "delivery",
          label: "Delivery recorded",
          state: failed("delivery") ? "fail" : "none",
          detail: failed("delivery") ? notValid : absent("No delivery statement for this receipt"),
        },
    refund
      ? {
          id: "refund",
          label: "Refund",
          state: "refunded",
          detail: `Refunded ${formatFareMicros(refund.refund.refundedMicros)} ${
            refund.refund.via === "dispute" ? "through Fare Court" : "by the publisher"
          }`,
        }
      : {
          id: "refund",
          label: "Refund",
          state: failed("refund") ? "fail" : "none",
          detail: failed("refund") ? notValid : absent("No refund"),
        },
  ];

  const timeline: TimelineItem[] = [];
  if (payment) {
    timeline.push({
      id: "paid",
      title: `Paid ${formatFareMicros(payment.payment.amountMicros)}`,
      detail: "BotFare settled the payment after the site served the page.",
      at: payment.payment.settledAt,
      upcoming: false,
    });
  }
  if (delivery) {
    timeline.push({
      id: "delivered",
      title: "Delivered",
      detail: deliverySummary(delivery.delivery),
      at: delivery.delivery.attestedAt,
      upcoming: false,
    });
  }
  if (refund) {
    timeline.push({
      id: "refunded",
      title: `Refunded ${formatFareMicros(refund.refund.refundedMicros)}`,
      detail: refund.refund.via === "dispute" ? "Through Fare Court." : "By the publisher.",
      at: refund.refund.refundedAt,
      upcoming: false,
    });
  }
  const closes = payment ? disputeWindowEnd(payment.payment.settledAt) : null;
  if (trusted && payment && !refund && closes) {
    const upcoming = closes.getTime() > now.getTime();
    timeline.push({
      id: "window",
      title: upcoming ? "Dispute window ends" : "Dispute window ended",
      detail: `An agent can dispute a fare for ${DISPUTE_POLICY.windowHours} hours after paying.`,
      at: closes.toISOString(),
      upcoming,
    });
  }
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const split: MoneySplit | null = payment
    ? {
        amount: formatFareMicros(payment.payment.amountMicros),
        publisher: formatShareMicros(payment.payment.publisherMicros),
        publisherPercent: percentOf(payment.payment.publisherMicros, payment.payment.amountMicros),
        fee: formatShareMicros(payment.payment.feeMicros),
        feePercent: percentOf(payment.payment.feeMicros, payment.payment.amountMicros),
        publisherShare:
          payment.payment.amountMicros > 0
            ? Math.min(
                100,
                Math.max(0, (payment.payment.publisherMicros / payment.payment.amountMicros) * 100),
              )
            : 0,
      }
    : null;

  return {
    receiptId,
    total,
    valid,
    trusted,
    payment,
    delivery,
    refund,
    paymentAsWritten,
    failures: statements.filter((c) => !isProven(c, receiptId)).map((c) => failureOf(c, receiptId)),
    checks,
    timeline,
    split,
  };
}

/** When the purchase stops being open to disputes (DISPUTE_POLICY.windowHours after it settled). */
export function disputeWindowEnd(settledAt: string): Date | null {
  const settled = Date.parse(settledAt);
  if (Number.isNaN(settled)) return null;
  return new Date(settled + DISPUTE_POLICY.windowHours * 3_600_000);
}

/** One sentence on whether the signatures hold, for the verdict line and screen readers. */
export function verdictText(summary: ReceiptSummary): string {
  const { total, valid, trusted } = summary;
  if (total === 0) return "This receipt has no signed statements.";
  if (trusted) {
    if (total === 1) return "The signature is valid.";
    return total === 2 ? "Both signatures are valid." : `All ${total} signatures are valid.`;
  }
  if (total === 1) return "The signature is not valid.";
  const bad = total - valid;
  return `${bad} of ${total} signatures ${bad === 1 ? "is" : "are"} not valid.`;
}
