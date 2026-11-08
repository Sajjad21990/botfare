import type { DefaultAsset, Network } from "@x402/core/types";

/** x402 scheme name: the payer pre-funds a balance and signs one debit authorization per request. */
export const PREPAID_SCHEME = "prepaid";

/** CAIP-2-style networks for PayPal-settled payments. Only the sandbox is used in this project. */
export const PAYPAL_SANDBOX: Network = "paypal:sandbox";
export const PAYPAL_FAMILY = "paypal:*";

/** Amounts on the wire are integer US cents (ISO 4217 minor units), like Cloudflare's x402 scheme. */
export const USD: DefaultAsset = { asset: "USD", decimals: 2, symbol: "USD" };

/** Upper bound for how long a signed authorization stays valid. */
export const MAX_AUTHORIZATION_SECONDS = 60;

/**
 * Lifetime for an authorization under the given requirements: the server's
 * `maxTimeoutSeconds` capped at 60 s, and 60 s if the server sent no usable value.
 */
export function authorizationLifetime(maxTimeoutSeconds: unknown): number {
  return typeof maxTimeoutSeconds === "number" &&
    Number.isInteger(maxTimeoutSeconds) &&
    maxTimeoutSeconds > 0
    ? Math.min(maxTimeoutSeconds, MAX_AUTHORIZATION_SECONDS)
    : MAX_AUTHORIZATION_SECONDS;
}

/** Clock skew tolerated between agent and facilitator. */
export const CLOCK_SKEW_SECONDS = 5;

/** JWS `typ` header for prepaid authorizations. */
export const AUTHORIZATION_TYPE = "x402-prepaid+jwt";

/**
 * Error reasons. Standard x402 codes where they exist; scheme-specific codes follow the
 * spec's `invalid_<scheme>_...` pattern so clients can match on them.
 */
export const ErrorReason = {
  InsufficientFunds: "insufficient_funds",
  InvalidPayload: "invalid_payload",
  InvalidScheme: "invalid_scheme",
  InvalidNetwork: "invalid_network",
  InvalidRequirements: "invalid_payment_requirements",
  InvalidSignature: "invalid_prepaid_signature",
  Expired: "invalid_prepaid_authorization_expired",
  Mismatch: "invalid_prepaid_authorization_mismatch",
  UnknownKey: "invalid_prepaid_unknown_key",
  KeyRevoked: "invalid_prepaid_key_revoked",
  NonceUsed: "invalid_prepaid_nonce_used",
  OverPerRequestMax: "invalid_prepaid_over_per_request_max",
  OverDailyCap: "invalid_prepaid_over_daily_cap",
  SiteNotAllowed: "invalid_prepaid_site_not_allowed",
  UnexpectedSettleError: "unexpected_settle_error",
} as const;

export type ErrorReason = (typeof ErrorReason)[keyof typeof ErrorReason];

export function isPayPalNetwork(network: string): boolean {
  return network.startsWith("paypal:");
}
