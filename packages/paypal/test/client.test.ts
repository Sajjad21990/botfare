import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPayPalClient,
  PayPalApiError,
  type PayPalClientOptions,
  PayPalInputError,
  type PayPalLogEntry,
} from "../src/index";
import { mockFetch, TOKEN_REPLY } from "./helpers";

const SANDBOX = "https://api-m.sandbox.paypal.com";

function client(fetch: typeof globalThis.fetch, extra: Partial<PayPalClientOptions> = {}) {
  return createPayPalClient({ clientId: "cid", clientSecret: "secret", fetch, ...extra });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("construction", () => {
  it("defaults to the sandbox host", async () => {
    const mock = mockFetch({});
    await client(mock.fetch).getAccessToken();
    expect(mock.calls[0]?.url).toBe(`${SANDBOX}/v1/oauth2/token`);
  });

  it.each([
    "https://api-m.paypal.com",
    "https://api-m.paypal.com/",
    "https://API-M.PAYPAL.COM",
    "https://api.paypal.com",
  ])("refuses the live host %s", (baseUrl) => {
    expect(() => client(mockFetch({}).fetch, { baseUrl })).toThrow(PayPalInputError);
    expect(() => client(mockFetch({}).fetch, { baseUrl })).toThrow(/sandbox only/);
  });

  it("accepts a custom non-live base URL and strips the trailing slash", async () => {
    const mock = mockFetch({});
    await client(mock.fetch, { baseUrl: "http://localhost:9999/" }).getAccessToken();
    expect(mock.calls[0]?.url).toBe("http://localhost:9999/v1/oauth2/token");
  });

  it("requires credentials", () => {
    expect(() => createPayPalClient({ clientId: "", clientSecret: "x" })).toThrow(/clientId/);
  });
});

describe("getAccessToken", () => {
  it("posts client_credentials with Basic auth", async () => {
    const mock = mockFetch({});
    const token = await client(mock.fetch).getAccessToken();
    expect(token).toBe("A21AAtest-token-value");
    const call = mock.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe(
      `Basic ${Buffer.from("cid:secret").toString("base64")}`,
    );
    expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call?.body).toBe("grant_type=client_credentials");
  });

  it("caches the token until 60 s before expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let n = 0;
    const mock = mockFetch({
      "POST /v1/oauth2/token": () => ({ body: { access_token: `tok${++n}`, expires_in: 3600 } }),
    });
    const pp = client(mock.fetch);

    expect(await pp.getAccessToken()).toBe("tok1");
    vi.setSystemTime(new Date("2026-01-01T00:58:59Z")); // 61 s before expiry
    expect(await pp.getAccessToken()).toBe("tok1");
    vi.setSystemTime(new Date("2026-01-01T00:59:00Z")); // inside the 60 s margin
    expect(await pp.getAccessToken()).toBe("tok2");
    expect(mock.callsTo("POST /v1/oauth2/token")).toHaveLength(2);
  });

  it("dedupes concurrent token requests", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = mockFetch({
      "POST /v1/oauth2/token": async () => {
        await gate;
        return TOKEN_REPLY;
      },
      "GET /v1/payments/payouts/B1": {
        body: { batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" } },
      },
    });
    const pp = client(mock.fetch);
    const results = Promise.all([
      pp.getAccessToken(),
      pp.getAccessToken(),
      pp.getPayoutBatch("B1"),
      pp.getPayoutBatch("B1"),
    ]);
    release();
    const [a, b] = await results;
    expect(a).toBe("A21AAtest-token-value");
    expect(b).toBe(a);
    expect(mock.callsTo("POST /v1/oauth2/token")).toHaveLength(1);
    expect(mock.callsTo("GET /v1/payments/payouts/B1")).toHaveLength(2);
  });

  it("retries the token after a failed token request", async () => {
    let n = 0;
    const mock = mockFetch({
      "POST /v1/oauth2/token": () =>
        ++n === 1
          ? { status: 500, body: { name: "INTERNAL_SERVER_ERROR", message: "boom" } }
          : TOKEN_REPLY,
    });
    const pp = client(mock.fetch);
    await expect(pp.getAccessToken()).rejects.toBeInstanceOf(PayPalApiError);
    await expect(pp.getAccessToken()).resolves.toBe("A21AAtest-token-value");
  });

  it("sends the bearer token on API calls", async () => {
    const mock = mockFetch({
      "GET /v1/payments/payouts/B1": {
        body: { batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" } },
      },
    });
    await client(mock.fetch).getPayoutBatch("B1");
    expect(mock.callsTo("GET /v1/payments/payouts/B1")[0]?.headers.authorization).toBe(
      "Bearer A21AAtest-token-value",
    );
  });
});

describe("createOrder", () => {
  const orderReply = (links: { rel: string; href: string }[]) => ({
    status: 200,
    body: { id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", links },
  });

  it("sends a CAPTURE order with experience_context and no application_context", async () => {
    const mock = mockFetch({
      "POST /v2/checkout/orders": orderReply([
        { rel: "self", href: "https://x/self" },
        { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O19" },
      ]),
    });
    await client(mock.fetch).createOrder({
      amount: "5.00",
      returnUrl: "http://localhost:4402/return",
      cancelUrl: "http://localhost:4402/cancel",
      description: "BotFare top-up",
      customId: "topup_1",
      requestId: "req-1",
    });
    const call = mock.callsTo("POST /v2/checkout/orders")[0];
    expect(call?.headers["paypal-request-id"]).toBe("req-1");
    expect(call?.headers.prefer).toBe("return=representation");
    expect(call?.body).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "5.00" },
          description: "BotFare top-up",
          custom_id: "topup_1",
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
            return_url: "http://localhost:4402/return",
            cancel_url: "http://localhost:4402/cancel",
          },
        },
      },
    });
    expect(call?.body).not.toHaveProperty("application_context");
  });

  it("returns the payer-action link as approveUrl", async () => {
    const mock = mockFetch({
      "POST /v2/checkout/orders": orderReply([
        { rel: "approve", href: "https://approve" },
        { rel: "payer-action", href: "https://payer-action" },
      ]),
    });
    const order = await client(mock.fetch).createOrder({
      amount: "5.00",
      returnUrl: "http://r",
      cancelUrl: "http://c",
    });
    expect(order).toEqual({
      id: "5O190127TN364715T",
      status: "PAYER_ACTION_REQUIRED",
      approveUrl: "https://payer-action",
    });
  });

  it("falls back to the approve link", async () => {
    const mock = mockFetch({
      "POST /v2/checkout/orders": orderReply([
        { rel: "self", href: "https://self" },
        { rel: "approve", href: "https://approve" },
      ]),
    });
    const order = await client(mock.fetch).createOrder({
      amount: "5.00",
      returnUrl: "http://r",
      cancelUrl: "http://c",
    });
    expect(order.approveUrl).toBe("https://approve");
  });

  it("throws when neither link is present", async () => {
    const mock = mockFetch({
      "POST /v2/checkout/orders": orderReply([{ rel: "self", href: "https://self" }]),
    });
    await expect(
      client(mock.fetch).createOrder({
        amount: "5.00",
        returnUrl: "http://r",
        cancelUrl: "http://c",
      }),
    ).rejects.toThrow(/no payer-action or approve link/);
  });

  it.each(["5", "5.0", "5.001", "0.00", "-1.00", "abc"])("rejects amount %s", async (amount) => {
    const mock = mockFetch({});
    await expect(
      client(mock.fetch).createOrder({ amount, returnUrl: "http://r", cancelUrl: "http://c" }),
    ).rejects.toBeInstanceOf(PayPalInputError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("captureOrder", () => {
  const captureBody = (breakdown: Record<string, unknown>, captureStatus = "COMPLETED") => ({
    id: "5O190127TN364715T",
    status: "COMPLETED",
    payment_source: { paypal: { email_address: "owner@example.com", account_id: "QYR5Z8XDVJNXQ" } },
    payer: { email_address: "owner@example.com", payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [
      {
        reference_id: "default",
        payments: {
          captures: [
            {
              id: "3C679366HH908993F",
              status: captureStatus,
              amount: { currency_code: "USD", value: "5.00" },
              seller_receivable_breakdown: breakdown,
            },
          ],
        },
      },
    ],
  });

  it("parses gross, fee and net", async () => {
    const mock = mockFetch({
      "POST /v2/checkout/orders/5O190127TN364715T/capture": {
        status: 201,
        body: captureBody({
          gross_amount: { currency_code: "USD", value: "5.00" },
          paypal_fee: { currency_code: "USD", value: "0.67" },
          net_amount: { currency_code: "USD", value: "4.33" },
        }),
      },
    });
    const result = await client(mock.fetch).captureOrder("5O190127TN364715T", {
      requestId: "cap-1",
    });
    expect(result).toEqual({
      orderId: "5O190127TN364715T",
      status: "COMPLETED",
      captureId: "3C679366HH908993F",
      captureStatus: "COMPLETED",
      gross: "5.00",
      fee: "0.67",
      net: "4.33",
      currency: "USD",
      payerEmail: "owner@example.com",
      payerId: "QYR5Z8XDVJNXQ",
    });
    const call = mock.calls.at(-1);
    expect(call?.headers["paypal-request-id"]).toBe("cap-1");
    expect(call?.headers.prefer).toBe("return=representation");
  });

  it("returns null fee and net while the capture is pending", async () => {
    const mock = mockFetch({
      "POST /v2/checkout/orders/5O190127TN364715T/capture": {
        status: 201,
        body: captureBody({ gross_amount: { currency_code: "USD", value: "5.00" } }, "PENDING"),
      },
    });
    const result = await client(mock.fetch).captureOrder("5O190127TN364715T");
    expect(result.captureStatus).toBe("PENDING");
    expect(result.gross).toBe("5.00");
    expect(result.fee).toBeNull();
    expect(result.net).toBeNull();
  });

  it("falls back to the payment_source payer when payer is absent", async () => {
    const body = captureBody({ gross_amount: { currency_code: "USD", value: "5.00" } });
    const { payer: _payer, ...withoutPayer } = body;
    const mock = mockFetch({
      "POST /v2/checkout/orders/5O190127TN364715T/capture": { status: 201, body: withoutPayer },
    });
    const result = await client(mock.fetch).captureOrder("5O190127TN364715T");
    expect(result.payerEmail).toBe("owner@example.com");
    expect(result.payerId).toBe("QYR5Z8XDVJNXQ");
  });
});

describe("refundCapture", () => {
  it("sends an empty body for a full refund", async () => {
    const mock = mockFetch({
      "POST /v2/payments/captures/CAP1/refund": {
        status: 201,
        body: { id: "R1", status: "COMPLETED" },
      },
    });
    expect(await client(mock.fetch).refundCapture("CAP1")).toEqual({
      id: "R1",
      status: "COMPLETED",
    });
    expect(mock.calls.at(-1)?.body).toEqual({});
  });

  it("sends the amount for a partial refund", async () => {
    const mock = mockFetch({
      "POST /v2/payments/captures/CAP1/refund": {
        status: 201,
        body: { id: "R2", status: "PENDING" },
      },
    });
    await client(mock.fetch).refundCapture("CAP1", { amount: "1.50" });
    expect(mock.calls.at(-1)?.body).toEqual({ amount: { value: "1.50", currency_code: "USD" } });
  });
});

describe("createPayoutBatch", () => {
  const reply = {
    status: 201,
    body: {
      batch_header: {
        payout_batch_id: "5UXD2E8A7EBQJ",
        batch_status: "PENDING",
        sender_batch_header: { sender_batch_id: "spike_1" },
      },
      links: [],
    },
  };

  it("sends an EMAIL batch and returns the batch ID", async () => {
    const mock = mockFetch({ "POST /v1/payments/payouts": reply });
    const result = await client(mock.fetch).createPayoutBatch({
      senderBatchId: "spike_1",
      emailSubject: "You have a payout",
      items: [
        { receiver: "pub@example.com", amount: "0.25", note: "thanks", senderItemId: "item_1" },
        { receiver: "pub2@example.com", amount: "1.00", currency: "EUR", senderItemId: "item_2" },
      ],
    });
    expect(result).toEqual({ batchId: "5UXD2E8A7EBQJ", batchStatus: "PENDING" });
    expect(mock.calls.at(-1)?.body).toEqual({
      sender_batch_header: {
        sender_batch_id: "spike_1",
        recipient_type: "EMAIL",
        email_subject: "You have a payout",
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: "pub@example.com",
          amount: { value: "0.25", currency: "USD" },
          sender_item_id: "item_1",
          note: "thanks",
        },
        {
          recipient_type: "EMAIL",
          receiver: "pub2@example.com",
          amount: { value: "1.00", currency: "EUR" },
          sender_item_id: "item_2",
        },
      ],
    });
  });

  it("accepts a 63-char senderItemId and rejects 64", async () => {
    const mock = mockFetch({ "POST /v1/payments/payouts": reply });
    const pp = client(mock.fetch);
    const item = (senderItemId: string) => ({
      receiver: "p@example.com",
      amount: "0.25",
      senderItemId,
    });

    await expect(
      pp.createPayoutBatch({ senderBatchId: "b1", items: [item("x".repeat(63))] }),
    ).resolves.toBeDefined();
    await expect(
      pp.createPayoutBatch({ senderBatchId: "b2", items: [item("x".repeat(64))] }),
    ).rejects.toThrow(/at most 63 characters/);
    expect(mock.callsTo("POST /v1/payments/payouts")).toHaveLength(1);
  });

  it("rejects bad amounts and empty batches before calling PayPal", async () => {
    const mock = mockFetch({});
    const pp = client(mock.fetch);
    await expect(
      pp.createPayoutBatch({
        senderBatchId: "b",
        items: [{ receiver: "p@example.com", amount: "0.250", senderItemId: "i" }],
      }),
    ).rejects.toBeInstanceOf(PayPalInputError);
    await expect(pp.createPayoutBatch({ senderBatchId: "b", items: [] })).rejects.toBeInstanceOf(
      PayPalInputError,
    );
    expect(mock.calls).toHaveLength(0);
  });
});

describe("getPayoutBatch", () => {
  it("maps the batch and its items", async () => {
    const mock = mockFetch({
      "GET /v1/payments/payouts/5UXD2E8A7EBQJ": {
        body: {
          batch_header: { payout_batch_id: "5UXD2E8A7EBQJ", batch_status: "SUCCESS" },
          items: [
            {
              payout_item_id: "8AELMXH8UB2P8",
              transaction_status: "UNCLAIMED",
              payout_item: {
                recipient_type: "EMAIL",
                amount: { value: "0.25", currency: "USD" },
                receiver: "pub@example.com",
                sender_item_id: "item_1",
              },
              errors: { name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered" },
            },
          ],
        },
      },
    });
    const batch = await client(mock.fetch).getPayoutBatch("5UXD2E8A7EBQJ");
    expect(batch).toEqual({
      batchId: "5UXD2E8A7EBQJ",
      batchStatus: "SUCCESS",
      items: [
        {
          payoutItemId: "8AELMXH8UB2P8",
          transactionStatus: "UNCLAIMED",
          senderItemId: "item_1",
          receiver: "pub@example.com",
          amount: "0.25",
          currency: "USD",
          errors: { name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered" },
        },
      ],
    });
    // GETs carry no PayPal-Request-Id.
    expect(mock.calls.at(-1)?.headers["paypal-request-id"]).toBeUndefined();
  });
});

describe("PayPal-Request-Id", () => {
  it("is a random UUID on every POST when the caller gives none", async () => {
    const mock = mockFetch({
      "POST /v2/checkout/orders": {
        body: { id: "O1", status: "CREATED", links: [{ rel: "approve", href: "https://a" }] },
      },
      "POST /v2/payments/captures/C1/refund": { body: { id: "R1", status: "COMPLETED" } },
      "POST /v1/payments/payouts": {
        status: 201,
        body: { batch_header: { payout_batch_id: "B1", batch_status: "PENDING" } },
      },
    });
    const pp = client(mock.fetch);
    await pp.createOrder({ amount: "5.00", returnUrl: "http://r", cancelUrl: "http://c" });
    await pp.createOrder({ amount: "5.00", returnUrl: "http://r", cancelUrl: "http://c" });
    await pp.refundCapture("C1");
    await pp.createPayoutBatch({
      senderBatchId: "b",
      items: [{ receiver: "p@example.com", amount: "0.25", senderItemId: "i" }],
    });

    const apiPosts = mock.calls.filter((c) => c.method === "POST" && c.path !== "/v1/oauth2/token");
    expect(apiPosts).toHaveLength(4);
    const ids = apiPosts.map((c) => c.headers["paypal-request-id"]);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("errors", () => {
  it("maps a REST error with debugId from the header", async () => {
    const errorBody = {
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed.",
      debug_id: "body-debug-id",
      details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not yet approved." }],
    };
    const mock = mockFetch({
      "POST /v2/checkout/orders/O1/capture": {
        status: 422,
        body: errorBody,
        headers: { "paypal-debug-id": "f1a2b3c4d5e6" },
      },
    });
    const error = await client(mock.fetch)
      .captureOrder("O1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed.",
      debugId: "f1a2b3c4d5e6",
      details: [{ issue: "ORDER_NOT_APPROVED" }],
      body: errorBody,
    });
  });

  it("falls back to the body debug_id when the header is absent", async () => {
    const mock = mockFetch({
      "GET /v1/payments/payouts/B1": {
        status: 403,
        body: {
          name: "AUTHORIZATION_ERROR",
          message: "Authorization error occurred.",
          debug_id: "d1",
        },
      },
    });
    await expect(client(mock.fetch).getPayoutBatch("B1")).rejects.toMatchObject({
      name: "AUTHORIZATION_ERROR",
      debugId: "d1",
      details: [],
    });
  });

  it("maps the OAuth error shape", async () => {
    const mock = mockFetch({
      "POST /v1/oauth2/token": {
        status: 401,
        body: { error: "invalid_client", error_description: "Client Authentication failed" },
        headers: { "paypal-debug-id": "oauth-debug" },
      },
    });
    await expect(client(mock.fetch).getAccessToken()).rejects.toMatchObject({
      status: 401,
      name: "invalid_client",
      message: "Client Authentication failed",
      debugId: "oauth-debug",
    });
  });

  it("handles a non-JSON error body", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    ) as unknown as typeof globalThis.fetch;
    await expect(client(fetch).getAccessToken()).rejects.toMatchObject({
      status: 502,
      name: "HTTP_502",
      message: "Bad Gateway",
      body: "<html>Bad gateway</html>",
    });
  });
});

describe("logger", () => {
  it("logs method, path, status, debugId and ms, never secrets", async () => {
    const entries: PayPalLogEntry[] = [];
    const mock = mockFetch({
      "GET /v1/payments/payouts/B1": {
        body: { batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" } },
        headers: { "paypal-debug-id": "dbg-1" },
      },
    });
    await client(mock.fetch, { logger: (e) => entries.push(e) }).getPayoutBatch("B1");
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      method: "GET",
      path: "/v1/payments/payouts/B1",
      status: 200,
      debugId: "dbg-1",
      ms: expect.any(Number),
    });
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("A21AAtest-token-value");
    expect(logged).not.toContain(Buffer.from("cid:secret").toString("base64"));
  });
});

describe("verifyWebhookSignature", () => {
  const event = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP1" } };
  const headers = {
    "PAYPAL-AUTH-ALGO": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "Paypal-Transmission-Id": "tx-1",
    "paypal-transmission-sig": "sig==",
    "paypal-transmission-time": "2026-11-08T10:00:00Z",
    "content-type": "application/json",
  };

  function verifyMock(status: string) {
    return mockFetch({
      "POST /v1/notifications/verify-webhook-signature": { body: { verification_status: status } },
    });
  }

  it("returns true on SUCCESS and sends the expected body", async () => {
    const mock = verifyMock("SUCCESS");
    const ok = await client(mock.fetch).verifyWebhookSignature({
      headers,
      webhookId: "WH-ID",
      event,
    });
    expect(ok).toBe(true);
    const call = mock.calls.at(-1);
    expect(call?.headers["paypal-request-id"]).toBeDefined();
    expect(call?.body).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      transmission_id: "tx-1",
      transmission_sig: "sig==",
      transmission_time: "2026-11-08T10:00:00Z",
      webhook_id: "WH-ID",
      webhook_event: event,
    });
  });

  it("returns false on FAILURE", async () => {
    const mock = verifyMock("FAILURE");
    expect(
      await client(mock.fetch).verifyWebhookSignature({ headers, webhookId: "WH-ID", event }),
    ).toBe(false);
  });

  it("accepts a Headers object", async () => {
    const mock = verifyMock("SUCCESS");
    const ok = await client(mock.fetch).verifyWebhookSignature({
      headers: new Headers(headers),
      webhookId: "WH-ID",
      event,
    });
    expect(ok).toBe(true);
  });

  it("returns false without calling PayPal when a signature header is missing", async () => {
    const mock = verifyMock("SUCCESS");
    const { "paypal-transmission-sig": _sig, ...partial } = headers;
    const ok = await client(mock.fetch).verifyWebhookSignature({
      headers: partial,
      webhookId: "WH-ID",
      event,
    });
    expect(ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });
});
