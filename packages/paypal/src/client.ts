import type { z } from "zod";
import { PayPalInputError, PayPalResponseError, toPayPalApiError } from "./errors";
import {
  captureOrderResponse,
  createOrderResponse,
  createPayoutResponse,
  getPayoutResponse,
  refundResponse,
  tokenResponse,
  verifyWebhookResponse,
} from "./schemas";
import type {
  CaptureOrderResult,
  CreateOrderResult,
  HeadersLike,
  PayoutBatch,
  PayPalClient,
  PayPalClientOptions,
} from "./types";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const LIVE_HOSTS = new Set(["api-m.paypal.com", "api.paypal.com"]);

/** Refresh the token this long before PayPal says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_SENDER_ITEM_ID = 63;

const WEBHOOK_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

// ---------- input checks ----------

function assertAmount(value: string, field: string): void {
  if (!AMOUNT_PATTERN.test(value) || Number(value) <= 0) {
    throw new PayPalInputError(
      `${field} must be a positive decimal string with 2 places, like "5.00" (got "${value}")`,
    );
  }
}

function assertCurrency(value: string, field: string): void {
  if (!CURRENCY_PATTERN.test(value)) {
    throw new PayPalInputError(`${field} must be a 3-letter ISO currency code (got "${value}")`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new PayPalInputError(`${field} must not be empty`);
}

function assertSandboxUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PayPalInputError(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (LIVE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new PayPalInputError(
      `BotFare is sandbox only: refusing the live PayPal host ${url.hostname}`,
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

// ---------- helpers ----------

function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parse<S extends z.ZodType>(schema: S, body: unknown, what: string): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new PayPalResponseError(
      `Unexpected PayPal response for ${what}: ${result.error.message}`,
      body,
    );
  }
  return result.data;
}

// ---------- client ----------

export function createPayPalClient(options: PayPalClientOptions): PayPalClient {
  assertNonEmpty(options.clientId, "clientId");
  assertNonEmpty(options.clientSecret, "clientSecret");
  const baseUrl = assertSandboxUrl(options.baseUrl ?? SANDBOX_BASE_URL);
  const doFetch = options.fetch ?? globalThis.fetch;
  const logger = options.logger;
  const basicAuth = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`;

  let cachedToken: { value: string; refreshAt: number } | undefined;
  let pendingToken: Promise<string> | undefined;

  /** Sends one request, logs it, and throws PayPalApiError on non-2xx. Returns the parsed body. */
  async function send(
    method: "GET" | "POST",
    path: string,
    init: { headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const started = performance.now();
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: init.headers,
      body: init.body,
    });
    const debugId = response.headers.get("paypal-debug-id");
    logger?.({
      method,
      path,
      status: response.status,
      debugId: debugId ?? undefined,
      ms: Math.round(performance.now() - started),
    });
    const body = await readBody(response);
    if (!response.ok) {
      if (response.status === 401) cachedToken = undefined;
      throw toPayPalApiError(response.status, response.statusText, debugId, body);
    }
    return body;
  }

  async function fetchToken(): Promise<string> {
    const body = await send("POST", "/v1/oauth2/token", {
      headers: {
        Authorization: basicAuth,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const token = parse(tokenResponse, body, "POST /v1/oauth2/token");
    cachedToken = {
      value: token.access_token,
      refreshAt: Date.now() + token.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
    };
    return token.access_token;
  }

  function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.refreshAt) {
      return Promise.resolve(cachedToken.value);
    }
    // Concurrent callers share one in-flight token request.
    pendingToken ??= fetchToken().finally(() => {
      pendingToken = undefined;
    });
    return pendingToken;
  }

  /** Authenticated JSON call. Every POST carries a PayPal-Request-Id. */
  async function api(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; requestId?: string; representation?: boolean } = {},
  ): Promise<unknown> {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["PayPal-Request-Id"] = opts.requestId ?? crypto.randomUUID();
    }
    if (opts.representation) headers.Prefer = "return=representation";
    const body = method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined;
    return send(method, path, { headers, body });
  }

  return {
    getAccessToken,

    async createOrder(input) {
      const currency = input.currency ?? "USD";
      assertAmount(input.amount, "amount");
      assertCurrency(currency, "currency");
      assertNonEmpty(input.returnUrl, "returnUrl");
      assertNonEmpty(input.cancelUrl, "cancelUrl");

      const purchaseUnit: Record<string, unknown> = {
        amount: { currency_code: currency, value: input.amount },
      };
      if (input.description !== undefined) purchaseUnit.description = input.description;
      if (input.customId !== undefined) purchaseUnit.custom_id = input.customId;

      const body = await api("POST", "/v2/checkout/orders", {
        requestId: input.requestId,
        representation: true,
        body: {
          intent: "CAPTURE",
          purchase_units: [purchaseUnit],
          payment_source: {
            paypal: {
              experience_context: {
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
                payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
                return_url: input.returnUrl,
                cancel_url: input.cancelUrl,
              },
            },
          },
        },
      });
      const order = parse(createOrderResponse, body, "POST /v2/checkout/orders");
      // PayPal advises against hardcoding one rel: prefer payer-action, fall back to approve.
      const link =
        order.links.find((l) => l.rel === "payer-action") ??
        order.links.find((l) => l.rel === "approve");
      if (!link) {
        throw new PayPalResponseError(
          `Order ${order.id} has no payer-action or approve link`,
          body,
        );
      }
      return {
        id: order.id,
        status: order.status,
        approveUrl: link.href,
      } satisfies CreateOrderResult;
    },

    async captureOrder(orderId, opts = {}) {
      assertNonEmpty(orderId, "orderId");
      const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;
      const body = await api("POST", path, {
        requestId: opts.requestId,
        representation: true,
      });
      const order = parse(captureOrderResponse, body, `POST ${path}`);
      const capture = order.purchase_units[0]?.payments?.captures[0];
      if (!capture) {
        throw new PayPalResponseError(`Order ${order.id} capture returned no capture`, body);
      }
      const breakdown = capture.seller_receivable_breakdown;
      const gross = breakdown?.gross_amount ?? capture.amount;
      if (!gross) {
        throw new PayPalResponseError(`Capture ${capture.id} has no amount`, body);
      }
      return {
        orderId: order.id,
        status: order.status,
        captureId: capture.id,
        captureStatus: capture.status,
        gross: gross.value,
        fee: breakdown?.paypal_fee?.value ?? null,
        net: breakdown?.net_amount?.value ?? null,
        currency: gross.currency_code,
        payerEmail:
          order.payer?.email_address ?? order.payment_source?.paypal?.email_address ?? null,
        payerId: order.payer?.payer_id ?? order.payment_source?.paypal?.account_id ?? null,
      } satisfies CaptureOrderResult;
    },

    async refundCapture(captureId, opts = {}) {
      assertNonEmpty(captureId, "captureId");
      let refundBody: unknown = {};
      if (opts.amount !== undefined) {
        const currency = opts.currency ?? "USD";
        assertAmount(opts.amount, "amount");
        assertCurrency(currency, "currency");
        refundBody = { amount: { value: opts.amount, currency_code: currency } };
      }
      const path = `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`;
      const body = await api("POST", path, {
        requestId: opts.requestId,
        representation: true,
        body: refundBody,
      });
      const refund = parse(refundResponse, body, `POST ${path}`);
      return { id: refund.id, status: refund.status };
    },

    async createPayoutBatch(input) {
      assertNonEmpty(input.senderBatchId, "senderBatchId");
      if (input.items.length === 0) throw new PayPalInputError("items must not be empty");

      const items = input.items.map((item, i) => {
        const currency = item.currency ?? "USD";
        assertNonEmpty(item.receiver, `items[${i}].receiver`);
        assertNonEmpty(item.senderItemId, `items[${i}].senderItemId`);
        if (item.senderItemId.length > MAX_SENDER_ITEM_ID) {
          throw new PayPalInputError(
            `items[${i}].senderItemId must be at most ${MAX_SENDER_ITEM_ID} characters (got ${item.senderItemId.length})`,
          );
        }
        assertAmount(item.amount, `items[${i}].amount`);
        assertCurrency(currency, `items[${i}].currency`);
        return {
          recipient_type: "EMAIL",
          receiver: item.receiver,
          amount: { value: item.amount, currency },
          sender_item_id: item.senderItemId,
          ...(item.note !== undefined && { note: item.note }),
        };
      });

      const header: Record<string, string> = {
        sender_batch_id: input.senderBatchId,
        recipient_type: "EMAIL",
      };
      if (input.emailSubject !== undefined) header.email_subject = input.emailSubject;
      if (input.emailMessage !== undefined) header.email_message = input.emailMessage;

      const body = await api("POST", "/v1/payments/payouts", {
        requestId: input.requestId,
        body: { sender_batch_header: header, items },
      });
      const batch = parse(createPayoutResponse, body, "POST /v1/payments/payouts");
      return {
        batchId: batch.batch_header.payout_batch_id,
        batchStatus: batch.batch_header.batch_status,
      };
    },

    async getPayoutBatch(batchId) {
      assertNonEmpty(batchId, "batchId");
      const path = `/v1/payments/payouts/${encodeURIComponent(batchId)}`;
      const body = await api("GET", path);
      const batch = parse(getPayoutResponse, body, `GET ${path}`);
      return {
        batchId: batch.batch_header.payout_batch_id,
        batchStatus: batch.batch_header.batch_status,
        items: batch.items.map((item) => ({
          payoutItemId: item.payout_item_id,
          transactionStatus: item.transaction_status,
          senderItemId: item.payout_item.sender_item_id ?? null,
          receiver: item.payout_item.receiver ?? null,
          amount: item.payout_item.amount.value,
          currency: item.payout_item.amount.currency,
          ...(item.errors && {
            errors: { name: item.errors.name, message: item.errors.message },
          }),
        })),
      } satisfies PayoutBatch;
    },

    async verifyWebhookSignature({ headers, webhookId, event }) {
      assertNonEmpty(webhookId, "webhookId");
      const signature: Record<string, string> = {};
      for (const [field, header] of Object.entries(WEBHOOK_HEADERS)) {
        const value = getHeader(headers, header);
        // Without PayPal's signature headers the request cannot be from PayPal.
        if (!value) return false;
        signature[field] = value;
      }
      const body = await api("POST", "/v1/notifications/verify-webhook-signature", {
        body: { ...signature, webhook_id: webhookId, webhook_event: event },
      });
      const result = parse(
        verifyWebhookResponse,
        body,
        "POST /v1/notifications/verify-webhook-signature",
      );
      return result.verification_status === "SUCCESS";
    },
  };
}
