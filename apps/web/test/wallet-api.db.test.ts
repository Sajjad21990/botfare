import {
  checkLedgerInvariants,
  createUser,
  getAgentKeyById,
  type User,
  walletBalanceMicros,
} from "@botfare/core";
import type { CaptureOrderResult, CreateOrderInput, PayPalClient } from "@botfare/paypal";
import { PayPalApiError } from "@botfare/paypal";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers read the session through next/headers; here the signed-in user is a variable.
const session = vi.hoisted(() => ({ user: null as User | null }));
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/session", () => ({
  requireApiUser: async () =>
    session.user
      ? { user: session.user }
      : { response: Response.json({ error: "unauthorized" }, { status: 401 }) },
}));

import { POST as revokeKey } from "../src/app/api/wallet/keys/[keyId]/revoke/route";
import { POST as createKey } from "../src/app/api/wallet/keys/route";
import { GET as summary } from "../src/app/api/wallet/summary/route";
import { POST as capture } from "../src/app/api/wallet/topups/[orderId]/capture/route";
import { POST as startTopUp } from "../src/app/api/wallet/topups/route";
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

const BASE = "http://botfare.test/api/wallet";

/** A PayPal sandbox stand-in: orders capture for their full amount with a 2.99% + 49¢ fee. */
function mockPayPal() {
  const amounts = new Map<string, string>();
  const createOrder = vi.fn(async (input: CreateOrderInput) => {
    const id = `ORDER${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    amounts.set(id, input.amount);
    return { id, status: "PAYER_ACTION_REQUIRED", approveUrl: `https://paypal.test/${id}` };
  });
  const captureOrder = vi.fn(async (orderId: string): Promise<CaptureOrderResult> => {
    const gross = amounts.get(orderId) ?? "0.00";
    const feeCents = Math.round(Number(gross) * 100 * 0.0299) + 49;
    const fee = (feeCents / 100).toFixed(2);
    return {
      orderId,
      status: "COMPLETED",
      captureId: `CAP-${orderId}`,
      captureStatus: "COMPLETED",
      gross,
      fee,
      net: (Number(gross) - feeCents / 100).toFixed(2),
      currency: "USD",
      payerEmail: "buyer@example.test",
      payerId: "PAYER1",
    };
  });
  return { createOrder, captureOrder } satisfies Partial<PayPalClient>;
}

let paypal: ReturnType<typeof mockPayPal>;
let counter = 0;

async function makeUser(label: string): Promise<User> {
  counter += 1;
  const tag = `wallet-${label}-${Date.now().toString(36)}-${counter}`;
  return createUser(getDb(), { email: `${tag}@example.test`, name: tag });
}

function signIn(user: User | null) {
  session.user = user;
}

function params<T>(value: T) {
  return { params: Promise.resolve(value) };
}

async function start(amountCents: unknown): Promise<Response> {
  return startTopUp(postJson(`${BASE}/topups`, { amountCents }));
}

async function captureOrder(orderId: string): Promise<Response> {
  return capture(postJson(`${BASE}/topups/${orderId}/capture`, {}), params({ orderId }));
}

async function publicJwk() {
  const { publicJwk, privateJwk } = await generateAgentKeyPair();
  return { publicJwk, privateJwk };
}

async function newKey(body: Record<string, unknown>): Promise<Response> {
  return createKey(postJson(`${BASE}/keys`, body));
}

beforeAll(useTestDatabase);
beforeEach(() => {
  paypal = mockPayPal();
  setPayPalForTests(paypal);
  signIn(null);
});
afterEach(async () => {
  expect(await checkLedgerInvariants(getDb())).toMatchObject({ ok: true, totalMicros: 0 });
});
afterAll(async () => {
  setPayPalForTests(null);
  resetFacilitator();
  await closeDb();
});

describe("wallet API auth", () => {
  it("answers 401 without a session", async () => {
    expect((await start(500)).status).toBe(401);
    expect((await captureOrder("ORDER1")).status).toBe(401);
    expect((await newKey({})).status).toBe(401);
    expect(
      (await revokeKey(postJson(`${BASE}/keys/x/revoke`, {}), params({ keyId: "x" }))).status,
    ).toBe(401);
    expect((await summary()).status).toBe(401);
    expect(paypal.createOrder).not.toHaveBeenCalled();
  });
});

describe("POST /api/wallet/topups", () => {
  it("rejects amounts other than $5, $10 and $20 before calling PayPal", async () => {
    signIn(await makeUser("amounts"));
    for (const amount of [0, -500, 499, 501, 1500, 5000, 10.5, "1000", null]) {
      const res = await start(amount);
      expect(res.status, `amount ${String(amount)}`).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
    }
    expect(paypal.createOrder).not.toHaveBeenCalled();
  });

  it("creates an order for the session user and returns only its ID", async () => {
    const user = await makeUser("start");
    signIn(user);
    const res = await start(2000);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["orderId"]);
    expect(paypal.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "20.00", currency: "USD", customId: user.id }),
    );
  });
});

describe("POST /api/wallet/topups/[orderId]/capture", () => {
  it("captures, credits the full gross once, and reports the PayPal fee", async () => {
    const user = await makeUser("capture");
    signIn(user);
    const { orderId } = await (await start(1000)).json();

    const res = await captureOrder(orderId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "captured",
      walletMicros: 10_000_000,
      captureId: `CAP-${orderId}`,
      grossCents: 1000,
      feeCents: 79,
    });

    // A repeat (double click, retry) returns the same result without a second credit.
    const again = await (await captureOrder(orderId)).json();
    expect(again).toMatchObject({ status: "captured", walletMicros: 10_000_000, feeCents: 79 });
    expect(paypal.captureOrder).toHaveBeenCalledTimes(1);
    expect(await walletBalanceMicros(getDb(), user.id)).toBe(10_000_000);
  });

  it("refuses to capture another user's order", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    signIn(alice);
    const { orderId } = await (await start(500)).json();

    signIn(mallory);
    const res = await captureOrder(orderId);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(paypal.captureOrder).not.toHaveBeenCalled();
    expect(await walletBalanceMicros(getDb(), mallory.id)).toBe(0);
    expect(await walletBalanceMicros(getDb(), alice.id)).toBe(0);

    // The owner can still capture it afterwards.
    signIn(alice);
    expect((await (await captureOrder(orderId)).json()).status).toBe("captured");
    expect(await walletBalanceMicros(getDb(), alice.id)).toBe(5_000_000);
  });

  it("answers 404 for unknown or malformed order IDs", async () => {
    signIn(await makeUser("unknown"));
    expect((await captureOrder("NOSUCHORDER123")).status).toBe(404);
    expect((await captureOrder("../../etc")).status).toBe(404);
    expect(paypal.captureOrder).not.toHaveBeenCalled();
  });

  it("answers 409 while the payer has not approved the order", async () => {
    const user = await makeUser("unapproved");
    signIn(user);
    const { orderId } = await (await start(500)).json();
    paypal.captureOrder.mockRejectedValueOnce(
      new PayPalApiError({
        status: 422,
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed",
        debugId: "debug-1",
        details: [{ issue: "ORDER_NOT_APPROVED" }],
        body: {},
      }),
    );
    const res = await captureOrder(orderId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_approved");
    expect(await walletBalanceMicros(getDb(), user.id)).toBe(0);
  });

  it("hides PayPal internals behind a 502", async () => {
    signIn(await makeUser("paypal-down"));
    paypal.createOrder.mockRejectedValueOnce(
      new PayPalApiError({
        status: 500,
        name: "INTERNAL_SERVER_ERROR",
        message: "secret internals",
        debugId: "debug-2",
        details: [],
        body: {},
      }),
    );
    const res = await start(500);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret internals");
  });
});

describe("POST /api/wallet/keys", () => {
  it("registers the public key with caps and never stores a private part", async () => {
    const user = await makeUser("keys");
    signIn(user);
    const { publicJwk: jwk } = await publicJwk();
    const res = await newKey({
      name: "  Research agent  ",
      publicJwk: { ...jwk, alg: "EdDSA", use: "sig" },
      perRequestMaxCents: 10,
      dailyCapCents: 100,
    });
    expect(res.status).toBe(201);
    const { key } = await res.json();
    expect(key).toMatchObject({
      id: expect.stringMatching(/^ak_/),
      name: "Research agent",
      status: "active",
      perRequestMaxCents: 10,
      dailyCapCents: 100,
      allowedSiteIds: null,
      spentTodayMicros: 0,
    });
    expect(key).not.toHaveProperty("publicJwk");
    const stored = await getAgentKeyById(getDb(), key.id);
    expect(stored?.ownerUserId).toBe(user.id);
    expect(stored?.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x: jwk.x });
  });

  it("rejects a JWK that carries the private key (d)", async () => {
    signIn(await makeUser("private"));
    const { privateJwk } = await publicJwk();
    const res = await newKey({
      name: "leaky",
      publicJwk: privateJwk,
      perRequestMaxCents: 10,
      dailyCapCents: 100,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/private key/);
  });

  it("rejects malformed keys and caps", async () => {
    signIn(await makeUser("bad-keys"));
    const { publicJwk: jwk } = await publicJwk();
    const valid = { name: "agent", publicJwk: jwk, perRequestMaxCents: 10, dailyCapCents: 100 };
    const bad: Record<string, unknown>[] = [
      { ...valid, name: "   " },
      { ...valid, publicJwk: { ...jwk, crv: "X25519" } },
      { ...valid, publicJwk: { ...jwk, kty: "EC" } },
      { ...valid, publicJwk: { ...jwk, x: "short" } },
      { ...valid, perRequestMaxCents: 0 },
      { ...valid, perRequestMaxCents: 2.5 },
      { ...valid, dailyCapCents: 100_001 },
      { ...valid, perRequestMaxCents: 500, dailyCapCents: 100 },
      { ...valid, allowedSiteIds: [] },
    ];
    for (const body of bad) {
      expect((await newKey(body)).status, JSON.stringify(body)).toBe(400);
    }
    const unknownSite = await newKey({ ...valid, allowedSiteIds: ["site_doesnotexist000"] });
    expect(unknownSite.status).toBe(400);
    expect((await unknownSite.json()).error).toBe("unknown_site");
  });

  it("limits a key to the chosen sites", async () => {
    const publisher = await makePublisher(getDb());
    signIn(await makeUser("allowed"));
    const { publicJwk: jwk } = await publicJwk();
    const res = await newKey({
      name: "crema only",
      publicJwk: jwk,
      perRequestMaxCents: 5,
      dailyCapCents: 50,
      allowedSiteIds: [publisher.site.id, publisher.site.id],
    });
    expect(res.status).toBe(201);
    expect((await res.json()).key.allowedSiteIds).toEqual([publisher.site.id]);
  });
});

describe("POST /api/wallet/keys/[keyId]/revoke", () => {
  it("revokes the owner's key, idempotently, and never another user's", async () => {
    const alice = await makeUser("revoke-alice");
    const mallory = await makeUser("revoke-mallory");
    signIn(alice);
    const { publicJwk: jwk } = await publicJwk();
    const { key } = await (
      await newKey({
        name: "alice agent",
        publicJwk: jwk,
        perRequestMaxCents: 10,
        dailyCapCents: 100,
      })
    ).json();
    const revoke = () =>
      revokeKey(postJson(`${BASE}/keys/${key.id}/revoke`, {}), params({ keyId: key.id }));

    signIn(mallory);
    const refused = await revoke();
    expect(refused.status).toBe(404);
    expect((await getAgentKeyById(getDb(), key.id))?.status).toBe("active");

    signIn(alice);
    const res = await revoke();
    expect(res.status).toBe(200);
    const { key: revoked } = await res.json();
    expect(revoked).toMatchObject({ id: key.id, status: "revoked", revokedAt: expect.any(String) });
    expect((await revoke()).status).toBe(200);
    expect((await getAgentKeyById(getDb(), key.id))?.status).toBe("revoked");
  });
});

describe("GET /api/wallet/summary", () => {
  it("shows the user's own balance, keys, top-ups and receipts only", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);
    const other = await makeAgent(db, 100);

    const requirements = requirementsFor(publisher.site.id, 3);
    const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);
    const settled = await (
      await settle(postJson("http://botfare.test/api/x402/settle", body, publisher.auth))
    ).json();
    expect(settled.success).toBe(true);

    signIn(agent.owner);
    const { orderId } = await (await start(500)).json();
    await captureOrder(orderId);

    const view = await (await summary()).json();
    expect(view.balanceMicros).toBe(1_000_000 - 30_000 + 5_000_000);
    expect(view.spendTodayMicros).toBe(30_000);
    expect(view.keys.map((key: { id: string }) => key.id)).toEqual([agent.key.id]);
    expect(view.keys[0].spentTodayMicros).toBe(30_000);
    expect(view.keys.map((key: { id: string }) => key.id)).not.toContain(other.key.id);
    expect(view.topups).toEqual([
      expect.objectContaining({ grossCents: 500, captureId: `CAP-${orderId}` }),
    ]);
    expect(view.receipts).toEqual([
      {
        id: settled.transaction,
        createdAt: expect.any(String),
        siteId: publisher.site.id,
        siteName: publisher.site.name,
        path: "/articles/grinders",
        agentKeyId: agent.key.id,
        agentKeyName: "research agent",
        amountMicros: 30_000,
        status: "settled",
      },
    ]);
    expect(view.sites).toContainEqual({
      id: publisher.site.id,
      name: publisher.site.name,
      origin: publisher.site.origin,
    });
  });
});
