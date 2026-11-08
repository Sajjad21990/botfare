import type {
  CaptureOrderResult,
  CreatePayoutBatchInput,
  CreatePayoutBatchResult,
  PayoutBatch,
  PayPalClient,
} from "@botfare/paypal";
import { PayPalApiError } from "@botfare/paypal";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  Accounts,
  accountBalanceMicros,
  completeTopUp,
  createSite,
  earningsBalanceMicros,
  getPayout,
  getPayoutEmail,
  handlePayPalWebhookEvent,
  listPayouts,
  MoneyFlowError,
  PostgresPrepaidLedger,
  postTransaction,
  publisherSummary,
  receiptsForPublisher,
  requestPayout,
  runDailyPayouts,
  schema,
  setPayoutEmail,
  startTopUp,
  syncPayout,
  syncPendingPayouts,
  walletBalanceMicros,
  walletSummary,
} from "../src";
import {
  chargeRequest,
  expectLedgerHealthy,
  makeAgent,
  makePublisher,
  makeUser,
  openTestDb,
} from "./helpers";

const { db, close } = openTestDb();
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

const FEE_FOR = (amount: string) => (amount === "10.00" ? "0.84" : "0.67");

/** An in-memory PayPal: orders capture as COMPLETED with a fee unless a test overrides it. */
function mockPayPal() {
  const orders = new Map<string, { amount: string; customId?: string }>();
  let seq = 0;
  const createOrder = vi.fn<PayPalClient["createOrder"]>(async (input) => {
    seq += 1;
    const id = `ORDER${Date.now().toString(36).toUpperCase()}${seq}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    orders.set(id, { amount: input.amount, customId: input.customId });
    return {
      id,
      status: "PAYER_ACTION_REQUIRED",
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
    };
  });
  const captureOrder = vi.fn<PayPalClient["captureOrder"]>(async (orderId) =>
    completedCapture(orderId, orders.get(orderId)?.amount ?? "0.00"),
  );
  const createPayoutBatch = vi.fn<PayPalClient["createPayoutBatch"]>(
    async (input): Promise<CreatePayoutBatchResult> => ({
      batchId: `PB-${input.senderBatchId}`,
      batchStatus: "PENDING",
    }),
  );
  const getPayoutBatch = vi.fn<PayPalClient["getPayoutBatch"]>();
  return { orders, createOrder, captureOrder, createPayoutBatch, getPayoutBatch };
}

function completedCapture(orderId: string, amount: string): CaptureOrderResult {
  const fee = FEE_FOR(amount);
  return {
    orderId,
    status: "COMPLETED",
    captureId: `CAP-${orderId}`,
    captureStatus: "COMPLETED",
    gross: amount,
    fee,
    net: null,
    currency: "USD",
    payerEmail: "buyer@example.test",
    payerId: "PAYER1",
  };
}

function captureCompletedEvent(orderId: string, amount = "10.00", eventId = crypto.randomUUID()) {
  return {
    id: `WH-${eventId}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource_type: "capture",
    resource: {
      id: `CAP-${orderId}`,
      status: "COMPLETED",
      amount: { value: amount, currency_code: "USD" },
      seller_receivable_breakdown: {
        gross_amount: { value: amount, currency_code: "USD" },
        paypal_fee: { value: FEE_FOR(amount), currency_code: "USD" },
        net_amount: { value: "9.16", currency_code: "USD" },
      },
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  };
}

function payPalError(status: number, name: string, issue?: string) {
  return new PayPalApiError({
    status,
    name,
    message: `${name} from mock`,
    debugId: "dbg",
    details: issue ? [{ issue }] : [],
    body: {},
  });
}

async function expectMoneyError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MoneyFlowError);
  expect((err as MoneyFlowError).code).toBe(code);
}

async function topUpOrder(paypal: ReturnType<typeof mockPayPal>, amountCents = 1000) {
  const owner = await makeUser(db, "topup");
  const { orderId } = await startTopUp(db, paypal, {
    ownerUserId: owner.id,
    amountCents,
    returnUrl: "http://localhost:3000/wallet/return",
    cancelUrl: "http://localhost:3000/wallet",
  });
  return { owner, orderId };
}

async function topUpCount(ownerUserId: string) {
  const rows = await db
    .select()
    .from(schema.topups)
    .where(eq(schema.topups.ownerUserId, ownerUserId));
  return rows.length;
}

/** Gives a publisher earnings directly (stands in for many paid requests). */
async function fundEarnings(userId: string, micros: number) {
  await postTransaction(db, {
    kind: "charge",
    idempotencyKey: `test-earnings:${crypto.randomUUID()}`,
    entries: [
      { accountId: Accounts.earnings(userId), amountMicros: micros },
      { accountId: Accounts.paypalClearing, amountMicros: -micros },
    ],
  });
}

async function publisherWithEarnings(micros: number, email: string | null = "pub@example.test") {
  const owner = await makeUser(db, "earner");
  if (email) await setPayoutEmail(db, { userId: owner.id, email });
  await fundEarnings(owner.id, micros);
  return owner;
}

async function reversalCount(payoutId: string) {
  const rows = await db
    .select()
    .from(schema.ledgerTransactions)
    .where(eq(schema.ledgerTransactions.idempotencyKey, `reversal:${payoutId}`));
  return rows.length;
}

function batchWithItem(
  input: CreatePayoutBatchInput,
  transactionStatus: string,
  errors?: { name: string; message: string },
): PayoutBatch {
  return {
    batchId: `PB-${input.senderBatchId}`,
    batchStatus: "SUCCESS",
    items: input.items.map((item, i) => ({
      payoutItemId: `ITEM-${i}-${item.senderItemId}`,
      transactionStatus,
      senderItemId: item.senderItemId,
      receiver: item.receiver,
      amount: item.amount,
      currency: "USD",
      ...(errors && { errors }),
    })),
  };
}

// ---------------------------------------------------------------------------------------------

describe("top-ups", () => {
  it("creates an order bound to the user and only for $5, $10 or $20", async () => {
    const paypal = mockPayPal();
    const { owner, orderId } = await topUpOrder(paypal, 2000);
    expect(paypal.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "20.00",
        currency: "USD",
        customId: owner.id,
        description: "BotFare wallet top-up",
      }),
    );
    const [order] = await db
      .select()
      .from(schema.paypalOrders)
      .where(eq(schema.paypalOrders.orderId, orderId));
    expect(order).toMatchObject({ ownerUserId: owner.id, amountCents: 2000, status: "created" });

    await expectMoneyError(
      startTopUp(db, paypal, {
        ownerUserId: owner.id,
        amountCents: 700,
        returnUrl: "http://localhost/r",
        cancelUrl: "http://localhost/c",
      }),
      "invalid_amount",
    );
    expect(paypal.createOrder).toHaveBeenCalledTimes(1);
  });

  it("captures, books the PayPal fee and credits the wallet once (return page first)", async () => {
    const paypal = mockPayPal();
    const { owner, orderId } = await topUpOrder(paypal);
    const feesBefore = await accountBalanceMicros(db, Accounts.paypalFees);

    const result = await completeTopUp(db, paypal, { ownerUserId: owner.id, orderId });
    expect(result).toEqual({
      status: "captured",
      walletMicros: 10_000_000,
      captureId: `CAP-${orderId}`,
      grossCents: 1000,
      feeCents: 84,
    });
    expect(paypal.captureOrder).toHaveBeenCalledWith(orderId, {
      requestId: `botfare-capture-${orderId}`,
    });
    expect((await accountBalanceMicros(db, Accounts.paypalFees)) - feesBefore).toBe(840_000);

    // Repeat call and the webhook both arrive later: nothing moves again.
    expect(await completeTopUp(db, paypal, { ownerUserId: owner.id, orderId })).toEqual(result);
    expect(paypal.captureOrder).toHaveBeenCalledTimes(1);
    const hook = await handlePayPalWebhookEvent(db, paypal, captureCompletedEvent(orderId));
    expect(hook.status).toBe("processed");
    expect(await walletBalanceMicros(db, owner.id)).toBe(10_000_000);
    expect(await topUpCount(owner.id)).toBe(1);

    const summary = await walletSummary(db, owner.id);
    expect(summary.balanceMicros).toBe(10_000_000);
    expect(summary.topups.map((t) => t.captureId)).toEqual([`CAP-${orderId}`]);
  });

  it("credits once when the webhook arrives before the return page", async () => {
    const paypal = mockPayPal();
    const { owner, orderId } = await topUpOrder(paypal);
    // The capture happened in another request whose response we never saw.
    paypal.captureOrder.mockRejectedValueOnce(
      payPalError(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED"),
    );
    const early = await completeTopUp(db, paypal, { ownerUserId: owner.id, orderId });
    expect(early).toEqual({ status: "pending", walletMicros: 0 });

    const hook = await handlePayPalWebhookEvent(db, paypal, captureCompletedEvent(orderId));
    expect(hook.status).toBe("processed");
    expect(await walletBalanceMicros(db, owner.id)).toBe(10_000_000);

    const late = await completeTopUp(db, paypal, { ownerUserId: owner.id, orderId });
    expect(late).toMatchObject({ status: "captured", walletMicros: 10_000_000, feeCents: 84 });
    expect(paypal.captureOrder).toHaveBeenCalledTimes(1);
    expect(await topUpCount(owner.id)).toBe(1);
  });

  it("credits once when the return page and the webhook race", async () => {
    const paypal = mockPayPal();
    const { owner, orderId } = await topUpOrder(paypal);
    const results = await Promise.all([
      completeTopUp(db, paypal, { ownerUserId: owner.id, orderId }),
      handlePayPalWebhookEvent(db, paypal, captureCompletedEvent(orderId)),
      completeTopUp(db, paypal, { ownerUserId: owner.id, orderId }),
    ]);
    expect(results[1].status).toBe("processed");
    expect(await walletBalanceMicros(db, owner.id)).toBe(10_000_000);
    expect(await topUpCount(owner.id)).toBe(1);
  });

  it("refuses someone else's order without calling PayPal", async () => {
    const paypal = mockPayPal();
    const { orderId } = await topUpOrder(paypal);
    const intruder = await makeUser(db, "intruder");
    await expectMoneyError(
      completeTopUp(db, paypal, { ownerUserId: intruder.id, orderId }),
      "not_found",
    );
    await expectMoneyError(
      completeTopUp(db, paypal, { ownerUserId: intruder.id, orderId: "ORDER-MISSING" }),
      "not_found",
    );
    expect(paypal.captureOrder).not.toHaveBeenCalled();
    expect(await walletBalanceMicros(db, intruder.id)).toBe(0);
  });

  it("refuses a capture whose amount differs from the order", async () => {
    const paypal = mockPayPal();
    const { owner, orderId } = await topUpOrder(paypal);
    paypal.captureOrder.mockResolvedValueOnce(completedCapture(orderId, "5.00"));
    await expectMoneyError(
      completeTopUp(db, paypal, { ownerUserId: owner.id, orderId }),
      "amount_mismatch",
    );
    const hook = await handlePayPalWebhookEvent(db, paypal, captureCompletedEvent(orderId, "5.00"));
    expect(hook).toMatchObject({ status: "failed", retryable: false });
    expect(await walletBalanceMicros(db, owner.id)).toBe(0);
    expect(await topUpCount(owner.id)).toBe(0);
  });

  it("reports a pending capture and lets the webhook finish it", async () => {
    const paypal = mockPayPal();
    const { owner, orderId } = await topUpOrder(paypal);
    paypal.captureOrder.mockResolvedValueOnce({
      ...completedCapture(orderId, "10.00"),
      captureStatus: "PENDING",
      fee: null,
    });
    expect(await completeTopUp(db, paypal, { ownerUserId: owner.id, orderId })).toEqual({
      status: "pending",
      walletMicros: 0,
    });
    await handlePayPalWebhookEvent(db, paypal, captureCompletedEvent(orderId));
    expect(await walletBalanceMicros(db, owner.id)).toBe(10_000_000);
  });
});

// ---------------------------------------------------------------------------------------------

describe("payout email", () => {
  it("prefers the user's email and falls back to their first site's", async () => {
    const { owner } = await makePublisher(db);
    expect(await getPayoutEmail(db, owner.id)).toBeNull();
    await createSite(db, {
      ownerUserId: owner.id,
      name: "Second Site",
      origin: "https://second.example",
      pricing: [],
      payoutEmail: "site@example.test",
    });
    expect(await getPayoutEmail(db, owner.id)).toBe("site@example.test");
    await setPayoutEmail(db, { userId: owner.id, email: " Me@Example.TEST " });
    expect(await getPayoutEmail(db, owner.id)).toBe("me@example.test");
    await expect(setPayoutEmail(db, { userId: owner.id, email: "not-an-email" })).rejects.toThrow();
  });
});

describe("requestPayout", () => {
  it("moves whole-cent earnings to clearing and calls Payouts with the right body", async () => {
    const paypal = mockPayPal();
    const owner = await publisherWithEarnings(1_234_567);
    const clearingBefore = await accountBalanceMicros(db, Accounts.paypalClearing);

    const payout = await requestPayout(db, paypal, { publisherUserId: owner.id });
    expect(payout).toMatchObject({
      publisherUserId: owner.id,
      receiverEmail: "pub@example.test",
      amountCents: 123,
      status: "pending",
      paypalBatchId: `PB-${payout.batchKey}`,
      reversalTransactionId: null,
    });
    expect(payout.id).toMatch(/^po_/);
    expect(paypal.createPayoutBatch).toHaveBeenCalledTimes(1);
    expect(paypal.createPayoutBatch).toHaveBeenCalledWith({
      senderBatchId: payout.batchKey,
      requestId: payout.batchKey,
      emailSubject: expect.any(String),
      emailMessage: expect.any(String),
      items: [
        {
          receiver: "pub@example.test",
          amount: "1.23",
          currency: "USD",
          note: "BotFare earnings",
          senderItemId: payout.id,
        },
      ],
    });
    expect(await earningsBalanceMicros(db, owner.id)).toBe(4_567);
    expect((await accountBalanceMicros(db, Accounts.paypalClearing)) - clearingBefore).toBe(
      1_230_000,
    );
    expect((await listPayouts(db, owner.id)).map((p) => p.id)).toEqual([payout.id]);
  });

  it("refuses below the minimum or without a payout email, without calling PayPal", async () => {
    const paypal = mockPayPal();
    const small = await publisherWithEarnings(990_000);
    await expectMoneyError(
      requestPayout(db, paypal, { publisherUserId: small.id }),
      "below_minimum",
    );
    const noEmail = await publisherWithEarnings(5_000_000, null);
    await expectMoneyError(
      requestPayout(db, paypal, { publisherUserId: noEmail.id }),
      "no_payout_email",
    );
    expect(paypal.createPayoutBatch).not.toHaveBeenCalled();
    expect(await earningsBalanceMicros(db, small.id)).toBe(990_000);
    expect(await earningsBalanceMicros(db, noEmail.id)).toBe(5_000_000);
  });

  it("reverses exactly once when PayPal refuses the batch", async () => {
    const paypal = mockPayPal();
    const owner = await publisherWithEarnings(2_500_000);
    paypal.createPayoutBatch.mockRejectedValueOnce(
      payPalError(422, "UNPROCESSABLE_ENTITY", "INSUFFICIENT_FUNDS"),
    );
    const payout = await requestPayout(db, paypal, { publisherUserId: owner.id });
    expect(payout.status).toBe("failed");
    expect(payout.error).toContain("INSUFFICIENT_FUNDS");
    expect(payout.reversalTransactionId).not.toBeNull();
    expect(await earningsBalanceMicros(db, owner.id)).toBe(2_500_000);

    // Syncing a failed payout neither resubmits nor reverses again.
    await syncPayout(db, paypal, payout.id);
    expect(paypal.createPayoutBatch).toHaveBeenCalledTimes(1);
    expect(await reversalCount(payout.id)).toBe(1);
    expect(await earningsBalanceMicros(db, owner.id)).toBe(2_500_000);
  });

  it("stays pending on an indeterminate failure and retries with the same batch key", async () => {
    const paypal = mockPayPal();
    const owner = await publisherWithEarnings(3_000_000);
    paypal.createPayoutBatch.mockRejectedValueOnce(payPalError(503, "SERVICE_UNAVAILABLE"));
    const payout = await requestPayout(db, paypal, { publisherUserId: owner.id });
    expect(payout).toMatchObject({ status: "pending", paypalBatchId: null });
    expect(payout.error).toContain("SERVICE_UNAVAILABLE");
    expect(await earningsBalanceMicros(db, owner.id)).toBe(0);

    paypal.createPayoutBatch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await syncPayout(db, paypal, payout.id))?.status).toBe("pending");

    const synced = await syncPayout(db, paypal, payout.id);
    expect(synced).toMatchObject({ status: "pending", paypalBatchId: `PB-${payout.batchKey}` });
    expect(synced?.error).toBeNull();
    expect(paypal.createPayoutBatch).toHaveBeenCalledTimes(3);
    for (const [call] of paypal.createPayoutBatch.mock.calls) {
      expect(call.senderBatchId).toBe(payout.batchKey);
      expect(call.requestId).toBe(payout.batchKey);
      expect(call.items).toEqual([expect.objectContaining({ senderItemId: payout.id })]);
    }
    expect(await reversalCount(payout.id)).toBe(0);
  });
});

describe("runDailyPayouts", () => {
  it("pays every eligible publisher in one batch and skips those without an email", async () => {
    const paypal = mockPayPal();
    // A high minimum keeps other tests' publishers out of this run.
    const minimumCents = 90_000;
    const a = await publisherWithEarnings(900_000_000, "a@example.test");
    const b = await publisherWithEarnings(1_000_005_000, "b@example.test");
    const c = await publisherWithEarnings(950_000_000, "c@example.test");
    const noEmail = await publisherWithEarnings(990_000_000, null);
    const small = await publisherWithEarnings(10_000_000, "small@example.test");

    const run = await runDailyPayouts(db, paypal, { minimumCents });
    expect(run.batchKey).toMatch(/^botfare-daily-/);
    expect(paypal.createPayoutBatch).toHaveBeenCalledTimes(1);
    const [call] = paypal.createPayoutBatch.mock.calls[0] ?? [];
    expect(call?.senderBatchId).toBe(run.batchKey);
    expect(new Set(run.payouts.map((p) => p.publisherUserId))).toEqual(new Set([a.id, b.id, c.id]));
    expect(call?.items).toHaveLength(3);
    expect(Object.fromEntries((call?.items ?? []).map((i) => [i.receiver, i.amount]))).toEqual({
      "a@example.test": "900.00",
      "b@example.test": "1000.00",
      "c@example.test": "950.00",
    });
    expect(run.payouts.every((p) => p.batchKey === run.batchKey)).toBe(true);
    expect(run.skippedNoEmail).toContain(noEmail.id);
    expect(await earningsBalanceMicros(db, b.id)).toBe(5_000);
    expect(await earningsBalanceMicros(db, small.id)).toBe(10_000_000);
    expect(await earningsBalanceMicros(db, noEmail.id)).toBe(990_000_000);

    // Nothing left to pay: no second batch.
    const again = await runDailyPayouts(db, paypal, { minimumCents });
    expect(again).toMatchObject({ batchKey: null, payouts: [] });
    expect(paypal.createPayoutBatch).toHaveBeenCalledTimes(1);
  });
});

describe("syncPayout", () => {
  it.each(["UNCLAIMED", "RETURNED"])("reverses a %s item exactly once", async (status) => {
    const paypal = mockPayPal();
    const owner = await publisherWithEarnings(4_000_000);
    const payout = await requestPayout(db, paypal, { publisherUserId: owner.id });
    const input = paypal.createPayoutBatch.mock.calls[0]?.[0] as CreatePayoutBatchInput;
    paypal.getPayoutBatch.mockResolvedValue(batchWithItem(input, status));

    const first = await syncPayout(db, paypal, payout.id);
    expect(first).toMatchObject({
      status: status.toLowerCase(),
      paypalItemId: `ITEM-0-${payout.id}`,
    });
    expect(await earningsBalanceMicros(db, owner.id)).toBe(4_000_000);
    await syncPayout(db, paypal, payout.id);
    // Not open any more, so the bulk sync skips it.
    await syncPendingPayouts(db, paypal);
    expect(await reversalCount(payout.id)).toBe(1);
    expect(await earningsBalanceMicros(db, owner.id)).toBe(4_000_000);
  });

  it("marks a paid item as success without moving money", async () => {
    const paypal = mockPayPal();
    const owner = await publisherWithEarnings(1_500_000);
    const payout = await requestPayout(db, paypal, { publisherUserId: owner.id });
    const input = paypal.createPayoutBatch.mock.calls[0]?.[0] as CreatePayoutBatchInput;
    paypal.getPayoutBatch.mockResolvedValue(batchWithItem(input, "SUCCESS"));
    expect((await syncPayout(db, paypal, payout.id))?.status).toBe("success");
    expect(await earningsBalanceMicros(db, owner.id)).toBe(0);
    expect(await reversalCount(payout.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("webhooks", () => {
  it("dedupes by event ID", async () => {
    const paypal = mockPayPal();
    const { owner, orderId } = await topUpOrder(paypal);
    const event = captureCompletedEvent(orderId);
    expect((await handlePayPalWebhookEvent(db, paypal, event)).status).toBe("processed");
    expect(await handlePayPalWebhookEvent(db, paypal, event)).toMatchObject({
      status: "duplicate",
      eventId: event.id,
    });
    const rows = await db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.paypalEventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "processed",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceId: `CAP-${orderId}`,
    });
    expect(await walletBalanceMicros(db, owner.id)).toBe(10_000_000);
  });

  it("ignores unknown event types and orders that are not ours", async () => {
    const paypal = mockPayPal();
    const other = await handlePayPalWebhookEvent(db, paypal, {
      id: `WH-${crypto.randomUUID()}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: { id: "PP-D-1" },
    });
    expect(other.status).toBe("ignored");
    const foreign = await handlePayPalWebhookEvent(
      db,
      paypal,
      captureCompletedEvent("ORDER-NOT-OURS"),
    );
    expect(foreign.status).toBe("ignored");
    expect(await handlePayPalWebhookEvent(db, paypal, { nope: true })).toMatchObject({
      status: "failed",
      retryable: false,
    });
  });

  it("updates payout items and reverses failures once", async () => {
    const paypal = mockPayPal();
    const owner = await publisherWithEarnings(2_000_000);
    const payout = await requestPayout(db, paypal, { publisherUserId: owner.id });
    const itemEvent = (status: string) => ({
      id: `WH-${crypto.randomUUID()}`,
      event_type: `PAYMENT.PAYOUTS-ITEM.${status}`,
      resource: {
        payout_item_id: `ITEM-${payout.id}`,
        transaction_id: `TXN-${payout.id}`,
        transaction_status: status,
        payout_batch_id: payout.paypalBatchId,
        payout_item: {
          sender_item_id: payout.id,
          receiver: "pub@example.test",
          amount: { value: "2.00", currency: "USD" },
        },
        ...(status === "UNCLAIMED" && {
          errors: { name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered" },
        }),
      },
    });

    const batchEvent = {
      id: `WH-${crypto.randomUUID()}`,
      event_type: "PAYMENT.PAYOUTSBATCH.PROCESSING",
      resource: {
        batch_header: {
          payout_batch_id: payout.paypalBatchId,
          batch_status: "PROCESSING",
          sender_batch_header: { sender_batch_id: payout.batchKey },
        },
      },
    };
    expect((await handlePayPalWebhookEvent(db, paypal, batchEvent)).status).toBe("processed");
    expect((await getPayout(db, payout.id))?.status).toBe("processing");

    expect((await handlePayPalWebhookEvent(db, paypal, itemEvent("UNCLAIMED"))).status).toBe(
      "processed",
    );
    const unclaimed = await getPayout(db, payout.id);
    expect(unclaimed).toMatchObject({
      status: "unclaimed",
      paypalItemId: `ITEM-${payout.id}`,
      paypalTransactionId: `TXN-${payout.id}`,
    });
    expect(unclaimed?.error).toContain("RECEIVER_UNREGISTERED");
    expect(await earningsBalanceMicros(db, owner.id)).toBe(2_000_000);

    await handlePayPalWebhookEvent(db, paypal, itemEvent("RETURNED"));
    expect((await getPayout(db, payout.id))?.status).toBe("returned");
    expect(await reversalCount(payout.id)).toBe(1);
    expect(await earningsBalanceMicros(db, owner.id)).toBe(2_000_000);
  });

  it("reverses every open item of a denied batch", async () => {
    const paypal = mockPayPal();
    const owner = await publisherWithEarnings(1_000_000);
    const payout = await requestPayout(db, paypal, { publisherUserId: owner.id });
    const result = await handlePayPalWebhookEvent(db, paypal, {
      id: `WH-${crypto.randomUUID()}`,
      event_type: "PAYMENT.PAYOUTSBATCH.DENIED",
      resource: {
        batch_header: {
          payout_batch_id: payout.paypalBatchId,
          batch_status: "DENIED",
          sender_batch_header: { sender_batch_id: payout.batchKey },
        },
      },
    });
    expect(result.status).toBe("processed");
    expect((await getPayout(db, payout.id))?.status).toBe("failed");
    expect(await earningsBalanceMicros(db, owner.id)).toBe(1_000_000);
    expect(await reversalCount(payout.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("dashboard read models", () => {
  it("summarises a publisher's earnings and receipts with site and key names", async () => {
    const { owner, site } = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });
    const ledger = new PostgresPrepaidLedger(db);
    for (let i = 0; i < 3; i++) {
      const res = await ledger.charge(chargeRequest(agent.key.id, site.id));
      expect(res.ok).toBe(true);
    }

    const summary = await publisherSummary(db, owner.id);
    expect(summary).toMatchObject({
      earningsMicros: 3 * 28_500,
      lifetimeEarningsMicros: 3 * 28_500,
      paidRequests: 3,
      payoutEmail: null,
      payouts: [],
    });
    expect(summary.sites).toEqual([
      expect.objectContaining({ id: site.id, paidRequests: 3, earningsMicros: 85_500 }),
    ]);

    const rows = await receiptsForPublisher(db, owner.id, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      siteName: "Brewlab Demo",
      agentKeyName: "research agent",
      amountCents: 3,
      netMicros: 28_500,
    });
    expect(
      await receiptsForPublisher(db, owner.id, { since: new Date(Date.now() + 60_000) }),
    ).toEqual([]);

    const wallet = await walletSummary(db, agent.owner.id);
    expect(wallet).toMatchObject({ balanceMicros: 1_000_000 - 90_000, spendTodayMicros: 90_000 });
  });
});
