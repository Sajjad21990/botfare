import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createAgentKey,
  earningsBalanceMicros,
  getReceipt,
  PostgresPrepaidLedger,
  refundReceipt,
  revokeAgentKey,
  walletBalanceMicros,
} from "../src";
import {
  chargeRequest,
  expectLedgerHealthy,
  makeAgent,
  makePublisher,
  openTestDb,
} from "./helpers";

const { db, close } = openTestDb();
const ledger = new PostgresPrepaidLedger(db);
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

describe("PostgresPrepaidLedger.charge", () => {
  it("debits the wallet and splits 95/5 between publisher and BotFare", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });
    const request = chargeRequest(agent.key.id, publisher.site.id);

    expect(await ledger.check(request)).toEqual({ ok: true });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);

    const result = await ledger.charge(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction).toMatch(/^rcpt_/);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(970_000);
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(28_500);

    const receipt = await getReceipt(db, result.transaction);
    expect(receipt).toMatchObject({
      agentKeyId: agent.key.id,
      ownerUserId: agent.owner.id,
      siteId: publisher.site.id,
      publisherUserId: publisher.owner.id,
      resourceUrl: request.resourceUrl,
      amountCents: 3,
      amountMicros: 30_000,
      feeMicros: 1_500,
      nonce: request.nonce,
      status: "settled",
      refundTransactionId: null,
    });
  });

  it("refuses a replayed nonce and names the original receipt", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });
    const request = chargeRequest(agent.key.id, publisher.site.id);
    const first = await ledger.charge(request);
    if (!first.ok) throw new Error("first charge failed");

    const expected = {
      ok: false,
      reason: "invalid_prepaid_nonce_used",
      originalTransaction: first.transaction,
    };
    expect(await ledger.check(request)).toMatchObject(expected);
    expect(await ledger.charge(request)).toMatchObject(expected);
    const [a, b] = await Promise.all([ledger.charge(request), ledger.charge(request)]);
    expect(a).toMatchObject(expected);
    expect(b).toMatchObject(expected);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(970_000);
  });

  it("enforces per-request max, daily cap and allowed sites", async () => {
    const publisher = await makePublisher(db);
    const other = await makePublisher(db);
    const agent = await makeAgent(db, {
      balanceCents: 100,
      perRequestMaxCents: 5,
      dailyCapCents: 6,
      allowedSiteIds: [publisher.site.id],
    });

    expect(
      await ledger.charge(chargeRequest(agent.key.id, publisher.site.id, { amountCents: 6 })),
    ).toMatchObject({ ok: false, reason: "invalid_prepaid_over_per_request_max" });
    expect(await ledger.charge(chargeRequest(agent.key.id, other.site.id))).toMatchObject({
      ok: false,
      reason: "invalid_prepaid_site_not_allowed",
    });
    expect(await ledger.charge(chargeRequest(agent.key.id, "site_missing"))).toMatchObject({
      ok: false,
      reason: "invalid_prepaid_site_not_allowed",
    });

    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    const third = chargeRequest(agent.key.id, publisher.site.id);
    expect(await ledger.check(third)).toMatchObject({ reason: "invalid_prepaid_over_daily_cap" });
    expect(await ledger.charge(third)).toMatchObject({ reason: "invalid_prepaid_over_daily_cap" });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(940_000);
  });

  it("counts only today's settled receipts toward the daily cap (UTC)", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100, dailyCapCents: 3 });
    const yesterday = new PostgresPrepaidLedger(db, {
      now: () => new Date(Date.now() - 24 * 3600 * 1000),
    });
    expect((await yesterday.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    const today = await ledger.charge(chargeRequest(agent.key.id, publisher.site.id));
    expect(today.ok).toBe(true);
    expect(await ledger.check(chargeRequest(agent.key.id, publisher.site.id))).toMatchObject({
      reason: "invalid_prepaid_over_daily_cap",
    });
    if (!today.ok) return;
    // A refunded receipt frees its share of the cap again.
    await refundReceipt(db, { receiptId: today.transaction, siteId: publisher.site.id });
    expect(await ledger.check(chargeRequest(agent.key.id, publisher.site.id))).toEqual({
      ok: true,
    });
  });

  it("refuses unknown and revoked keys", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });
    expect(await ledger.charge(chargeRequest("ak_missing", publisher.site.id))).toMatchObject({
      reason: "invalid_prepaid_unknown_key",
    });
    expect((await ledger.getAgentKey(agent.key.id))?.status).toBe("active");
    await revokeAgentKey(db, { keyId: agent.key.id });
    expect((await ledger.getAgentKey(agent.key.id))?.status).toBe("revoked");
    expect(await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).toMatchObject({
      reason: "invalid_prepaid_key_revoked",
    });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);
  });

  it("refuses when the wallet is too low", async () => {
    const publisher = await makePublisher(db);
    const empty = await makeAgent(db);
    expect(await ledger.charge(chargeRequest(empty.key.id, publisher.site.id))).toMatchObject({
      reason: "insufficient_funds",
    });
    const poor = await makeAgent(db, { balanceCents: 2 });
    expect(await ledger.check(chargeRequest(poor.key.id, publisher.site.id))).toMatchObject({
      reason: "insufficient_funds",
    });
    expect(await walletBalanceMicros(db, poor.owner.id)).toBe(20_000);
  });
});

describe("concurrency", () => {
  it("20 simultaneous charges against a wallet that affords 10: exactly 10 succeed", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 30 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ledger.charge(chargeRequest(agent.key.id, publisher.site.id)),
      ),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(10);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(
      Array(10).fill("insufficient_funds"),
    );
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(0);
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(10 * 28_500);
  });

  it("two keys sharing one wallet cannot overdraw it together", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 15 });
    const second = await createAgentKey(db, {
      ownerUserId: agent.owner.id,
      name: "second agent",
      publicJwk: agent.keys.publicJwk,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        ledger.charge(chargeRequest(i % 2 ? agent.key.id : second.id, publisher.site.id)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(0);
  });

  it("holds the daily cap under concurrent charges", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 1_000, dailyCapCents: 30 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ledger.charge(chargeRequest(agent.key.id, publisher.site.id)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(
      results.filter((r) => !r.ok && r.reason === "invalid_prepaid_over_daily_cap"),
    ).toHaveLength(10);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(9_700_000);
  });
});

describe("refundReceipt", () => {
  it("reverses a receipt exactly once, only for its own site", async () => {
    const publisher = await makePublisher(db);
    const other = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });
    const charged = await ledger.charge(chargeRequest(agent.key.id, publisher.site.id));
    if (!charged.ok) throw new Error("charge failed");

    expect(
      await refundReceipt(db, { receiptId: charged.transaction, siteId: other.site.id }),
    ).toMatchObject({ ok: false, reason: "not_found" });

    const [a, b] = await Promise.all([
      refundReceipt(db, { receiptId: charged.transaction, siteId: publisher.site.id }),
      refundReceipt(db, { receiptId: charged.transaction, siteId: publisher.site.id }),
    ]);
    if (!a.ok || !b.ok) throw new Error("refund failed");
    expect([a.alreadyRefunded, b.alreadyRefunded].sort()).toEqual([false, true]);
    expect(a.refundTransactionId).toBe(b.refundTransactionId);
    expect(a.receipt.status).toBe("refunded");

    const again = await refundReceipt(db, {
      receiptId: charged.transaction,
      siteId: publisher.site.id,
    });
    expect(again).toMatchObject({ ok: true, alreadyRefunded: true });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(0);
  });
});
