/**
 * Dispute-window payout hold: a fare's earnings stay clearing while an agent can still dispute
 * it (DISPUTE_POLICY.windowHours) and while a dispute on it is undecided, so Withdraw and the
 * daily run pay only what is available and a later Fare Court refund still finds the money.
 */
import { DISPUTE_POLICY } from "@botfare/contracts/fare";
import type { CreatePayoutBatchResult, PayPalClient } from "@botfare/paypal";
import { centsToMicros } from "@botfare/x402-paypal";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type DisputeRowStatus,
  earningsBalanceMicros,
  MoneyFlowError,
  PostgresPrepaidLedger,
  platformFeeMicros,
  publisherEarningsSplit,
  publisherSummary,
  refundReceipt,
  requestPayout,
  resetDemoPublisher,
  runDailyPayouts,
  schema,
  setPayoutEmail,
} from "../src";
import {
  chargeRequest,
  expectLedgerHealthy,
  makeAgent,
  makePublisher,
  openTestDb,
} from "./helpers";

const { db, close } = openTestDb();
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

const HOUR_MS = 3_600_000;
const WINDOW_MS = DISPUTE_POLICY.windowHours * HOUR_MS;

function mockPayPal() {
  return {
    createPayoutBatch: vi.fn<PayPalClient["createPayoutBatch"]>(
      async (input): Promise<CreatePayoutBatchResult> => ({
        batchId: `PB-${input.senderBatchId}`,
        batchStatus: "PENDING",
      }),
    ),
  };
}

/** The publisher's share of a fare of `cents`. */
function net(cents: number): number {
  const micros = centsToMicros(cents);
  return micros - platformFeeMicros(micros);
}

type Publisher = Awaited<ReturnType<typeof makePublisher>>;
type Agent = Awaited<ReturnType<typeof makeAgent>>;

async function publisherWithEmail(): Promise<Publisher> {
  const publisher = await makePublisher(db);
  await setPayoutEmail(db, {
    userId: publisher.owner.id,
    email: `${publisher.owner.id.replaceAll("_", "-")}@example.test`,
  });
  return publisher;
}

/** One settled fare of `cents`, bought at `at`. Returns the receipt ID. */
async function fare(agent: Agent, publisher: Publisher, cents: number, at: Date): Promise<string> {
  const ledger = new PostgresPrepaidLedger(db, { now: () => at });
  const res = await ledger.charge(
    chargeRequest(agent.key.id, publisher.site.id, { amountCents: cents }),
  );
  if (!res.ok) throw new Error(`charge failed: ${res.reason}`);
  return res.transaction;
}

/** A dispute on the receipt in `status` (filed while the fare was in its window). */
async function disputeOn(
  agent: Agent,
  publisher: Publisher,
  receiptId: string,
  status: DisputeRowStatus,
) {
  const id = `dsp_hold_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.insert(schema.disputes).values({
    id,
    receiptId,
    agentKeyId: agent.key.id,
    ownerUserId: agent.owner.id,
    siteId: publisher.site.id,
    publisherUserId: publisher.owner.id,
    reason: "stub_or_paywall",
    contentDigestOk: true,
    status,
  });
  return id;
}

async function moneyError(promise: Promise<unknown>): Promise<MoneyFlowError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MoneyFlowError);
  return err as MoneyFlowError;
}

describe("publisherEarningsSplit", () => {
  it("counts fares inside the dispute window as clearing and says when the oldest clears", async () => {
    const now = new Date();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 2_000 });
    await fare(agent, publisher, 200, new Date(now.getTime() - WINDOW_MS - HOUR_MS));
    const edge = new Date(now.getTime() - WINDOW_MS); // Fare Court still accepts a dispute here
    await fare(agent, publisher, 100, edge);
    const freshAt = new Date(now.getTime() - HOUR_MS);
    await fare(agent, publisher, 300, freshAt);

    const split = await publisherEarningsSplit(db, publisher.owner.id, now);
    expect(split).toEqual({
      balanceMicros: net(200) + net(100) + net(300),
      clearingMicros: net(100) + net(300),
      availableMicros: net(200),
      nextReleaseAt: new Date(edge.getTime() + WINDOW_MS),
    });

    // A fare matures exactly one window after it settled.
    const later = await publisherEarningsSplit(db, publisher.owner.id, new Date(now.getTime() + 1));
    expect(later).toMatchObject({ clearingMicros: net(300), availableMicros: net(200) + net(100) });

    // The dashboard reads the split at the current time (the edge fare has matured by now).
    const summary = await publisherSummary(db, publisher.owner.id);
    expect(summary).toMatchObject({
      earningsMicros: split.balanceMicros,
      clearingMicros: net(300),
      availableMicros: net(200) + net(100),
      nextReleaseAt: new Date(freshAt.getTime() + WINDOW_MS),
    });
  });

  it("excludes refunded fares", async () => {
    const now = new Date();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 1_000 });
    await fare(agent, publisher, 200, new Date(now.getTime() - 2 * WINDOW_MS));
    const fresh = await fare(agent, publisher, 300, new Date(now.getTime() - HOUR_MS));
    const refunded = await refundReceipt(db, { receiptId: fresh, siteId: publisher.site.id });
    expect(refunded.ok).toBe(true);

    expect(await publisherEarningsSplit(db, publisher.owner.id, now)).toEqual({
      balanceMicros: net(200),
      clearingMicros: 0,
      availableMicros: net(200),
      nextReleaseAt: null,
    });
  });

  it("holds an old fare while its dispute is undecided, whatever its age", async () => {
    const now = new Date();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 1_000 });
    const old = new Date(now.getTime() - 3 * WINDOW_MS);
    const pending = await fare(agent, publisher, 300, old);
    const judging = await fare(agent, publisher, 200, old);
    await fare(agent, publisher, 150, old);
    const pendingDispute = await disputeOn(agent, publisher, pending, "pending_publisher");
    await disputeOn(agent, publisher, judging, "open");

    expect(await publisherEarningsSplit(db, publisher.owner.id, now)).toEqual({
      balanceMicros: net(300) + net(200) + net(150),
      clearingMicros: net(300) + net(200),
      availableMicros: net(150),
      // Disputed fares wait for a decision, not for the clock.
      nextReleaseAt: null,
    });

    await db
      .update(schema.disputes)
      .set({ status: "rejected_by_publisher", decidedAt: now, decidedBy: "publisher" })
      .where(eq(schema.disputes.id, pendingDispute));
    expect(await publisherEarningsSplit(db, publisher.owner.id, now)).toMatchObject({
      clearingMicros: net(200),
      availableMicros: net(300) + net(150),
    });
  });
});

describe("payouts pay only available earnings", () => {
  it("never pays a fresh fare, pays a mature one, and leaves the fresh one refundable", async () => {
    const now = new Date();
    const paypal = mockPayPal();
    const publisher = await publisherWithEmail();
    const agent = await makeAgent(db, { balanceCents: 2_000 });
    await fare(agent, publisher, 200, new Date(now.getTime() - WINDOW_MS - HOUR_MS));
    const freshAt = new Date(now.getTime() - 10 * 60_000);
    const fresh = await fare(agent, publisher, 300, freshAt);

    const payout = await requestPayout(db, paypal, { publisherUserId: publisher.owner.id, now });
    expect(payout.amountCents).toBe(190);
    expect(paypal.createPayoutBatch.mock.calls[0]?.[0].items[0]?.amount).toBe("1.90");
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(net(300));

    // Withdrawing again finds only the clearing fare.
    const err = await moneyError(
      requestPayout(db, paypal, { publisherUserId: publisher.owner.id, now }),
    );
    expect(err.code).toBe("below_minimum");
    expect(err.message).toBe(
      `$2.85 is still clearing (${DISPUTE_POLICY.windowHours}-hour dispute window); available now: $0.00. Payouts start at $1.00`,
    );
    expect(paypal.createPayoutBatch).toHaveBeenCalledTimes(1);

    // An agent disputes the fresh fare after the withdrawal: the refund still finds the money.
    const refund = await refundReceipt(db, { receiptId: fresh, siteId: publisher.site.id });
    expect(refund).toMatchObject({ ok: true, alreadyRefunded: false });
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(0);
  });

  it("pays a fare once its window has passed", async () => {
    const now = new Date();
    const paypal = mockPayPal();
    const publisher = await publisherWithEmail();
    const agent = await makeAgent(db, { balanceCents: 1_000 });
    const at = new Date(now.getTime() - HOUR_MS);
    await fare(agent, publisher, 300, at);

    await moneyError(requestPayout(db, paypal, { publisherUserId: publisher.owner.id, now }));
    const later = new Date(at.getTime() + WINDOW_MS + 1);
    const payout = await requestPayout(db, paypal, {
      publisherUserId: publisher.owner.id,
      now: later,
    });
    expect(payout.amountCents).toBe(285);
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(0);
  });

  it("holds an old fare with a dispute waiting for the publisher", async () => {
    const now = new Date();
    const paypal = mockPayPal();
    const publisher = await publisherWithEmail();
    const agent = await makeAgent(db, { balanceCents: 1_000 });
    const old = new Date(now.getTime() - 2 * WINDOW_MS);
    const disputed = await fare(agent, publisher, 300, old);
    await fare(agent, publisher, 150, old);
    await disputeOn(agent, publisher, disputed, "pending_publisher");

    const payout = await requestPayout(db, paypal, { publisherUserId: publisher.owner.id, now });
    expect(payout.amountCents).toBe(142); // net(150) = 142.5¢; the half cent stays
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(net(300) + 5_000);
    // The publisher can still accept the refund.
    const refund = await refundReceipt(db, { receiptId: disputed, siteId: publisher.site.id });
    expect(refund.ok).toBe(true);
  });

  it("applies the minimum to available earnings, not to the balance", async () => {
    const now = new Date();
    const paypal = mockPayPal();
    const publisher = await publisherWithEmail();
    const agent = await makeAgent(db, { balanceCents: 1_000 });
    await fare(agent, publisher, 50, new Date(now.getTime() - 2 * WINDOW_MS));
    await fare(agent, publisher, 300, new Date(now.getTime() - HOUR_MS));
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBeGreaterThan(centsToMicros(100));

    const err = await moneyError(
      requestPayout(db, paypal, { publisherUserId: publisher.owner.id, now }),
    );
    expect(err.code).toBe("below_minimum");
    expect(err.message).toBe(
      `$2.85 is still clearing (${DISPUTE_POLICY.windowHours}-hour dispute window); available now: $0.47. Payouts start at $1.00`,
    );
    expect(paypal.createPayoutBatch).not.toHaveBeenCalled();
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(net(50) + net(300));
  });

  it("the daily run pays only available amounts and reports what is still clearing", async () => {
    const now = new Date();
    const paypal = mockPayPal();
    // A high minimum keeps other tests' publishers out of this run.
    const minimumCents = 500_000;
    const big = 600_000; // $6,000 fares: $5,700 to the publisher
    const agent = await makeAgent(db, { balanceCents: 6 * big });
    const old = new Date(now.getTime() - 2 * WINDOW_MS);
    const freshAt = new Date(now.getTime() - HOUR_MS);

    const mixed = await publisherWithEmail(); // one mature, one fresh
    await fare(agent, mixed, big, old);
    await fare(agent, mixed, big, freshAt);
    const onlyFresh = await publisherWithEmail();
    await fare(agent, onlyFresh, big, freshAt);
    const disputed = await publisherWithEmail(); // one mature, one mature but disputed
    await fare(agent, disputed, big, old);
    const held = await fare(agent, disputed, big, old);
    await disputeOn(agent, disputed, held, "pending_publisher");

    const run = await runDailyPayouts(db, paypal, { minimumCents, now });
    const mine = new Set([mixed.owner.id, onlyFresh.owner.id, disputed.owner.id]);
    const paid = Object.fromEntries(
      run.payouts
        .filter((p) => mine.has(p.publisherUserId))
        .map((p) => [p.publisherUserId, p.amountCents]),
    );
    expect(paid).toEqual({ [mixed.owner.id]: 570_000, [disputed.owner.id]: 570_000 });
    expect(paypal.createPayoutBatch).toHaveBeenCalledTimes(1);

    const clearing = Object.fromEntries(
      run.clearing.filter((c) => mine.has(c.publisherUserId)).map((c) => [c.publisherUserId, c]),
    );
    expect(clearing[mixed.owner.id]).toMatchObject({
      payoutId: expect.stringMatching(/^po_/),
      clearingMicros: net(big),
      nextReleaseAt: new Date(freshAt.getTime() + WINDOW_MS),
    });
    expect(clearing[onlyFresh.owner.id]).toMatchObject({
      payoutId: null,
      clearingMicros: net(big),
      availableMicros: 0,
    });
    expect(clearing[disputed.owner.id]).toMatchObject({
      clearingMicros: net(big),
      nextReleaseAt: null,
    });
    for (const publisher of [mixed, onlyFresh, disputed]) {
      expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(net(big));
    }

    // Nothing more is available today.
    const again = await runDailyPayouts(db, paypal, { minimumCents, now });
    expect(again.payouts.filter((p) => mine.has(p.publisherUserId))).toEqual([]);
  });
});

describe("demo earnings floor", () => {
  it("tops up to the floor of available earnings, ignoring fares still clearing", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 1_000 });
    await fare(agent, publisher, 300, new Date(Date.now() - HOUR_MS));
    const reset = await resetDemoPublisher(db, {
      userId: publisher.owner.id,
      payoutEmail: null,
      earningsFloorCents: 200,
    });
    expect(reset.earningsAddedCents).toBe(200);
    expect(await publisherEarningsSplit(db, publisher.owner.id)).toMatchObject({
      clearingMicros: net(300),
      availableMicros: centsToMicros(200),
    });
  });
});
