// Public input and output types of the PayPal client.

/** One line per HTTP call. Never contains tokens, secrets or headers. */
export interface PayPalLogEntry {
  method: string;
  path: string;
  status: number;
  debugId: string | undefined;
  ms: number;
}

export type PayPalLogger = (entry: PayPalLogEntry) => void;

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  /** Defaults to the sandbox host. The live host is refused. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. Inject a mock in tests. */
  fetch?: typeof fetch;
  logger?: PayPalLogger;
}

/** Decimal string with exactly two places, e.g. "5.00". */
export type Amount = string;

export interface CreateOrderInput {
  amount: Amount;
  /** ISO 4217 code. Defaults to "USD". */
  currency?: string;
  returnUrl: string;
  cancelUrl: string;
  description?: string;
  /** Echoed back on the capture and in webhooks; handy for our own top-up ID. */
  customId?: string;
  /** Sent as `PayPal-Request-Id`. Defaults to a random UUID. */
  requestId?: string;
}

export interface CreateOrderResult {
  id: string;
  status: string;
  /** Where to send the payer: the `payer-action` link, falling back to `approve`. */
  approveUrl: string;
}

export interface CaptureOrderOptions {
  requestId?: string;
}

export interface CaptureOrderResult {
  orderId: string;
  /** Order status, e.g. "COMPLETED". */
  status: string;
  captureId: string;
  /** Capture status: COMPLETED, PENDING, DECLINED, ... */
  captureStatus: string;
  gross: Amount;
  /** PayPal's fee. `null` while the capture is pending. */
  fee: Amount | null;
  /** Gross minus fee. `null` while the capture is pending. */
  net: Amount | null;
  currency: string;
  payerEmail: string | null;
  payerId: string | null;
}

export interface RefundCaptureOptions {
  /** Partial refund amount. Omit for a full refund. */
  amount?: Amount;
  /** Defaults to "USD"; only used with `amount`. */
  currency?: string;
  requestId?: string;
}

export interface RefundCaptureResult {
  id: string;
  status: string;
}

export interface PayoutItemInput {
  /** Receiver's PayPal email. */
  receiver: string;
  amount: Amount;
  /** Defaults to "USD". */
  currency?: string;
  note?: string;
  /** Our own ID for the item; at most 63 characters. */
  senderItemId: string;
}

export interface CreatePayoutBatchInput {
  /** Our own batch ID. PayPal rejects a reused ID for 30 days, so it is the idempotency key. */
  senderBatchId: string;
  emailSubject?: string;
  emailMessage?: string;
  items: PayoutItemInput[];
  /** Sent as `PayPal-Request-Id`. Defaults to a random UUID. */
  requestId?: string;
}

export const PAYOUT_BATCH_STATUSES = [
  "DENIED",
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "CANCELED",
] as const;

export const PAYOUT_TRANSACTION_STATUSES = [
  "SUCCESS",
  "FAILED",
  "PENDING",
  "UNCLAIMED",
  "RETURNED",
  "ONHOLD",
  "BLOCKED",
  "REFUNDED",
  "REVERSED",
] as const;

// `string & {}` keeps autocomplete for the known values without failing on new ones.
export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number] | (string & {});
export type PayoutTransactionStatus = (typeof PAYOUT_TRANSACTION_STATUSES)[number] | (string & {});

export interface CreatePayoutBatchResult {
  batchId: string;
  batchStatus: PayoutBatchStatus;
}

export interface PayoutItemError {
  name: string;
  message: string;
}

export interface PayoutItem {
  payoutItemId: string;
  transactionStatus: PayoutTransactionStatus;
  senderItemId: string | null;
  receiver: string | null;
  amount: Amount;
  currency: string;
  errors?: PayoutItemError;
}

export interface PayoutBatch {
  batchId: string;
  batchStatus: PayoutBatchStatus;
  items: PayoutItem[];
}

/** Request headers as a `Headers` object or a plain record (e.g. Node's `req.headers`). */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookInput {
  headers: HeadersLike;
  /** The webhook ID from the app's Webhooks section in the developer dashboard. */
  webhookId: string;
  /** The parsed webhook event body. */
  event: unknown;
}

export interface PayPalClient {
  getAccessToken(): Promise<string>;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  captureOrder(orderId: string, options?: CaptureOrderOptions): Promise<CaptureOrderResult>;
  refundCapture(captureId: string, options?: RefundCaptureOptions): Promise<RefundCaptureResult>;
  createPayoutBatch(input: CreatePayoutBatchInput): Promise<CreatePayoutBatchResult>;
  getPayoutBatch(batchId: string): Promise<PayoutBatch>;
  verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean>;
}
