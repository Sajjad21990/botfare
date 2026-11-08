import { DEMO_PERSONAS, DEMO_SITE_NAME, DEMO_SITE_PRICING } from "@botfare/contracts";
import { contentDigestSha256, type DisputeVerdict } from "@botfare/contracts/fare";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  applyVerdict,
  attestReceipt,
  createAgentKey,
  createSite,
  createUser,
  DEMO_WALLET_FLOOR_CENTS,
  ensureDemoPendingDispute,
  ensureDemoWalletFloor,
  getUserByEmail,
  listDisputesForPublisher,
  openDispute,
  PostgresPrepaidLedger,
  pendingDisputeCount,
  publisherDecide,
  resetDemoPublisher,
  seedWallet,
  updateAgentKeyLimits,
  walletBalanceMicros,
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
const ledger = new PostgresPrepaidLedger(db);
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

describe("ensureDemoWalletFloor", () => {
  it("tops the shared agent wallet back up to the floor, once per change, even concurrently", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: DEMO_WALLET_FLOOR_CENTS });
    const floor = DEMO_WALLET_FLOOR_CENTS * 10_000;
    expect(await ensureDemoWalletFloor(db, { userId: agent.owner.id })).toEqual({ addedCents: 0 });

    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(floor - 30_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureDemoWalletFloor(db, { userId: agent.owner.id })),
    );
    expect(results.reduce((sum, r) => sum + r.addedCents, 0)).toBe(3);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(floor);

    // The next charge allows the next top-up, back to the same balance.
    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    expect(await ensureDemoWalletFloor(db, { userId: agent.owner.id })).toEqual({ addedCents: 3 });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(floor);
  });

  it("starts an empty wallet at the floor", async () => {
    const agent = await makeAgent(db);
    expect(await ensureDemoWalletFloor(db, { userId: agent.owner.id, floorCents: 250 })).toEqual({
      addedCents: 250,
    });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(2_500_000);
  });
});

describe("updateAgentKeyLimits", () => {
  it("raises a key's daily cap in place; the facilitator applies it on the next charge", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, {
      balanceCents: 100,
      perRequestMaxCents: 10,
      dailyCapCents: 3,
    });
    expect((await ledger.charge(chargeRequest(agent.key.id, publisher.site.id))).ok).toBe(true);
    const over = chargeRequest(agent.key.id, publisher.site.id);
    expect(await ledger.check(over)).toMatchObject({ reason: "invalid_prepaid_over_daily_cap" });

    const updated = await updateAgentKeyLimits(db, {
      keyId: agent.key.id,
      perRequestMaxCents: 10,
      dailyCapCents: 1_000,
    });
    expect(updated).toMatchObject({ id: agent.key.id, dailyCapCents: 1_000, status: "active" });
    expect((await ledger.charge(over)).ok).toBe(true);
    expect(
      await updateAgentKeyLimits(db, {
        keyId: "ak_missing",
        perRequestMaxCents: 1,
        dailyCapCents: 1,
      }),
    ).toBeNull();
  });
});

describe("ensureDemoPendingDispute", () => {
  const STUB = "<html><body><h1>Grinder care</h1><p>Subscribe to keep reading.</p></body></html>";
  const OFFER = { title: "Grinder care, step by step", preview: "Clean the burrs, then..." };
  const UNSURE: DisputeVerdict = {
    decision: "refund",
    confidence: 0.72,
    category: "stub_or_paywall",
    rationale: "The summary matches, the steps are missing.",
    evidence: [],
  };

  async function personaAgent() {
    const { email, name } = DEMO_PERSONAS.agentOwner;
    const owner = (await getUserByEmail(db, email)) ?? (await createUser(db, { email, name }));
    const key = await createAgentKey(db, {
      ownerUserId: owner.id,
      name: `Research agent ${crypto.randomUUID().slice(0, 6)}`,
      publicJwk: (await generateAgentKeyPair()).publicJwk,
    });
    await seedWallet(db, {
      ownerUserId: owner.id,
      cents: 100,
      idempotencyKey: `test:demo-pending:${key.id}`,
    });
    return { owner, key };
  }

  /** A demo-site purchase of the stub, attested and disputed, with the scripted 72% verdict. */
  async function pendingDispute(keyId: string, siteId: string, origin: string) {
    const charged = await ledger.charge({
      ...chargeRequest(keyId, siteId, { resourceUrl: `${origin}/articles/grinder-care` }),
      extra: { botfareOffer: OFFER },
    });
    if (!charged.ok) throw new Error(charged.reason);
    await attestReceipt(db, {
      siteId,
      receiptId: charged.transaction,
      attestation: {
        contentDigest: await contentDigestSha256(STUB),
        contentLength: STUB.length,
        contentType: "text/html; charset=utf-8",
        status: 200,
      },
    });
    const opened = await openDispute(db, {
      agentKeyId: keyId,
      request: {
        receiptId: charged.transaction,
        reason: "stub_or_paywall",
        note: "Got the subscribe wall",
        contentBase64: Buffer.from(STUB).toString("base64"),
      },
    });
    if (!opened.ok) throw new Error(opened.reason);
    const applied = await applyVerdict(db, { disputeId: opened.dispute.id, verdict: UNSURE });
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.outcome.status).toBe("pending_publisher");
    return opened.dispute.id;
  }

  async function demoSite() {
    const publisher = await makeUser(db, "publisher");
    const origin = `https://${crypto.randomUUID().slice(0, 8)}.crema-demo.example`;
    const { site } = await createSite(db, {
      ownerUserId: publisher.id,
      name: DEMO_SITE_NAME,
      origin,
      pricing: DEMO_SITE_PRICING,
    });
    return { publisher, site, origin };
  }

  it("puts a case back in review at the next persona sign-in after a judge decided it", async () => {
    const { publisher, site, origin } = await demoSite();
    const agent = await personaAgent();
    const first = await pendingDispute(agent.key.id, site.id, origin);
    expect(await ensureDemoPendingDispute(db, { siteId: site.id })).toMatchObject({
      added: false,
    });

    // A judge accepts the only pending case: the queue is empty.
    const decided = await publisherDecide(db, {
      disputeId: first,
      publisherUserId: publisher.id,
      accept: true,
    });
    expect(decided.ok && decided.outcome.status).toBe("refunded");
    expect(await pendingDisputeCount(db, publisher.id)).toBe(0);

    // The next judge signs in as the publisher persona.
    const before = await walletBalanceMicros(db, agent.owner.id);
    const reset = await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null });
    expect(reset.pendingDisputesAdded).toBe(1);
    expect(await pendingDisputeCount(db, publisher.id)).toBe(1);
    const [again] = await listDisputesForPublisher(db, {
      publisherUserId: publisher.id,
      status: ["pending_publisher"],
    });
    expect(again).toMatchObject({
      reason: "stub_or_paywall",
      note: "Got the subscribe wall",
      contentDigestOk: true,
      deliveredExcerpt: "Grinder care\nSubscribe to keep reading.",
      verdict: UNSURE,
    });
    expect(again?.receiptId).not.toBe(decided.ok ? decided.dispute.receiptId : "");
    // The persona's wallet paid for the replayed purchase, as a live one would.
    expect(before - (await walletBalanceMicros(db, agent.owner.id))).toBe(30_000);

    // Once per decision: another sign-in while it waits adds nothing.
    expect(
      (await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null }))
        .pendingDisputesAdded,
    ).toBe(0);

    // Declining it brings back one more, never a second copy of the same decision.
    if (!again) throw new Error("no replayed dispute");
    await publisherDecide(db, {
      disputeId: again.id,
      publisherUserId: publisher.id,
      accept: false,
    });
    expect((await ensureDemoPendingDispute(db, { siteId: site.id })).added).toBe(true);
    expect((await ensureDemoPendingDispute(db, { siteId: site.id })).added).toBe(false);
    expect(await pendingDisputeCount(db, publisher.id)).toBe(1);
  });

  it("never replays a dispute filed by a real user's key", async () => {
    const { publisher, site, origin } = await demoSite();
    const stranger = await makeAgent(db, { balanceCents: 100 });
    const disputeId = await pendingDispute(stranger.key.id, site.id, origin);
    await publisherDecide(db, { disputeId, publisherUserId: publisher.id, accept: true });
    const before = await walletBalanceMicros(db, stranger.owner.id);
    expect(await ensureDemoPendingDispute(db, { siteId: site.id })).toEqual({
      added: false,
      reason: "no decided demo dispute to play again",
    });
    expect(await walletBalanceMicros(db, stranger.owner.id)).toBe(before);
  });
});
