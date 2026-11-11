import type Anthropic from "@anthropic-ai/sdk";
import {
  createAgentKey,
  createSite,
  createUser,
  getSite,
  recordDecline,
  recordOfferTelemetry,
  type User,
} from "@botfare/core";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers run outside Next: no "server-only" guard, and the session is whoever the test says.
vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ user: null as User | null }));
vi.mock("../src/lib/server/session", () => ({
  requireApiUser: async () =>
    session.user
      ? { user: session.user }
      : { response: Response.json({ error: "unauthorized" }, { status: 401 }) },
}));

import { POST as applyRoute } from "../src/app/api/publisher/advisor/apply/route";
import { GET as advisorRoute } from "../src/app/api/publisher/advisor/route";
import { closeDb, getDb } from "../src/lib/server/db";
import {
  type AdvisorModel,
  type AdvisorModelParams,
  getAdvisor,
  resetAdvisorState,
} from "../src/lib/server/fare-advisor";
import { useTestDatabase } from "./helpers";

const BASE = "http://botfare.test";
const savedKey = process.env.ANTHROPIC_API_KEY;

function tag(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A publisher whose premium page 23 agents saw and 14 declined, 9 calling it thin. */
async function makeAdvisedSite() {
  const db = getDb();
  const name = tag("advisor-pub");
  const owner = await createUser(db, { email: `${name}@example.test`, name });
  const origin = `https://${name}.example`;
  const { site } = await createSite(db, {
    ownerUserId: owner.id,
    name: "Crema Notes (advisor test)",
    origin,
    pricing: [
      { pattern: "/articles/premium-*", priceCents: 50, description: "Premium roundup" },
      { pattern: "/articles/*", priceCents: 3 },
    ],
  });
  const at = new Date().toISOString();
  await recordOfferTelemetry(db, site.id, {
    events: Array.from({ length: 23 }, () => ({
      path: "/articles/premium-roundup",
      method: "GET",
      priceCents: 50,
      signal: "agent-header",
      at,
    })),
  });
  // Fourteen agents (one note per owner and page here; core caps each owner per page and day).
  for (let i = 0; i < 14; i++) {
    const thin = i < 9;
    const agentOwner = await createUser(db, { email: `${name}-agent${i}@example.test`, name });
    const key = await createAgentKey(db, {
      ownerUserId: agentOwner.id,
      name: "advisor agent",
      publicJwk: (await generateAgentKeyPair()).publicJwk,
    });
    await recordDecline(db, {
      agentKeyId: key.id,
      note: {
        url: `${origin}/articles/premium-roundup`,
        priceCents: 50,
        category: thin ? "low_quality_preview" : "too_expensive",
        reason: thin ? "Thin listicle, no specifics" : "Too much for a roundup",
      },
    });
  }
  return { owner, site };
}

function message(text: string): Anthropic.Beta.Messages.BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 300 },
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

/** A scripted model that recommends 8¢ for the premium rule, quoting the real counts. */
function scriptedModel() {
  const calls: AdvisorModelParams[] = [];
  const model: AdvisorModel = {
    model: "claude-sonnet-5-5",
    label: "Anthropic",
    client: {
      beta: {
        messages: {
          create: async (params) => {
            calls.push(params);
            const answer = {
              recommendations: [
                {
                  pattern: "/articles/premium-*",
                  kind: "price",
                  currentPriceCents: 50,
                  suggestedPriceCents: 8,
                  headline: "0 of 23 agents bought at 50¢; 9 called it a thin listicle",
                  rationale: "None of the 23 offers sold, and 14 agents said why.",
                  evidence: {
                    offers: 23,
                    paid: 0,
                    declined: 14,
                    cited: 0,
                    disputed: 0,
                    topReasons: [{ reason: "Thin listicle, no specifics", count: 9 }],
                  },
                  projectedWeeklyRevenueDeltaCents: 40,
                  confidence: 0.7,
                },
                {
                  pattern: "/articles/premium-*",
                  kind: "preview",
                  currentPriceCents: 50,
                  previewAdvice: "Say which grinders are compared.",
                  headline: "1,000 agents want a better preview",
                  rationale: "Invented.",
                  evidence: {
                    offers: 23,
                    paid: 0,
                    declined: 14,
                    cited: 0,
                    disputed: 0,
                    topReasons: [],
                  },
                  projectedWeeklyRevenueDeltaCents: 0,
                  confidence: 0.4,
                },
              ],
            };
            return message(JSON.stringify(answer));
          },
        },
      },
    },
  };
  return { model, calls };
}

function getAdvisorRequest(query: string): Request {
  return new Request(`${BASE}/api/publisher/advisor?${query}`);
}

function applyRequest(body: unknown): Request {
  return new Request(`${BASE}/api/publisher/advisor/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(useTestDatabase);
beforeEach(() => {
  resetAdvisorState();
  session.user = null;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});
afterAll(async () => {
  resetAdvisorState();
  await closeDb();
});

describe("GET /api/publisher/advisor", () => {
  it("needs a session, a siteId, and the user's own site", async () => {
    const { owner, site } = await makeAdvisedSite();
    expect((await advisorRoute(getAdvisorRequest(`siteId=${site.id}`))).status).toBe(401);

    session.user = owner;
    expect((await advisorRoute(getAdvisorRequest(""))).status).toBe(400);

    const other = await makeAdvisedSite();
    session.user = other.owner;
    const foreign = await advisorRoute(getAdvisorRequest(`siteId=${site.id}`));
    expect(foreign.status).toBe(404);
  });

  it("without an Anthropic key shows the funnel and says AI needs a key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { owner, site } = await makeAdvisedSite();
    session.user = owner;
    const response = await advisorRoute(getAdvisorRequest(`siteId=${site.id}&ai=1`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      siteId: site.id,
      aiAvailable: false,
      aiStatus: "unavailable",
      recommendations: [],
    });
    expect(body.aiMessage).toMatch(/Anthropic key/);
    const premium = body.inputsSummary.rules[0];
    expect(premium).toMatchObject({
      pattern: "/articles/premium-*",
      priceCents: 50,
      offers: 23,
      paid: 0,
      declined: 14,
    });
    expect(premium.topReasons[0]).toEqual({ reason: "Thin listicle, no specifics", count: 9 });
    expect(body.inputsSummary.declinedByCategory).toEqual({
      low_quality_preview: 9,
      too_expensive: 5,
    });
  });
});

describe("getAdvisor with a model", () => {
  it("generates only when asked, caches per site, and drops invented suggestions", async () => {
    const { owner, site } = await makeAdvisedSite();
    const fake = scriptedModel();
    const options = { user: owner, siteId: site.id, model: fake.model };

    const first = await getAdvisor(getDb(), options);
    expect(first?.aiStatus).toBe("pending");
    expect(fake.calls).toHaveLength(0);

    const generated = await getAdvisor(getDb(), { ...options, ai: true });
    expect(generated?.aiStatus).toBe("ready");
    expect(generated?.aiLabel).toBe("Anthropic");
    expect(generated?.dropped).toBe(1);
    expect(generated?.recommendations.map((r) => [r.kind, r.suggestedPriceCents])).toEqual([
      ["price", 8],
    ]);
    expect(generated?.recommendations[0]?.projectedWeeklyRevenueDeltaCents).toBeGreaterThan(0);

    const cached = await getAdvisor(getDb(), { ...options, ai: true });
    expect(cached?.generatedAt).toBe(generated?.generatedAt);
    expect(fake.calls).toHaveLength(1);

    await getAdvisor(getDb(), { ...options, refresh: true, ai: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("does not call the model for a site with no signals yet", async () => {
    const db = getDb();
    const name = tag("advisor-empty");
    const owner = await createUser(db, { email: `${name}@example.test`, name });
    const { site } = await createSite(db, {
      ownerUserId: owner.id,
      name: "Quiet Roasters",
      origin: `https://${name}.example`,
      pricing: [{ pattern: "/beans/*", priceCents: 2 }],
    });
    const fake = scriptedModel();
    const advisor = await getAdvisor(db, {
      user: owner,
      siteId: site.id,
      ai: true,
      model: fake.model,
    });
    expect(advisor?.aiStatus).toBe("insufficient_data");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("POST /api/publisher/advisor/apply", () => {
  it("changes the owner's rule, bumps the config version and invalidates the cache", async () => {
    const { owner, site } = await makeAdvisedSite();
    const fake = scriptedModel();
    await getAdvisor(getDb(), { user: owner, siteId: site.id, ai: true, model: fake.model });

    session.user = owner;
    const response = await applyRoute(
      applyRequest({
        siteId: site.id,
        pattern: "/articles/premium-*",
        method: "GET",
        priceCents: 8,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.changed).toBe(true);
    expect(body.before[0]).toMatchObject({ pattern: "/articles/premium-*", priceCents: 50 });
    expect(body.after[0]).toMatchObject({ pattern: "/articles/premium-*", priceCents: 8 });
    expect(body.site.version).not.toBe(site.version);
    expect(body.site.pricing[1]).toMatchObject({ pattern: "/articles/*", priceCents: 3 });

    const stored = await getSite(getDb(), site.id);
    expect(stored?.pricing[0]?.priceCents).toBe(8);
    expect(stored?.version).toBe(body.site.version);

    // Right after the change no agent has seen 8¢: the 50¢ funnel is kept apart, not shown as 8¢,
    // and the model is not asked about it.
    const after = await getAdvisor(getDb(), { user: owner, siteId: site.id, model: fake.model });
    expect(after?.aiStatus).toBe("insufficient_data");
    expect(after?.aiMessage).toMatch(/Prices changed recently/);
    expect(after?.inputsSummary.rules[0]).toMatchObject({
      priceCents: 8,
      offers: 0,
      declined: 0,
      topReasons: [],
      earlier: { priceCents: [50], offers: 23, paid: 0, declined: 14 },
      awaitingSignals: true,
    });

    // Once agents see 8¢, the cached recommendations (for the old price) are not reused.
    await recordOfferTelemetry(getDb(), site.id, {
      events: [
        {
          path: "/articles/premium-roundup",
          method: "GET",
          priceCents: 8,
          signal: "agent-header",
          at: new Date().toISOString(),
        },
      ],
    });
    const seen = await getAdvisor(getDb(), { user: owner, siteId: site.id, model: fake.model });
    expect(seen?.aiStatus).toBe("pending");
    expect(seen?.inputsSummary.rules[0]).toMatchObject({ offers: 1, awaitingSignals: false });

    const again = await applyRoute(
      applyRequest({ siteId: site.id, pattern: "/articles/premium-*", priceCents: 8 }),
    );
    expect((await again.json()).changed).toBe(false);
  });

  it("refuses other publishers, unknown patterns, bad bodies and anonymous calls", async () => {
    const { owner, site } = await makeAdvisedSite();
    const other = await makeAdvisedSite();

    expect(
      (await applyRoute(applyRequest({ siteId: site.id, pattern: "/articles/*", priceCents: 4 })))
        .status,
    ).toBe(401);

    session.user = other.owner;
    const foreign = await applyRoute(
      applyRequest({ siteId: site.id, pattern: "/articles/*", priceCents: 1 }),
    );
    expect(foreign.status).toBe(404);
    expect((await getSite(getDb(), site.id))?.pricing[1]?.priceCents).toBe(3);

    session.user = owner;
    const unknown = await applyRoute(
      applyRequest({ siteId: site.id, pattern: "/made-up/*", priceCents: 4 }),
    );
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).error).toBe("unknown_pattern");

    for (const bad of [
      { siteId: site.id, pattern: "/articles/*" },
      { siteId: site.id, pattern: "/articles/*", priceCents: 0 },
      { siteId: site.id, pattern: "/articles/*", priceCents: 10_001 },
      { siteId: site.id, pattern: "articles", priceCents: 4 },
      { siteId: site.id, pattern: "/articles/*", audience: "humans" },
    ]) {
      expect((await applyRoute(applyRequest(bad))).status, JSON.stringify(bad)).toBe(400);
    }

    const audience = await applyRoute(
      applyRequest({ siteId: site.id, pattern: "/articles/*", audience: "everyone" }),
    );
    expect(audience.status).toBe(200);
    expect((await audience.json()).after[0]).toMatchObject({ audience: "everyone", priceCents: 3 });
  });
});
