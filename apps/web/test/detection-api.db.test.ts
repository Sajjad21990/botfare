import {
  CREMA_NOTES_DETECTION,
  DEFAULT_DETECTION,
  DEMO_PERSONAS,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
} from "@botfare/contracts";
import {
  createSite,
  createUser,
  getSite,
  getSiteConfig,
  getUserByEmail,
  listSites,
  PostgresPrepaidLedger,
  type User,
} from "@botfare/core";
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

import {
  GET as readDetection,
  PUT as saveDetection,
} from "../src/app/api/publisher/sites/[siteId]/detection/route";
import { GET as summary } from "../src/app/api/publisher/summary/route";
import { POST as signInAsPersona } from "../src/app/api/session/persona/route";
import { listPublisherReceiptRows } from "../src/lib/server/analytics-receipts";
import { closeDb, getDb } from "../src/lib/server/db";
import { makeAgent, makePublisher, requirementsFor, useTestDatabase } from "./helpers";

const BASE = "http://botfare.test";

function json(method: string, body?: unknown): Request {
  return new Request(`${BASE}/x`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const siteParams = (siteId: string) => ({ params: Promise.resolve({ siteId }) });

let counter = 0;
async function makeUser(): Promise<User> {
  counter += 1;
  const tag = `detect-api-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  return createUser(getDb(), { email: `${tag}@example.test`, name: tag });
}

beforeAll(useTestDatabase);
afterEach(() => {
  session.user = null;
});
afterAll(closeDb);

describe("PUT /api/publisher/sites/[siteId]/detection", () => {
  it("saves the owner's settings, fills defaults and bumps the config version", async () => {
    const publisher = await makePublisher(getDb());
    session.user = publisher.owner;

    const res = await saveDetection(
      json("PUT", {
        level: "standard",
        threshold: 55,
        edge: { cloudflare: { enabled: true, scoreHeader: " CF-Bot-Score " } },
        turnstileSiteKey: "  0x4AAAAAAAfictional  ",
      }),
      siteParams(publisher.site.id),
    );
    expect(res.status).toBe(200);
    const { site } = await res.json();
    expect(site.detection).toEqual({
      level: "standard",
      threshold: 55,
      edge: {
        cloudflare: {
          enabled: true,
          scoreHeader: "cf-bot-score",
          verifiedBotHeader: "cf-verified-bot",
          maxBotScore: 29,
        },
        akamai: { enabled: false, header: "akamai-bot" },
      },
      turnstileSiteKey: "0x4AAAAAAAfictional",
    });
    expect(site.version).not.toBe(publisher.site.version);
    const config = await getSiteConfig(getDb(), publisher.site.id);
    expect(config?.detection).toEqual(site.detection);
    expect(config?.version).toBe(site.version);

    // An empty site key turns the human check off.
    const cleared = await saveDetection(
      json("PUT", { level: "known-bots", turnstileSiteKey: "" }),
      siteParams(publisher.site.id),
    );
    expect((await cleared.json()).site.detection).toEqual(DEFAULT_DETECTION);

    // The dashboard summary carries the settings.
    const body = await (await summary()).json();
    expect(body.sites.find((s: { id: string }) => s.id === publisher.site.id)?.detection).toEqual(
      DEFAULT_DETECTION,
    );
  });

  it("refuses other users, signed-out callers and invalid settings", async () => {
    const publisher = await makePublisher(getDb());
    const before = await getSite(getDb(), publisher.site.id);

    expect(
      (await saveDetection(json("PUT", { level: "off" }), siteParams(publisher.site.id))).status,
    ).toBe(401);

    session.user = await makeUser();
    const stranger = await saveDetection(
      json("PUT", { level: "off" }),
      siteParams(publisher.site.id),
    );
    expect(stranger.status).toBe(404);
    expect((await readDetection(json("GET"), siteParams(publisher.site.id))).status).toBe(404);

    session.user = publisher.owner;
    for (const bad of [
      { level: "paranoid" },
      { level: "standard", threshold: 0 },
      { level: "standard", threshold: 101 },
      { level: "standard", threshold: 12.5 },
      { edge: { cloudflare: { enabled: true, maxBotScore: 100 } } },
      { edge: { cloudflare: { enabled: true, scoreHeader: "cf bot score" } } },
      { edge: { akamai: { enabled: true, header: "" } } },
      { turnstileSiteKey: "<script>" },
    ]) {
      const res = await saveDetection(json("PUT", bad), siteParams(publisher.site.id));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const notJson = await saveDetection(
      new Request(`${BASE}/x`, { method: "PUT", body: "{" }),
      siteParams(publisher.site.id),
    );
    expect(notJson.status).toBe(400);
    expect(await getSite(getDb(), publisher.site.id)).toEqual(before);
  });

  it("reports revenue per detection signal for the owner's site", async () => {
    const publisher = await makePublisher(getDb());
    const agent = await makeAgent(getDb(), 100);
    // Charged straight through the ledger with the signal the middleware would set.
    const ledger = new PostgresPrepaidLedger(getDb());
    const requirements = requirementsFor(publisher.site.id, 10);
    for (const signal of ["automation", "automation", "nonsense"]) {
      const result = await ledger.charge({
        keyId: agent.key.id,
        nonce: crypto.randomUUID(),
        amountCents: Number(requirements.amount),
        payTo: publisher.site.id,
        network: requirements.network,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        extra: { botfareSignal: signal },
      });
      expect(result.ok).toBe(true);
    }

    session.user = publisher.owner;
    const res = await readDetection(json("GET"), siteParams(publisher.site.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      detection: DEFAULT_DETECTION,
      revenueBySignal: [
        { signal: "automation", paidRequests: 2, earningsMicros: 190_000 },
        { signal: null, paidRequests: 1, earningsMicros: 95_000 },
      ],
    });

    // Analytics rows carry the signal in words; unknown values read "Not recorded".
    const rows = await listPublisherReceiptRows(getDb(), publisher.owner.id);
    expect(rows.map((row) => row.detectionSignal).sort()).toEqual([
      "Automation signals",
      "Automation signals",
      "Not recorded",
    ]);
  });

  it("lets the judge-mode publisher change detection, and restores it at the next sign-in", async () => {
    const signIn = async () => {
      const res = await signInAsPersona(
        new Request(`${BASE}/api/session/persona`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ persona: "publisher" }),
        }),
      );
      expect(res.status).toBe(200);
      const user = await getUserByEmail(getDb(), DEMO_PERSONAS.publisher.email);
      if (!user) throw new Error("persona missing");
      session.user = user;
      return user;
    };
    const publisher = await signIn();
    const site =
      (await listSites(getDb(), publisher.id)).find((s) => s.name === DEMO_SITE_NAME) ??
      (
        await createSite(getDb(), {
          ownerUserId: publisher.id,
          name: DEMO_SITE_NAME,
          origin: "https://saffron-and-salt.example",
          pricing: DEMO_SITE_PRICING,
          freePaths: DEMO_SITE_FREE_PATHS,
          detection: CREMA_NOTES_DETECTION,
        })
      ).site;

    const res = await saveDetection(
      json("PUT", { level: "off", turnstileSiteKey: null }),
      siteParams(site.id),
    );
    expect(res.status).toBe(200);
    expect((await getSite(getDb(), site.id))?.detection.level).toBe("off");

    await signIn();
    const restored = await getSite(getDb(), site.id);
    expect(restored?.detection).toEqual(CREMA_NOTES_DETECTION);
    expect((await getSiteConfig(getDb(), site.id))?.detection).toEqual(CREMA_NOTES_DETECTION);
  });
});
