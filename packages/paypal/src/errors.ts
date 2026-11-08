/** One entry of the `details` array PayPal attaches to most error responses. */
export interface PayPalErrorDetail {
  issue?: string;
  description?: string;
  field?: string;
  value?: string;
  location?: string;
  [key: string]: unknown;
}

/**
 * Thrown for any non-2xx PayPal response. Check it with `instanceof PayPalApiError`.
 *
 * `name` is PayPal's error name (e.g. `UNPROCESSABLE_ENTITY`, `AUTHORIZATION_ERROR`, or
 * `invalid_client` from OAuth), or `HTTP_<status>` when the body has none.
 */
export class PayPalApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** PayPal's error name, or `HTTP_<status>` when the body has none. */
  override readonly name: string;
  /** Value of the `paypal-debug-id` header (or `debug_id` in the body). Quote it to PayPal support. */
  readonly debugId: string | undefined;
  readonly details: PayPalErrorDetail[];
  /** The raw response body: parsed JSON when possible, otherwise the text. */
  readonly body: unknown;

  constructor(init: {
    status: number;
    name: string;
    message: string;
    debugId: string | undefined;
    details: PayPalErrorDetail[];
    body: unknown;
  }) {
    super(init.message);
    this.status = init.status;
    this.name = init.name;
    this.debugId = init.debugId;
    this.details = init.details;
    this.body = init.body;
  }
}

/** Thrown before any request is sent when the caller passes invalid input. */
export class PayPalInputError extends Error {
  override name = "PayPalInputError";
}

/** Thrown when a 2xx PayPal response does not have the shape we rely on. */
export class PayPalResponseError extends Error {
  override name = "PayPalResponseError";
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(message);
    this.body = body;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Builds a PayPalApiError from a failed response.
 * Handles the REST shape (`name`, `message`, `debug_id`, `details`) and the OAuth shape
 * (`error`, `error_description`).
 */
export function toPayPalApiError(
  status: number,
  statusText: string,
  headerDebugId: string | null,
  body: unknown,
): PayPalApiError {
  const record = asRecord(body);
  const name = asString(record?.name) ?? asString(record?.error) ?? `HTTP_${status}`;
  const message =
    asString(record?.message) ??
    asString(record?.error_description) ??
    (statusText || `PayPal request failed with HTTP ${status}`);
  const debugId = headerDebugId ?? asString(record?.debug_id);
  const details = Array.isArray(record?.details) ? (record.details as PayPalErrorDetail[]) : [];
  return new PayPalApiError({ status, name, message, debugId, details, body });
}
