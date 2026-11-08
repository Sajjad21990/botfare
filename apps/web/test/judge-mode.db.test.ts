import {
  DEMO_PERSONAS,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  type DemoPersona,
  encodeAgentKey,
} from "@botfare/contracts";
import {
  authenticateSite,
  checkLedgerInvariants,
  createAgentKey,
  createSite,
  createUser,
  DEMO_EARNINGS_FLOOR_CENTS,
  DEMO_WALLET_FLOOR_CENTS,
  earningsBalanceMicros,
  getAgentKeyById,
  getSite,
  getUserByEmail,
  listSites,
  type User,
  walletBalanceMicros,
} from "@botfare/core";
import type { PayPalClient } from "@botfare/paypal";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Route handlers run outside Next: no "server-only" guard, and the session is whoever the test says.
vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ user: null as User | null }));
vi.mock("../src/lib/server/session", async () => {
  const { getDb } = await import("../src/lib/server/db");
  const core = await import("@botfare/core");
  const { DEMO_PERSONAS: personas } = await import("@botfare/contracts");
  return {
    requireApiUser: async () =>
      session.user
        ? { user: session.user }
        : { response: Response.json({ error: "unauthorized" }, { status: 401 }) },
    personaUser: async (persona: keyof typeof personas) => {
      const { email, name } = personas[persona];
      return (
        (await core.getUserByEmail(getDb(), email)) ?? core.createUser(getDb(), { email, name })
      );
    },
    createSessionCookie: async () => {},
  };
});

import { PUT as savePayoutEmailRoute } from "../src/app/api/publisher/payout-email/route";
import { POST as withdraw } from "../src/app/api/publisher/payouts/route";
import { PUT as savePricing } from "../src/app/api/publisher/sites/[siteId]/pricing/route";
import { POST as rotateSecret } from "../src/app/api/publisher/sites/[siteId]/rotate-secret/route";
import { GET as summary } from "../src/app/api/publisher/summary/route";
import { POST as signInAsPersona } from "../src/app/api/session/persona/route";
import { POST as revokeKey } from "../src/app/api/wallet/keys/[keyId]/revoke/route";
import { closeDb, getDb } from "../src/lib/server/db";
import { refillDemoAgentWallet } from "../src/lib/server/judge";
import { setPayPalForTests } from "../src/lib/server/paypal-test-hooks";
import { useTestDatabase } from "./helpers";

const BASE = "http://botfare.test";
const DEMO_PAYOUT_EMAIL = "demo-payouts@personal.example.com";

function json(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function persona(name: DemoPersona): Promise<User> {
  const { email, name: label } = DEMO_PERSONAS[name];
  return (await getUserByEmail(getDb(), email)) ?? createUser(getDb(), { email, name: label });
}

/** The persona's Crema Notes site, created once per test run like `pnpm seed` does. */
async function demoSite(publisher: User) {
  const existing = (await listSites(getDb(), publisher.id)).find((s) => s.name === DEMO_SITE_NAME);
  if (existing) return existing;
  const { site } = await createSite(getDb(), {
    ownerUserId: publisher.id,
    name: DEMO_SITE_NAME,
    origin: "https://crema.example",
    pricing: DEMO_SITE_PRICING,
    freePaths: DEMO_SITE_FREE_PATHS,
  });
  return site;
}

async function signInAs(name: DemoPersona): Promise<User> {
  const res = await signInAsPersona(json("POST", "/api/session/persona", { persona: name }));
  expect(res.status).toBe(200);
  const user = await persona(name);
  session.user = user;
  return user;
}

const params = <K extends string>(key: K, value: string) => ({
  params: Promise.resolve({ [key]: value } as Record<K, string>),
});

beforeAll(useTestDatabase);
afterEach(async () => {
  session.user = null;
  setPayPalForTests(null);
  vi.unstubAllEnvs();
  expect(await checkLedgerInvariants(getDb())).toMatchObject({ ok: true, totalMicros: 0 });
});
afterAll(closeDb);

describe("judge mode", () => {
  it("refuses to rotate the shared demo site's secret, but not a judge's own site", async () => {
    const publisher = await persona("publisher");
    const site = await demoSite(publisher);
    const before = await getSite(getDb(), site.id);
    session.user = publisher;

    const res = await rotateSecret(json("POST", "/x"), params("siteId", site.id));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("judge_mode");
    expect((await getSite(getDb(), site.id))?.secretHash).toBe(before?.secretHash);

    const own = await createSite(getDb(), {
      ownerUserId: publisher.id,
      name: "Judge's test site",
      origin: "https://judge.example",
      pricing: [],
    });
    const rotated = await rotateSecret(json("POST", "/x"), params("siteId", own.site.id));
    expect(rotated.status).toBe(200);
    expect(await authenticateSite(getDb(), own.site.id, own.siteSecret)).toBeNull();

    // The dashboard shows the lock, too.
    const body = await (await summary()).json();
    const views = new Map(
      body.sites.map((s: { id: string; demoLocked: boolean }) => [s.id, s.demoLocked]),
    );
    expect(views.get(site.id)).toBe(true);
    expect(views.get(own.site.id)).toBe(false);
    expect(body.judgeMode).toBe(true);
  });

  it("lets an ordinary publisher rotate a site that happens to share the demo's name", async () => {
    const owner = await createUser(getDb(), {
      email: `judge-mode-${crypto.randomUUID()}@example.test`,
      name: "Someone",
    });
    const { site } = await createSite(getDb(), {
      ownerUserId: owner.id,
      name: DEMO_SITE_NAME,
      origin: "https://elsewhere.example",
      pricing: [],
    });
    session.user = owner;
    const res = await rotateSecret(json("POST", "/x"), params("siteId", site.id));
    expect(res.status).toBe(200);
  });

  it("refuses to change the persona's payout email", async () => {
    const publisher = await persona("publisher");
    session.user = publisher;
    const res = await savePayoutEmailRoute(
      json("PUT", "/api/publisher/payout-email", { email: "judge@example.test" }),
    );
    expect(res.status).toBe(403);
    expect((await getUserByEmail(getDb(), publisher.email))?.payoutEmail).not.toBe(
      "judge@example.test",
    );
  });

  it("refuses to revoke the seeded demo agent keys, but not a judge's own key", async () => {
    const owner = await persona("agentOwner");
    const { publicJwk } = await generateAgentKeyPair();
    const seeded = await createAgentKey(getDb(), {
      ownerUserId: owner.id,
      name: "Research agent",
      publicJwk,
    });
    const own = await createAgentKey(getDb(), {
      ownerUserId: owner.id,
      name: "My test agent",
      publicJwk: (await generateAgentKeyPair()).publicJwk,
    });
    session.user = owner;

    const refused = await revokeKey(json("POST", "/x"), params("keyId", seeded.id));
    expect(refused.status).toBe(403);
    expect((await getAgentKeyById(getDb(), seeded.id))?.status).toBe("active");
    const revoked = await revokeKey(json("POST", "/x"), params("keyId", own.id));
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).key).toMatchObject({ status: "revoked", demoLocked: false });
  });

  it("restores prices, payout email and Withdraw for the next judge at sign-in", async () => {
    vi.stubEnv("PUBLISHER_PAYPAL_EMAIL", DEMO_PAYOUT_EMAIL);
    const publisher = await signInAs("publisher");
    const site = await demoSite(publisher);

    // One judge clears the prices and withdraws everything.
    const cleared = await savePricing(
      json("PUT", "/x", { pricing: [], freePaths: [], chargeKnownBots: true }),
      params("siteId", site.id),
    );
    expect(cleared.status).toBe(200);
    const createPayoutBatch = vi.fn<PayPalClient["createPayoutBatch"]>(async (input) => ({
      batchId: `PB-${input.senderBatchId}`,
      batchStatus: "PENDING",
    }));
    setPayPalForTests({ createPayoutBatch });
    expect((await withdraw()).status).toBe(201);
    expect(createPayoutBatch.mock.calls[0]?.[0].items[0]?.receiver).toBe(DEMO_PAYOUT_EMAIL);
    expect(await earningsBalanceMicros(getDb(), publisher.id)).toBeLessThan(10_000);

    // The next judge signs in and finds the demo as seeded.
    await signInAs("publisher");
    const restored = await getSite(getDb(), site.id);
    expect(restored?.pricing).toEqual(DEMO_SITE_PRICING);
    expect(restored?.freePaths).toEqual(DEMO_SITE_FREE_PATHS);
    expect(restored?.chargeKnownBots).toBe(false);
    expect((await getUserByEmail(getDb(), publisher.email))?.payoutEmail).toBe(DEMO_PAYOUT_EMAIL);
    const floor = DEMO_EARNINGS_FLOOR_CENTS * 10_000;
    expect(await earningsBalanceMicros(getDb(), publisher.id)).toBeGreaterThanOrEqual(floor);

    // Signing in again without a new withdrawal adds nothing, and leaves the prices' version.
    const balance = await earningsBalanceMicros(getDb(), publisher.id);
    const version = restored?.version;
    await signInAs("publisher");
    expect(await earningsBalanceMicros(getDb(), publisher.id)).toBe(balance);
    expect((await getSite(getDb(), site.id))?.version).toBe(version);
    expect((await (await summary()).json()).judgeMode).toBe(true);
  });

  it("keeps the shared research agent's wallet at the demo floor, and never a real owner's", async () => {
    const floor = DEMO_WALLET_FLOOR_CENTS * 10_000;
    const owner = await signInAs("agentOwner");
    expect(await walletBalanceMicros(getDb(), owner.id)).toBeGreaterThanOrEqual(floor);

    const keyFor = async (user: User) => {
      const { publicJwk, privateJwk } = await generateAgentKeyPair();
      const key = await createAgentKey(getDb(), {
        ownerUserId: user.id,
        name: "Demo research agent",
        publicJwk,
      });
      return encodeAgentKey({
        v: 1,
        keyId: key.id,
        privateJwk: privateJwk as Parameters<typeof encodeAgentKey>[0]["privateJwk"],
      });
    };
    // Before each run, the persona's wallet goes back up to the floor; a stranger's never does.
    const demoKey = await keyFor(owner);
    await refillDemoAgentWallet(demoKey);
    expect(await walletBalanceMicros(getDb(), owner.id)).toBeGreaterThanOrEqual(floor);
    const stranger = await createUser(getDb(), {
      email: `real-owner-${Date.now()}@example.test`,
      name: "Real owner",
    });
    await refillDemoAgentWallet(await keyFor(stranger));
    expect(await walletBalanceMicros(getDb(), stranger.id)).toBe(0);
    await refillDemoAgentWallet("bfk_not_a_key");
  });
});
