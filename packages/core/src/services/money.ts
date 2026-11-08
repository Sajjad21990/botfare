import { PayPalApiError, PayPalInputError } from "@botfare/paypal";

export type MoneyFlowErrorCode =
  /** The order, payout or record does not exist or belongs to someone else. */
  | "not_found"
  /** Input outside what the flow allows (e.g. a top-up amount other than $5, $10 or $20). */
  | "invalid_amount"
  /** PayPal captured a different amount or currency than the order was created for. */
  | "amount_mismatch"
  /** The payer has not approved the order yet. */
  | "not_approved"
  /** The publisher has no payout email on their profile or sites. */
  | "no_payout_email"
  /** Earnings are below the payout minimum. */
  | "below_minimum";

/** A refusal the route can show the user. Routes map `code` to an HTTP status. */
export class MoneyFlowError extends Error {
  override name = "MoneyFlowError";
  readonly code: MoneyFlowErrorCode;

  constructor(code: MoneyFlowErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 1234 → "12.34" (PayPal's decimal string). */
export function centsToPayPalAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Invalid cents ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "12.34" → 1234; "0.00" → 0. Throws on anything that is not whole cents. */
export function payPalAmountToCents(amount: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Unsupported PayPal amount "${amount}"`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount too large: "${amount}"`);
  return cents;
}

/** True when a PayPal error lists `issue` in its details (e.g. ORDER_ALREADY_CAPTURED). */
export function hasPayPalIssue(err: unknown, issue: string): boolean {
  return (
    err instanceof PayPalApiError &&
    (err.name === issue || err.details.some((detail) => detail.issue === issue))
  );
}

/**
 * True when PayPal definitely did not act on the request: a 4xx other than 408 (timeout) and
 * 429 (rate limit), or input refused before sending. Network errors, 5xx and unexpected
 * response shapes are indeterminate: the request may have gone through.
 */
export function isDefinitivePayPalFailure(err: unknown): boolean {
  if (err instanceof PayPalInputError) return true;
  if (!(err instanceof PayPalApiError)) return false;
  return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

export function errorMessage(err: unknown): string {
  if (err instanceof PayPalApiError) {
    const issue = err.details[0]?.issue;
    return `${err.name}${issue ? ` (${issue})` : ""}: ${err.message}`.slice(0, 500);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
