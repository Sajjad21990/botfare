import { siteAuthHeader } from "@botfare/contracts";
import { createRequestSigner, type Ed25519PrivateJwk } from "@botfare/contracts/web-bot-auth";
import {
  advisorInputs,
  checkLedgerInvariants,
  createAgentKey,
  createSite,
  createUser,
  seedWallet,
} from "@botfare/core";
import { generateAgentKeyPair, PrepaidPayPalClient } from "@botfare/x402-paypal";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as citationsRoute } from "../src/app/api/citations/route";
import { POST as declineRoute } from "../src/app/api/offers/decline/route";
import { POST as settle } from "../src/app/api/x402/settle/route";
import { POST as telemetryRoute } from "../src/app/api/x402/telemetry/route";
import { getPublisherAnalytics } from "../src/lib/server/analytics-receipts";
import { closeDb, getDb } from "../src/lib/server/db";
import { resetFacilitator } from "../src/lib/server/facilitator";
import {
  resetSignalLimits,
  SIGNAL_BODY_LIMITS,
  SIGNAL_RATE_LIMITS,
} from "../src/lib/server/fare-advisor-signals";
import {
  facilitatorBody,
  postJson,
  requirementsFor,
  signPayment,
  useTestDatabase,
} from "./helpers";

const BOTFARE_URL = "http://botfare.test";
const savedEnv = {
  BOTFARE_URL: process.env.BOTFARE_URL,
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL,
};

function tag(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A publisher with its own origin, so decline notes land on this site. */
async function makeSite() {
  const db = getDb();
  const name = tag("signals-pub");
  const owner = await createUser(db, { email: `${name}@example.test`, name });
  const origin = `https://${name}.example`;
  const { site, siteSecret } = await createSite(db, {
    ownerUserId: owner.id,
    name: "Crema Notes (signals test)",
    origin,
    pricing: [
      { pattern: "/articles/premium-*", priceCents: 50 },
      { pattern: "/articles/*", priceCents: 3 },
    ],
  });
  return { owner, site, origin, auth: siteAuthHeader(site.id, siteSecret) };
}

async function makeKey() {
  const db = getDb();
  const name = tag("signals-agent");
  const owner = await createUser(db, { email: `${name}@example.test`, name });
  const keys = await generateAgentKeyPair();
  const key = await createAgentKey(db, {
    ownerUserId: owner.id,
    name: "signals agent",
    publicJwk: keys.publicJwk,
  });
  await seedWallet(db, { ownerUserId: owner.id, cents: 100, idempotencyKey: name });
  return {
    key,
    privateJwk: keys.privateJwk as Ed25519PrivateJwk,
    client: new PrepaidPayPalClient({ keyId: key.id, privateJwk: keys.privateJwk }),
  };
}

type Agent = Awaited<ReturnType<typeof makeKey>>;

/** A JSON POST signed the way the SDK signs calls to BotFare's agent API. */
async function signedPost(agent: Agent, path: string, body: unknown): Promise<Request> {
  const url = `${BOTFARE_URL}${path}`;
  const signer = createRequestSigner({ privateJwk: agent.privateJwk, signatureAgent: BOTFARE_URL });
  const headers = await signer.sign({ url });
  return new Request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function telemetryBatch(count: number, path = "/articles/premium-roundup") {
  const at = new Date().toISOString();
  return {
    events: Array.from({ length: count }, () => ({
      path,
      method: "GET",
      priceCents: 50,
      signal: "agent-header",
      at,
    })),
  };
}

beforeAll(() => {
  useTestDatabase();
  process.env.BOTFARE_URL = BOTFARE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  resetFacilitator();
});
beforeEach(resetSignalLimits);
afterEach(async () => {
  expect(await checkLedgerInvariants(getDb())).toMatchObject({ ok: true, totalMicros: 0 });
});
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetSignalLimits();
  resetFacilitator();
  await closeDb();
});

describe("POST /api/x402/telemetry", () => {
  it("stores a batch for the authenticated site and shows up in the advisor's inputs", async () => {
    const publisher = await makeSite();
    const response = await telemetryRoute(
      postJson(`${BOTFARE_URL}/api/x402/telemetry`, telemetryBatch(3), publisher.auth),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, accepted: 3, dropped: 0 });

    const inputs = await advisorInputs(getDb(), {
      publisherUserId: publisher.owner.id,
      siteId: publisher.site.id,
    });
    expect(inputs?.totals.offers).toBe(3);
  });

  it("refuses missing or wrong site credentials", async () => {
    const publisher = await makeSite();
    const anonymous = await telemetryRoute(
      postJson(`${BOTFARE_URL}/api/x402/telemetry`, telemetryBatch(1)),
    );
    expect(anonymous.status).toBe(401);
    const wrong = await telemetryRoute(
      postJson(
        `${BOTFARE_URL}/api/x402/telemetry`,
        telemetryBatch(1),
        siteAuthHeader(publisher.site.id, "not-the-secret"),
      ),
    );
    expect(wrong.status).toBe(401);
  });

  it("answers 400 for a malformed batch and 413 past the byte cap", async () => {
    const publisher = await makeSite();
    const invalid = await telemetryRoute(
      postJson(`${BOTFARE_URL}/api/x402/telemetry`, { events: [] }, publisher.auth),
    );
    expect(invalid.status).toBe(400);
    const huge = await telemetryRoute(
      postJson(
        `${BOTFARE_URL}/api/x402/telemetry`,
        JSON.stringify({ events: [], pad: "x".repeat(SIGNAL_BODY_LIMITS.telemetry) }),
        publisher.auth,
      ),
    );
    expect(huge.status).toBe(413);
  });

  it("limits batches per site per minute, without affecting other sites", async () => {
    const busy = await makeSite();
    const other = await makeSite();
    const post = (auth: string) =>
      telemetryRoute(postJson(`${BOTFARE_URL}/api/x402/telemetry`, { events: [] }, auth));
    for (let i = 0; i < SIGNAL_RATE_LIMITS.telemetryPerSite; i++) {
      expect((await post(busy.auth)).status).toBe(400);
    }
    const limited = await post(busy.auth);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await limited.json()).error).toBe("rate_limited");
    expect((await post(other.auth)).status).toBe(400);
  });
});

describe("POST /api/offers/decline", () => {
  it("stores a signed note once per key, path and day", async () => {
    const publisher = await makeSite();
    const agent = await makeKey();
    const note = {
      url: `${publisher.origin}/articles/premium-roundup?ref=feed`,
      priceCents: 50,
      category: "low_quality_preview",
      reason: "Thin listicle; the preview has no specifics",
    };
    const first = await declineRoute(await signedPost(agent, "/api/offers/decline", note));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      recorded: true,
      path: "/articles/premium-roundup",
    });
    const repeat = await declineRoute(await signedPost(agent, "/api/offers/decline", note));
    expect(await repeat.json()).toMatchObject({ ok: true, recorded: false });
    // Another query string is the same page; a price the site does not charge is refused.
    const variant = await declineRoute(
      await signedPost(agent, "/api/offers/decline", {
        ...note,
        url: `${publisher.origin}/articles/premium-roundup?x=2`,
      }),
    );
    expect(await variant.json()).toMatchObject({ ok: true, recorded: false });
    const wrongPrice = await declineRoute(
      await signedPost(agent, "/api/offers/decline", { ...note, priceCents: 1 }),
    );
    expect(wrongPrice.status).toBe(400);

    const inputs = await advisorInputs(getDb(), {
      publisherUserId: publisher.owner.id,
      siteId: publisher.site.id,
    });
    expect(inputs?.totals.declined).toBe(1);
    expect(inputs?.rules[0]?.topReasons).toEqual([
      { reason: "Thin listicle; the preview has no specifics", count: 1 },
    ]);
  });

  it("refuses unsigned requests and URLs on no BotFare site", async () => {
    const agent = await makeKey();
    const unsigned = await declineRoute(
      postJson(`${BOTFARE_URL}/api/offers/decline`, {
        url: "https://nowhere.example/a",
        priceCents: 3,
        reason: "x",
      }),
    );
    expect(unsigned.status).toBe(401);
    const unknown = await declineRoute(
      await signedPost(agent, "/api/offers/decline", {
        url: `https://${tag("nosite")}.example/a`,
        priceCents: 3,
        reason: "Off topic",
      }),
    );
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).error).toBe("unknown_site");
    const invalid = await declineRoute(
      await signedPost(agent, "/api/offers/decline", { url: "not a url", priceCents: -1 }),
    );
    expect(invalid.status).toBe(400);
  });

  it("caps the body and the notes per key per minute", async () => {
    const publisher = await makeSite();
    const agent = await makeKey();
    const big = await declineRoute(
      await signedPost(
        agent,
        "/api/offers/decline",
        JSON.stringify({ reason: "x".repeat(SIGNAL_BODY_LIMITS.decline) }),
      ),
    );
    expect(big.status).toBe(413);

    resetSignalLimits();
    for (let i = 0; i < SIGNAL_RATE_LIMITS.declinesPerKey; i++) {
      const ok = await declineRoute(
        await signedPost(agent, "/api/offers/decline", {
          url: `${publisher.origin}/articles/p-${i}`,
          priceCents: 3,
          reason: "Too pricey",
        }),
      );
      expect(ok.status).toBe(200);
    }
    const limited = await declineRoute(
      await signedPost(agent, "/api/offers/decline", {
        url: `${publisher.origin}/articles/one-more`,
        priceCents: 3,
        reason: "Too pricey",
      }),
    );
    expect(limited.status).toBe(429);
  });
});

describe("POST /api/citations", () => {
  it("records the key owner's receipts and rejects others'", async () => {
    const publisher = await makeSite();
    const agent = await makeKey();
    const stranger = await makeKey();

    const requirements = requirementsFor(publisher.site.id, 3);
    const paid = await settle(
      postJson(
        `${BOTFARE_URL}/api/x402/settle`,
        facilitatorBody(await signPayment(agent.client, requirements), requirements),
        publisher.auth,
      ),
    );
    const receiptId = (await paid.json()).transaction as string;
    const strangerPaid = await settle(
      postJson(
        `${BOTFARE_URL}/api/x402/settle`,
        facilitatorBody(await signPayment(stranger.client, requirements), requirements),
        publisher.auth,
      ),
    );
    const strangerReceipt = (await strangerPaid.json()).transaction as string;

    const response = await citationsRoute(
      await signedPost(agent, "/api/citations", {
        answerId: tag("answer"),
        citations: [
          { receiptId, claim: "Grind finer for espresso" },
          { receiptId: strangerReceipt },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      recorded: 1,
      rejected: [strangerReceipt],
    });

    const inputs = await advisorInputs(getDb(), {
      publisherUserId: publisher.owner.id,
      siteId: publisher.site.id,
    });
    expect(inputs?.totals.cited).toBe(1);

    // The analytics dashboard shows the citation (joined to its receipt) and decline notes,
    // only to this publisher.
    await declineRoute(
      await signedPost(agent, "/api/offers/decline", {
        url: `${publisher.origin}/articles/premium-roundup`,
        priceCents: 50,
        category: "too_expensive",
        reason: "Too much for a roundup",
      }),
    );
    const analytics = await getPublisherAnalytics(getDb(), publisher.owner.id);
    expect(analytics.citations).toEqual([
      expect.objectContaining({
        receiptId,
        path: "/articles/grinders",
        agentName: "signals agent",
        claim: "Grind finer for espresso",
      }),
    ]);
    expect(analytics.rows.map((row) => row.receiptId)).toContain(receiptId);
    expect(analytics.declines).toEqual([
      expect.objectContaining({
        path: "/articles/premium-roundup",
        category: "Too expensive",
        reason: "Too much for a roundup",
        priceUsd: 0.5,
      }),
    ]);
    const outsider = await makeSite();
    const theirs = await getPublisherAnalytics(getDb(), outsider.owner.id);
    expect(theirs.citations).toEqual([]);
    expect(theirs.declines).toEqual([]);
  });

  it("refuses unsigned or malformed reports and limits reports per key", async () => {
    const agent = await makeKey();
    const unsigned = await citationsRoute(
      postJson(`${BOTFARE_URL}/api/citations`, { answerId: "a".repeat(10), citations: [] }),
    );
    expect(unsigned.status).toBe(401);
    const invalid = await citationsRoute(
      await signedPost(agent, "/api/citations", { answerId: "short", citations: [] }),
    );
    expect(invalid.status).toBe(400);

    resetSignalLimits();
    for (let i = 0; i < SIGNAL_RATE_LIMITS.citationsPerKey; i++) {
      await citationsRoute(await signedPost(agent, "/api/citations", { answerId: "short" }));
    }
    const limited = await citationsRoute(
      await signedPost(agent, "/api/citations", { answerId: "short" }),
    );
    expect(limited.status).toBe(429);
  });
});
