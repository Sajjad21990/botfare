import { checkLedgerInvariants, refundReceipt } from "@botfare/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as settle } from "../src/app/api/x402/settle/route";
import {
  getPublisherAnalytics,
  listPublisherReceiptRows,
  resourcePath,
} from "../src/lib/server/analytics-receipts";
import { closeDb, getDb } from "../src/lib/server/db";
import { resetFacilitator } from "../src/lib/server/facilitator";
import {
  facilitatorBody,
  makeAgent,
  makePublisher,
  postJson,
  requirementsFor,
  signPayment,
  useTestDatabase,
} from "./helpers";

const SETTLE_URL = "http://botfare.test/api/x402/settle";

type Publisher = Awaited<ReturnType<typeof makePublisher>>;
type Agent = Awaited<ReturnType<typeof makeAgent>>;

/** Pays `publisher` for one request through the real settle route; returns the receipt ID. */
async function pay(agent: Agent, publisher: Publisher, amountCents = 3): Promise<string> {
  const requirements = requirementsFor(publisher.site.id, amountCents);
  const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);
  const res = await settle(postJson(SETTLE_URL, body, publisher.auth));
  const settled = await res.json();
  expect(settled.success).toBe(true);
  return settled.transaction as string;
}

beforeAll(useTestDatabase);
afterEach(async () => {
  expect(await checkLedgerInvariants(getDb())).toMatchObject({ ok: true, totalMicros: 0 });
});
afterAll(async () => {
  resetFacilitator();
  await closeDb();
});

describe("publisher analytics receipts", () => {
  it("returns only the publisher's own receipts, newest first, as dashboard rows", async () => {
    const db = getDb();
    const alice = await makePublisher(db);
    const bob = await makePublisher(db);
    const agent = await makeAgent(db, 100);

    const first = await pay(agent, alice, 3);
    const second = await pay(agent, alice, 5);
    const bobs = await pay(agent, bob, 4);

    const rows = await listPublisherReceiptRows(db, alice.owner.id);
    expect(rows.map((row) => row.receiptId)).toEqual([second, first]);
    expect(rows.map((row) => row.receiptId)).not.toContain(bobs);
    expect(rows[0]).toEqual({
      receiptId: second,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      siteName: alice.site.name,
      path: "/articles/grinders",
      agentKeyId: agent.key.id,
      agentName: "research agent",
      amountUsd: 0.05,
      feeUsd: 0.0025,
      earningsUsd: 0.0475,
      status: "settled",
      detectionSignal: "Demo history (before detection)",
    });

    const bobRows = await listPublisherReceiptRows(db, bob.owner.id);
    expect(bobRows.map((row) => row.receiptId)).toEqual([bobs]);

    // The agent owner is not a publisher and sees nothing, even though their wallet paid.
    expect(await listPublisherReceiptRows(db, agent.owner.id)).toEqual([]);
  });

  it("zeroes earnings on refunded receipts and reports the earnings balance", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);
    const kept = await pay(agent, publisher, 10);
    const refunded = await pay(agent, publisher, 10);
    expect((await refundReceipt(db, { receiptId: refunded, siteId: publisher.site.id })).ok).toBe(
      true,
    );

    const analytics = await getPublisherAnalytics(db, publisher.owner.id);
    expect(analytics.siteCount).toBe(1);
    const byId = new Map(analytics.rows.map((row) => [row.receiptId, row]));
    expect(byId.get(kept)).toMatchObject({ status: "settled", earningsUsd: 0.095 });
    expect(byId.get(refunded)).toMatchObject({
      status: "refunded",
      amountUsd: 0.1,
      earningsUsd: 0,
    });
    expect(analytics.earnings.balanceUsd).toBeCloseTo(0.095, 6);
  });

  it("limits to the newest rows when asked", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);
    await pay(agent, publisher);
    const newest = await pay(agent, publisher);
    const rows = await listPublisherReceiptRows(db, publisher.owner.id, { limit: 1 });
    expect(rows.map((row) => row.receiptId)).toEqual([newest]);
  });
});

describe("resourcePath", () => {
  it("keeps only the path of a resource URL", () => {
    expect(resourcePath("https://crema.example/articles/grinders?ref=x")).toBe(
      "/articles/grinders",
    );
    expect(resourcePath("/api/brew-ratio")).toBe("/api/brew-ratio");
    expect(resourcePath(null)).toBe("(unknown)");
    expect(resourcePath("not a url")).toBe("(unknown)");
  });
});
