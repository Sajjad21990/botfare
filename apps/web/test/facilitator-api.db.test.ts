import { siteAuthHeader } from "@botfare/contracts";
import {
  checkLedgerInvariants,
  earningsBalanceMicros,
  getReceipt,
  walletBalanceMicros,
} from "@botfare/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as health } from "../src/app/api/health/route";
import { GET as siteConfig } from "../src/app/api/sites/[siteId]/config/route";
import { POST as refund } from "../src/app/api/x402/refund/route";
import { POST as settle } from "../src/app/api/x402/settle/route";
import { GET as supported } from "../src/app/api/x402/supported/route";
import { POST as verify } from "../src/app/api/x402/verify/route";
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

const BASE = "http://botfare.test/api/x402";

beforeAll(useTestDatabase);
afterEach(async () => {
  const report = await checkLedgerInvariants(getDb());
  expect(report).toMatchObject({ ok: true, totalMicros: 0 });
});
afterAll(async () => {
  resetFacilitator();
  await closeDb();
});

describe("GET /api/x402/supported", () => {
  it("lists prepaid on paypal:sandbox without auth", async () => {
    const res = supported();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kinds).toContainEqual(
      expect.objectContaining({ x402Version: 2, scheme: "prepaid", network: "paypal:sandbox" }),
    );
  });
});

describe("GET /api/health", () => {
  it("reports the database as up", async () => {
    expect(await (await health()).json()).toEqual({ ok: true, db: true });
  });
});

describe("POST /api/x402/verify and /settle", () => {
  it("rejects calls without valid site auth with 401", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);
    const requirements = requirementsFor(publisher.site.id);
    const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);

    expect((await settle(postJson(`${BASE}/settle`, body))).status).toBe(401);
    const wrongSecret = siteAuthHeader(publisher.site.id, "not-the-secret");
    expect((await verify(postJson(`${BASE}/verify`, body, wrongSecret))).status).toBe(401);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);
  });

  it("rejects malformed bodies with 400", async () => {
    const publisher = await makePublisher(getDb());
    const notJson = await verify(postJson(`${BASE}/verify`, "{nope", publisher.auth));
    expect(notJson.status).toBe(400);
    const badShape = await settle(
      postJson(`${BASE}/settle`, { x402Version: 2, paymentPayload: {} }, publisher.auth),
    );
    expect(badShape.status).toBe(400);
    expect((await badShape.json()).error).toBe("invalid_request");
  });

  it("refuses a payment addressed to another site as an x402 failure", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const other = await makePublisher(db);
    const agent = await makeAgent(db, 100);
    const requirements = requirementsFor(other.site.id);
    const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);

    const verified = await verify(postJson(`${BASE}/verify`, body, publisher.auth));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      isValid: false,
      invalidReason: "invalid_prepaid_site_not_allowed",
    });

    const settled = await settle(postJson(`${BASE}/settle`, body, publisher.auth));
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({
      success: false,
      errorReason: "invalid_prepaid_site_not_allowed",
      transaction: "",
      network: "paypal:sandbox",
    });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);
  });

  it("verifies, settles once (95/5 split), refuses the replay, and refunds once", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);
    const requirements = requirementsFor(publisher.site.id);
    const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);

    const verified = await (await verify(postJson(`${BASE}/verify`, body, publisher.auth))).json();
    expect(verified).toEqual({ isValid: true, payer: agent.key.id });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);

    const settledRes = await settle(postJson(`${BASE}/settle`, body, publisher.auth));
    expect(settledRes.status).toBe(200);
    const settled = await settledRes.json();
    expect(settled).toMatchObject({
      success: true,
      payer: agent.key.id,
      network: "paypal:sandbox",
      amount: "3",
    });
    expect(settled.transaction).toMatch(/^rcpt_/);
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(970_000);
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(28_500);
    expect(await getReceipt(db, settled.transaction)).toMatchObject({
      siteId: publisher.site.id,
      resourceUrl: "https://crema.example/articles/grinders",
      status: "settled",
    });

    const replay = await (await settle(postJson(`${BASE}/settle`, body, publisher.auth))).json();
    expect(replay).toMatchObject({
      success: false,
      errorReason: "invalid_prepaid_nonce_used",
      extra: { originalTransaction: settled.transaction },
    });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(970_000);

    // Another site cannot refund this receipt.
    const other = await makePublisher(db);
    const foreign = await refund(
      postJson(`${BASE}/refund`, { transaction: settled.transaction }, other.auth),
    );
    expect(foreign.status).toBe(404);
    expect((await refund(postJson(`${BASE}/refund`, { transaction: "rcpt_x" }))).status).toBe(401);

    const first = await refund(
      postJson(`${BASE}/refund`, { transaction: settled.transaction }, publisher.auth),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      transaction: settled.transaction,
      status: "refunded",
      alreadyRefunded: false,
    });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);
    expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(0);

    const second = await refund(
      postJson(`${BASE}/refund`, { transaction: settled.transaction }, publisher.auth),
    );
    expect(await second.json()).toMatchObject({ ok: true, alreadyRefunded: true });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(1_000_000);
  });

  it("passes ledger refusals through as x402 failures", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 2);
    const requirements = requirementsFor(publisher.site.id);
    const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);
    const settled = await (await settle(postJson(`${BASE}/settle`, body, publisher.auth))).json();
    expect(settled).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    expect(await walletBalanceMicros(db, agent.owner.id)).toBe(20_000);
  });
});

describe("GET /api/sites/[siteId]/config", () => {
  const get = (siteId: string, auth?: string) =>
    siteConfig(
      new Request(`http://botfare.test/api/sites/${siteId}/config`, {
        headers: auth ? { authorization: auth } : {},
      }),
      { params: Promise.resolve({ siteId }) },
    );

  it("returns the site's own config", async () => {
    const publisher = await makePublisher(getDb());
    const res = await get(publisher.site.id, publisher.auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      siteId: publisher.site.id,
      network: "paypal:sandbox",
      origin: "https://crema.example",
      pricing: [{ pattern: "/articles/*", method: "GET", priceCents: 3, audience: "agents" }],
      version: publisher.site.version,
    });
  });

  it("requires auth for that same site", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const other = await makePublisher(db);
    expect((await get(publisher.site.id)).status).toBe(401);
    expect((await get(publisher.site.id, other.auth)).status).toBe(401);
    const wrong = siteAuthHeader(publisher.site.id, "wrong");
    expect((await get(publisher.site.id, wrong)).status).toBe(401);
  });
});
