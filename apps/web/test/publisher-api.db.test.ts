import { authenticateSite, checkLedgerInvariants, createUser, type User } from "@botfare/core";
import type { PayPalClient } from "@botfare/paypal";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Route handlers run outside Next: no "server-only" guard, and the session is whoever the test says.
vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ user: null as User | null }));
vi.mock("../src/lib/server/session", () => ({
  requireApiUser: async () =>
    session.user
      ? { user: session.user }
      : { response: Response.json({ error: "unauthorized" }, { status: 401 }) },
}));

import { POST as webhook } from "../src/app/api/paypal/webhook/route";
import { PUT as savePayoutEmail } from "../src/app/api/publisher/payout-email/route";
import { POST as withdraw } from "../src/app/api/publisher/payouts/route";
import { POST as syncPayouts } from "../src/app/api/publisher/payouts/sync/route";
import { PUT as savePricing } from "../src/app/api/publisher/sites/[siteId]/pricing/route";
import { POST as rotateSecret } from "../src/app/api/publisher/sites/[siteId]/rotate-secret/route";
import { POST as createSiteRoute } from "../src/app/api/publisher/sites/route";
import { GET as summary } from "../src/app/api/publisher/summary/route";
import { POST as settle } from "../src/app/api/x402/settle/route";
import { closeDb, getDb } from "../src/lib/server/db";
import { resetFacilitator } from "../src/lib/server/facilitator";
import { setPayPalForTests } from "../src/lib/server/paypal-test-hooks";
import {
  facilitatorBody,
  makeAgent,
  makePublisher,
  postJson,
  requirementsFor,
  signPayment,
  useTestDatabase,
} from "./helpers";

const BASE = "http://botfare.test";
type Publisher = Awaited<ReturnType<typeof makePublisher>>;

function signIn(user: User | null): void {
  session.user = user;
}

function json(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function siteParams(siteId: string) {
  return { params: Promise.resolve({ siteId }) };
}

let counter = 0;
async function makeUser(): Promise<User> {
  counter += 1;
  const tag = `pub-api-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  return createUser(getDb(), { email: `${tag}@example.test`, name: tag });
}

/** Earns the publisher `cents` gross per paid request through the real settle route. */
async function earn(publisher: Publisher, requests: number, cents: number): Promise<void> {
  const agent = await makeAgent(getDb(), requests * cents + 100);
  for (let i = 0; i < requests; i += 1) {
    const requirements = requirementsFor(publisher.site.id, cents);
    const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);
    const res = await settle(postJson(`${BASE}/api/x402/settle`, body, publisher.auth));
    expect((await res.json()).success).toBe(true);
  }
}

/**
 * Moves the publisher's fares out of the dispute window (settled 25 hours ago), so their earnings
 * are available to withdraw. IDs come from createUser, never from input.
 */
async function matureEarnings(publisher: Publisher): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(publisher.owner.id)) throw new Error("unexpected user ID");
  await getDb().execute(
    `update receipts set created_at = now() - interval '25 hours' where publisher_user_id = '${publisher.owner.id}'`,
  );
}

function mockPayPal(overrides: Partial<PayPalClient>): Partial<PayPalClient> {
  setPayPalForTests(overrides);
  return overrides;
}

beforeAll(useTestDatabase);
afterEach(async () => {
  signIn(null);
  setPayPalForTests(null);
  vi.unstubAllEnvs();
  expect(await checkLedgerInvariants(getDb())).toMatchObject({ ok: true, totalMicros: 0 });
});
afterAll(async () => {
  resetFacilitator();
  await closeDb();
});

describe("publisher sites API", () => {
  it("requires a session on every route", async () => {
    const statuses = await Promise.all([
      summary().then((r) => r.status),
      createSiteRoute(json("POST", "/api/publisher/sites", {})).then((r) => r.status),
      savePricing(json("PUT", "/x", {}), siteParams("site_x")).then((r) => r.status),
      rotateSecret(json("POST", "/x"), siteParams("site_x")).then((r) => r.status),
      savePayoutEmail(json("PUT", "/x", { email: null })).then((r) => r.status),
      withdraw().then((r) => r.status),
      syncPayouts().then((r) => r.status),
    ]);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 401]);
  });

  it("creates a site for the signed-in user and returns its secret once", async () => {
    const alice = await makeUser();
    signIn(alice);
    const res = await createSiteRoute(
      json("POST", "/api/publisher/sites", {
        name: "  Kettle Quarterly ",
        origin: "https://kettle.example/some/page",
        payoutEmail: "Payouts@Kettle.example",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.site).toMatchObject({
      name: "Kettle Quarterly",
      origin: "https://kettle.example",
      pricing: [],
      chargeKnownBots: false,
    });
    expect(body.siteSecret).toEqual(expect.any(String));
    expect(await authenticateSite(getDb(), body.site.id, body.siteSecret)).not.toBeNull();

    const mine = await (await summary()).json();
    expect(mine.sites.map((s: { id: string }) => s.id)).toContain(body.site.id);
    expect(JSON.stringify(mine)).not.toContain(body.siteSecret);

    signIn(await makeUser());
    const theirs = await (await summary()).json();
    expect(theirs.sites).toEqual([]);
  });

  it("rejects a bad origin or payout email", async () => {
    signIn(await makeUser());
    const badOrigin = await createSiteRoute(
      json("POST", "/api/publisher/sites", { name: "X", origin: "not a url" }),
    );
    expect(badOrigin.status).toBe(400);
    const ftp = await createSiteRoute(
      json("POST", "/api/publisher/sites", { name: "X", origin: "ftp://files.example" }),
    );
    expect(ftp.status).toBe(400);
    const badEmail = await createSiteRoute(
      json("POST", "/api/publisher/sites", {
        name: "X",
        origin: "https://x.example",
        payoutEmail: "nope",
      }),
    );
    expect(badEmail.status).toBe(400);
  });

  it("saves valid pricing for the owner only", async () => {
    const publisher = await makePublisher(getDb());
    const pricing = {
      pricing: [
        { method: "get", pattern: "/articles/*", priceCents: 4, audience: "agents" },
        {
          method: "POST",
          pattern: "/api/brew-ratio",
          priceCents: 2,
          audience: "everyone",
          description: " Brew ratio API ",
        },
      ],
      freePaths: ["/articles/free-*"],
      chargeKnownBots: true,
    };

    signIn(await makeUser());
    const foreign = await savePricing(json("PUT", "/x", pricing), siteParams(publisher.site.id));
    expect(foreign.status).toBe(404);

    signIn(publisher.owner);
    const res = await savePricing(json("PUT", "/x", pricing), siteParams(publisher.site.id));
    expect(res.status).toBe(200);
    const { site } = await res.json();
    expect(site.pricing).toEqual([
      { method: "GET", pattern: "/articles/*", priceCents: 4, audience: "agents" },
      {
        method: "POST",
        pattern: "/api/brew-ratio",
        priceCents: 2,
        audience: "everyone",
        description: "Brew ratio API",
      },
    ]);
    expect(site.freePaths).toEqual(["/articles/free-*"]);
    expect(site.chargeKnownBots).toBe(true);
    expect(site.version).not.toBe(publisher.site.version);
  });

  it("refuses invalid pricing rules", async () => {
    const publisher = await makePublisher(getDb());
    signIn(publisher.owner);
    const invalid = [
      { pricing: [{ pattern: "articles/*", priceCents: 3 }], chargeKnownBots: false },
      { pricing: [{ pattern: "/a/*/b", priceCents: 3 }], chargeKnownBots: false },
      { pricing: [{ pattern: "/a", priceCents: 0 }], chargeKnownBots: false },
      { pricing: [{ pattern: "/a", priceCents: 1.5 }], chargeKnownBots: false },
      { pricing: [{ pattern: "/a", priceCents: 10_001 }], chargeKnownBots: false },
      { pricing: [{ pattern: "/a", priceCents: 3, method: "BREW" }], chargeKnownBots: false },
      { pricing: [{ pattern: "/a", priceCents: 3, audience: "humans" }], chargeKnownBots: false },
      { pricing: [], freePaths: ["free"], chargeKnownBots: false },
      { pricing: [] },
    ];
    for (const body of invalid) {
      const res = await savePricing(json("PUT", "/x", body), siteParams(publisher.site.id));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("rotates the secret for the owner only", async () => {
    const publisher = await makePublisher(getDb());
    signIn(await makeUser());
    expect((await rotateSecret(json("POST", "/x"), siteParams(publisher.site.id))).status).toBe(
      404,
    );
    expect(await authenticateSite(getDb(), publisher.site.id, publisher.siteSecret)).not.toBeNull();

    signIn(publisher.owner);
    const res = await rotateSecret(json("POST", "/x"), siteParams(publisher.site.id));
    expect(res.status).toBe(200);
    const { siteSecret } = await res.json();
    expect(siteSecret).not.toBe(publisher.siteSecret);
    expect(await authenticateSite(getDb(), publisher.site.id, siteSecret)).not.toBeNull();
    expect(await authenticateSite(getDb(), publisher.site.id, publisher.siteSecret)).toBeNull();
  });
});

describe("payout email and payouts API", () => {
  it("validates and saves the payout email", async () => {
    signIn(await makeUser());
    expect((await savePayoutEmail(json("PUT", "/x", { email: "nope" }))).status).toBe(400);
    const res = await savePayoutEmail(json("PUT", "/x", { email: " Me@Crema.example " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      payoutEmail: "me@crema.example",
      payoutEmailOnProfile: true,
    });
    const cleared = await savePayoutEmail(json("PUT", "/x", { email: "" }));
    expect(await cleared.json()).toEqual({ payoutEmail: null, payoutEmailOnProfile: false });
  });

  it("refuses a payout without an email or below $1.00, without calling PayPal", async () => {
    const createPayoutBatch = vi.fn();
    mockPayPal({ createPayoutBatch });
    const publisher = await makePublisher(getDb());
    signIn(publisher.owner);

    const noEmail = await withdraw();
    expect(noEmail.status).toBe(422);
    expect((await noEmail.json()).error).toBe("no_payout_email");

    await savePayoutEmail(json("PUT", "/x", { email: "crema@example.test" }));
    await earn(publisher, 2, 50); // $0.95 after BotFare's 5%
    await matureEarnings(publisher);
    const below = await withdraw();
    expect(below.status).toBe(422);
    expect((await below.json()).error).toBe("below_minimum");
    expect(createPayoutBatch).not.toHaveBeenCalled();
  });

  it("pays out earnings through PayPal and refreshes the status", async () => {
    const createPayoutBatch = vi.fn(async () => ({
      batchId: "PB-TEST-1",
      batchStatus: "PENDING" as const,
    }));
    const getPayoutBatch = vi.fn();
    mockPayPal({ createPayoutBatch, getPayoutBatch });
    const publisher = await makePublisher(getDb());
    signIn(publisher.owner);
    await savePayoutEmail(json("PUT", "/x", { email: "crema@example.test" }));
    await earn(publisher, 2, 60); // 120¢ gross, 114¢ net

    // Fresh fares stay clearing for the dispute window: nothing to withdraw yet.
    const fresh = await (await summary()).json();
    expect(fresh).toMatchObject({
      earningsMicros: 1_140_000,
      clearingMicros: 1_140_000,
      availableMicros: 0,
      disputeWindowHours: 24,
    });
    expect(Date.parse(fresh.nextReleaseAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const clearing = await withdraw();
    expect(clearing.status).toBe(422);
    expect(await clearing.json()).toMatchObject({
      error: "below_minimum",
      message: expect.stringContaining("$1.14 is still clearing (24-hour dispute window)"),
    });
    expect(createPayoutBatch).not.toHaveBeenCalled();

    await matureEarnings(publisher);
    expect(await (await summary()).json()).toMatchObject({
      availableMicros: 1_140_000,
      clearingMicros: 0,
      nextReleaseAt: null,
    });
    const res = await withdraw();
    expect(res.status).toBe(201);
    const { payout } = await res.json();
    expect(payout).toMatchObject({
      amountCents: 114,
      receiverEmail: "crema@example.test",
      paypalBatchId: "PB-TEST-1",
      reversed: false,
    });
    expect(createPayoutBatch).toHaveBeenCalledTimes(1);
    expect(createPayoutBatch.mock.calls[0]).toEqual([
      expect.objectContaining({
        senderBatchId: payout.batchKey,
        requestId: payout.batchKey,
        items: [
          expect.objectContaining({
            receiver: "crema@example.test",
            amount: "1.14",
            senderItemId: payout.id,
          }),
        ],
      }),
    ]);

    const after = await (await summary()).json();
    expect(after).toMatchObject({ earningsMicros: 0, availableMicros: 0 });
    expect(after.payouts[0].id).toBe(payout.id);

    // Another publisher's refresh never touches this payout.
    signIn(await makeUser());
    expect(await (await syncPayouts()).json()).toMatchObject({ synced: 0, payouts: [] });
    expect(getPayoutBatch).not.toHaveBeenCalled();

    signIn(publisher.owner);
    getPayoutBatch.mockResolvedValue({
      batchId: "PB-TEST-1",
      batchStatus: "SUCCESS",
      items: [
        {
          payoutItemId: "ITEM-1",
          transactionStatus: "SUCCESS",
          senderItemId: payout.id,
          receiver: "crema@example.test",
          amount: "1.14",
          currency: "USD",
        },
      ],
    });
    const synced = await (await syncPayouts()).json();
    expect(synced.synced).toBe(1);
    expect(synced.payouts[0]).toMatchObject({ id: payout.id, status: "success" });
    expect(getPayoutBatch).toHaveBeenCalledWith("PB-TEST-1");
  });
});

describe("PayPal webhook route", () => {
  function webhookRequest(event: unknown): Request {
    return new Request(`${BASE}/api/paypal/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "t-1",
        "paypal-transmission-time": new Date().toISOString(),
        "paypal-transmission-sig": "sig",
        "paypal-cert-url": "https://api.sandbox.paypal.com/cert.pem",
        "paypal-auth-algo": "SHA256withRSA",
      },
      body: JSON.stringify(event),
    });
  }

  const event = (id: string) => ({
    id,
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource: { id: "ORDER-1" },
  });

  it("answers 503 when PAYPAL_WEBHOOK_ID is not set", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const verifyWebhookSignature = vi.fn();
    mockPayPal({ verifyWebhookSignature });
    const res = await webhook(webhookRequest(event(`WH-${Date.now()}-a`)));
    expect(res.status).toBe(503);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("rejects an event whose signature does not verify", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-CONFIG-ID");
    const verifyWebhookSignature = vi.fn(async () => false);
    mockPayPal({ verifyWebhookSignature });
    const res = await webhook(webhookRequest(event(`WH-${Date.now()}-b`)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_signature");
  });

  it("handles a verified event once and acknowledges duplicates", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-CONFIG-ID");
    const createPayoutBatch = vi.fn(async () => ({
      batchId: "PB-TEST-2",
      batchStatus: "PENDING" as const,
    }));
    const verifyWebhookSignature = vi.fn(async () => true);
    mockPayPal({ createPayoutBatch, verifyWebhookSignature });

    const publisher = await makePublisher(getDb());
    signIn(publisher.owner);
    await savePayoutEmail(json("PUT", "/x", { email: "crema@example.test" }));
    await earn(publisher, 2, 60);
    await matureEarnings(publisher);
    const { payout } = await (await withdraw()).json();

    const itemEvent = {
      id: `WH-${Date.now()}-c`,
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: {
        payout_item_id: "ITEM-2",
        transaction_id: "TXN-2",
        transaction_status: "SUCCESS",
        payout_batch_id: "PB-TEST-2",
        payout_item: { sender_item_id: payout.id },
      },
    };
    const first = await webhook(webhookRequest(itemEvent));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "processed", eventId: itemEvent.id });
    expect(verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "WH-CONFIG-ID", event: itemEvent }),
    );

    const again = await webhook(webhookRequest(itemEvent));
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("duplicate");

    const after = await (await summary()).json();
    expect(after.payouts[0]).toMatchObject({ id: payout.id, status: "success" });
  });

  it("acknowledges an event type it does not handle", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-CONFIG-ID");
    mockPayPal({ verifyWebhookSignature: async () => true });
    const res = await webhook(webhookRequest(event(`WH-${Date.now()}-d`)));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ignored");
  });
});
