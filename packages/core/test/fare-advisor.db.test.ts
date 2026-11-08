import { DEMO_SITE_NAME, DEMO_SITE_PRICING } from "@botfare/contracts";
import { contentDigestSha256 } from "@botfare/contracts/fare";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ADVISOR_LIMITS,
  advisorInputs,
  applyPriceChange,
  applyVerdict,
  attestReceipt,
  createAgentKey,
  createSite,
  getSite,
  openDispute,
  PostgresPrepaidLedger,
  recordCitations,
  recordDecline,
  recordOfferTelemetry,
  refundReceipt,
  resetDemoPublisher,
  schema,
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

const DAY = 24 * 3_600_000;

/** A publisher with its own origin (declines are matched to sites by origin). */
async function makeSite(pricing = DEMO_SITE_PRICING) {
  const owner = await makeUser(db, "publisher");
  const origin = `https://${crypto.randomUUID().slice(0, 8)}.crema.example`;
  const { site } = await createSite(db, {
    ownerUserId: owner.id,
    name: "Crema Notes test",
    origin,
    pricing,
  });
  return { owner, site, origin };
}

async function buy(keyId: string, siteId: string, url: string, amountCents = 3) {
  const result = await ledger.charge(
    chargeRequest(keyId, siteId, { resourceUrl: url, amountCents }),
  );
  if (!result.ok) throw new Error(`charge failed: ${result.reason}`);
  return result.transaction;
}

function event(path: string, at: Date, priceCents = 50) {
  return { path, method: "GET", priceCents, signal: "signed-agent" as const, at: at.toISOString() };
}

describe("recordOfferTelemetry", () => {
  it("stores bounded batches and drops future and ancient events", async () => {
    const { site } = await makeSite();
    const now = new Date();
    const result = await recordOfferTelemetry(db, site.id, {
      events: [
        event("/articles/premium-roundup?utm=x", now),
        event("/articles/premium-roundup", new Date(now.getTime() - DAY)),
        event(
          "/articles/future",
          new Date(now.getTime() + ADVISOR_LIMITS.telemetryMaxFutureMs + 60_000),
        ),
        event(
          "/articles/ancient",
          new Date(now.getTime() - ADVISOR_LIMITS.telemetryMaxAgeMs - 60_000),
        ),
      ],
    });
    expect(result).toEqual({ ok: true, accepted: 2, dropped: 2 });
    const rows = await db
      .select()
      .from(schema.offerEvents)
      .where(eq(schema.offerEvents.siteId, site.id));
    expect(rows.map((r) => r.path)).toEqual([
      "/articles/premium-roundup",
      "/articles/premium-roundup",
    ]);
    expect(rows[0]).toMatchObject({ method: "GET", priceCents: 50, signal: "signed-agent" });
  });

  it("refuses invalid batches, oversized batches and unknown sites", async () => {
    const { site } = await makeSite();
    const now = new Date();
    expect(await recordOfferTelemetry(db, site.id, { events: [] })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      await recordOfferTelemetry(db, site.id, {
        events: Array.from({ length: 501 }, () => event("/articles/a", now)),
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await recordOfferTelemetry(db, site.id, {
        events: [{ ...event("/a", now), path: "no-slash" }],
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await recordOfferTelemetry(db, "site_missing", { events: [event("/a", now)] }),
    ).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("recordDecline", () => {
  it("maps the URL to a registered site and path, once per key, URL and UTC day", async () => {
    const { site, origin } = await makeSite();
    const agent = await makeAgent(db);
    const note = {
      url: `${origin}/articles/premium-roundup?ref=feed#top`,
      priceCents: 50,
      category: "low_quality_preview" as const,
      reason: "Thin listicle",
    };
    const first = await recordDecline(db, { agentKeyId: agent.key.id, note });
    expect(first).toEqual({
      ok: true,
      recorded: true,
      siteId: site.id,
      path: "/articles/premium-roundup",
    });
    expect(await recordDecline(db, { agentKeyId: agent.key.id, note })).toMatchObject({
      ok: true,
      recorded: false,
    });
    expect(
      await recordDecline(db, { agentKeyId: agent.key.id, note, now: new Date(Date.now() + DAY) }),
    ).toMatchObject({ ok: true, recorded: true });
    expect(
      await recordDecline(db, {
        agentKeyId: agent.key.id,
        note: { ...note, url: `${origin}/articles/other` },
      }),
    ).toMatchObject({ ok: true, recorded: true });

    const [row] = await db
      .select()
      .from(schema.offerDeclines)
      .where(eq(schema.offerDeclines.siteId, site.id))
      .limit(1);
    expect(row).toMatchObject({
      url: `${origin}/articles/premium-roundup?ref=feed`,
      category: "low_quality_preview",
      reason: "Thin listicle",
      priceCents: 50,
    });
  });

  it("refuses unknown sites and keys, invalid notes, and too many notes a day", async () => {
    const { origin } = await makeSite();
    const agent = await makeAgent(db);
    const note = { url: `${origin}/articles/a`, priceCents: 3, reason: "Not relevant" };
    expect(
      await recordDecline(db, {
        agentKeyId: agent.key.id,
        note: { ...note, url: "https://unregistered.example/articles/a" },
      }),
    ).toMatchObject({ ok: false, reason: "unknown_site" });
    expect(await recordDecline(db, { agentKeyId: "ak_missing", note })).toMatchObject({
      ok: false,
      reason: "unknown_key",
    });
    expect(
      await recordDecline(db, { agentKeyId: agent.key.id, note: { ...note, reason: "" } }),
    ).toMatchObject({ ok: false, reason: "invalid" });

    const { site } = await makeSite();
    const day = new Date().toISOString().slice(0, 10);
    await db.insert(schema.offerDeclines).values(
      Array.from({ length: ADVISOR_LIMITS.maxDeclinesPerKeyPerDay }, (_, i) => ({
        agentKeyId: agent.key.id,
        siteId: site.id,
        url: `${origin}/bulk/${i}`,
        path: `/bulk/${i}`,
        priceCents: 3,
        category: "other" as const,
        reason: "bulk",
        day,
      })),
    );
    expect(await recordDecline(db, { agentKeyId: agent.key.id, note })).toMatchObject({
      ok: false,
      reason: "rate_limited",
    });
  });
});

describe("recordCitations", () => {
  it("accepts only receipts paid by the key's owner, and replaces reports with the same answer ID", async () => {
    const { site, origin } = await makeSite();
    const agent = await makeAgent(db, { balanceCents: 100 });
    const sibling = await createAgentKey(db, {
      ownerUserId: agent.owner.id,
      name: "sibling",
      publicJwk: (await generateAgentKeyPair()).publicJwk,
    });
    const stranger = await makeAgent(db, { balanceCents: 100 });
    const mine = await buy(agent.key.id, site.id, `${origin}/articles/grinders`);
    const siblings = await buy(sibling.id, site.id, `${origin}/articles/kettles`);
    const theirs = await buy(stranger.key.id, site.id, `${origin}/articles/grinders`);
    const answerId = `ans-${crypto.randomUUID()}`;

    const first = await recordCitations(db, {
      agentKeyId: agent.key.id,
      report: {
        answerId,
        citations: [
          { receiptId: mine, claim: "Burr grinders give even grounds" },
          { receiptId: siblings },
          { receiptId: theirs, claim: "stolen" },
          { receiptId: mine, claim: "duplicate" },
        ],
      },
    });
    expect(first).toEqual({ ok: true, recorded: 2, rejected: [theirs] });

    const replaced = await recordCitations(db, {
      agentKeyId: agent.key.id,
      report: { answerId, citations: [{ receiptId: mine, claim: "Updated claim" }] },
    });
    expect(replaced).toEqual({ ok: true, recorded: 1, rejected: [] });
    const rows = await db
      .select()
      .from(schema.citations)
      .where(eq(schema.citations.answerId, answerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ receiptId: mine, claim: "Updated claim", siteId: site.id });

    expect(
      await recordCitations(db, {
        agentKeyId: stranger.key.id,
        report: { answerId: `ans-${crypto.randomUUID()}`, citations: [{ receiptId: mine }] },
      }),
    ).toEqual({ ok: true, recorded: 0, rejected: [mine] });
    expect(
      await recordCitations(db, {
        agentKeyId: agent.key.id,
        report: { answerId: "short", citations: [] },
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await recordCitations(db, {
        agentKeyId: "ak_missing",
        report: { answerId, citations: [{ receiptId: mine }] },
      }),
    ).toMatchObject({ ok: false, reason: "unknown_key" });
  });
});

describe("advisorInputs", () => {
  it("aggregates offers, purchases, declines, citations and disputes per rule and per path", async () => {
    const { owner, site, origin } = await makeSite();
    const now = new Date();
    const premium = "/articles/premium-roundup";

    // 23 offers of the premium roundup at 50¢, 4 of an article at 3¢, 2 of a free-for-all path.
    await recordOfferTelemetry(db, site.id, {
      events: [
        ...Array.from({ length: 23 }, () => event(premium, now)),
        ...Array.from({ length: 4 }, () => event("/articles/grinders", now, 3)),
        ...Array.from({ length: 2 }, () => event("/unpriced/page", now, 3)),
      ],
    });
    // An offer from before the window does not count.
    await db.insert(schema.offerEvents).values({
      siteId: site.id,
      path: premium,
      method: "GET",
      priceCents: 50,
      at: new Date(now.getTime() - 20 * DAY),
    });

    // 14 "thin listicle" declines (4 keys over several days) and 2 "too expensive".
    const owner2 = await makeAgent(db, { balanceCents: 100 });
    const keys = [owner2.key.id];
    for (let i = 0; i < 3; i++) {
      keys.push(
        (
          await createAgentKey(db, {
            ownerUserId: owner2.owner.id,
            name: `key ${i}`,
            publicJwk: (await generateAgentKeyPair()).publicJwk,
          })
        ).id,
      );
    }
    let declines = 0;
    for (let day = 0; declines < 14; day++) {
      for (const keyId of keys) {
        if (declines === 14) break;
        await recordDecline(db, {
          agentKeyId: keyId,
          note: {
            url: `${origin}${premium}`,
            priceCents: 50,
            category: "low_quality_preview",
            reason: declines % 2 ? "Thin listicle" : "thin listicle",
          },
          now: new Date(now.getTime() - day * DAY),
        });
        declines += 1;
      }
    }
    for (const keyId of keys.slice(0, 2)) {
      await recordDecline(db, {
        agentKeyId: keyId,
        note: {
          url: `${origin}/articles/premium-other`,
          priceCents: 50,
          category: "too_expensive",
          reason: "50¢ is too much",
        },
      });
    }

    // Purchases on /articles/grinders: 3 at 3¢, one refunded; one cited; one disputed.
    const bought = [
      await buy(owner2.key.id, site.id, `${origin}/articles/grinders`),
      await buy(owner2.key.id, site.id, `${origin}/articles/grinders`),
      await buy(owner2.key.id, site.id, `${origin}/articles/grinders?page=2`),
    ];
    await refundReceipt(db, { receiptId: bought[2] as string, siteId: site.id });
    await recordCitations(db, {
      agentKeyId: owner2.key.id,
      report: {
        answerId: `ans-${crypto.randomUUID()}`,
        citations: [{ receiptId: bought[0] as string }],
      },
    });
    const body = "<p>Grinders</p>";
    for (const receiptId of bought.slice(0, 2) as string[]) {
      await attestReceipt(db, {
        siteId: site.id,
        receiptId,
        attestation: {
          contentDigest: await contentDigestSha256(body),
          contentLength: body.length,
          contentType: "text/html",
          status: 200,
        },
      });
    }
    const opened = await openDispute(db, {
      agentKeyId: owner2.key.id,
      request: {
        receiptId: bought[1] as string,
        reason: "truncated",
        contentBase64: Buffer.from(body).toString("base64"),
      },
    });
    if (!opened.ok) throw new Error(opened.reason);
    await applyVerdict(db, { disputeId: opened.dispute.id, verdict: null });
    // An invalid dispute (wrong bytes) is listed by status but not counted as disputed.
    const invalid = await openDispute(db, {
      agentKeyId: owner2.key.id,
      request: {
        receiptId: bought[0] as string,
        reason: "other",
        contentBase64: Buffer.from("x").toString("base64"),
      },
    });
    expect(invalid).toMatchObject({ ok: false, reason: "digest_mismatch" });

    const inputs = await advisorInputs(db, { publisherUserId: owner.id, siteId: site.id });
    expect(inputs).not.toBeNull();
    if (!inputs) return;
    expect(inputs.days).toBe(14);
    expect(inputs.rules.map((r) => r.pattern)).toEqual(DEMO_SITE_PRICING.map((r) => r.pattern));

    const premiumRule = inputs.rules[0];
    expect(premiumRule).toMatchObject({
      pattern: "/articles/premium-*",
      priceCents: 50,
      audience: "agents",
      offers: 23,
      paid: 0,
      declined: 16,
      declinedByCategory: { low_quality_preview: 14, too_expensive: 2 },
      revenueCents: 0,
    });
    expect(premiumRule?.topReasons[0]).toEqual({ reason: "Thin listicle", count: 14 });
    expect(premiumRule?.paths.map((p) => p.path)).toEqual([premium, "/articles/premium-other"]);
    expect(premiumRule?.paths[0]).toMatchObject({ offers: 23, declined: 14 });

    const articles = inputs.rules[2];
    expect(articles).toMatchObject({
      pattern: "/articles/*",
      offers: 4,
      paid: 3,
      revenueCents: 6,
      refundedCents: 3,
      cited: 1,
      disputed: 1,
      disputesByStatus: { pending_publisher: 1, invalid: 1 },
    });
    expect(articles?.paths).toEqual([
      expect.objectContaining({
        path: "/articles/grinders",
        offers: 4,
        paid: 3,
        cited: 1,
        disputed: 1,
      }),
    ]);
    expect(inputs.unpriced).toEqual([
      expect.objectContaining({ path: "/unpriced/page", offers: 2 }),
    ]);
    expect(inputs.totals).toMatchObject({
      offers: 29,
      paid: 3,
      declined: 16,
      cited: 1,
      disputed: 1,
    });

    expect(
      await advisorInputs(db, { publisherUserId: owner2.owner.id, siteId: site.id }),
    ).toBeNull();
    const shortWindow = await advisorInputs(db, {
      publisherUserId: owner.id,
      siteId: site.id,
      days: 1,
    });
    expect(shortWindow?.rules[0]?.declined).toBeLessThan(16);
  });
});

describe("applyPriceChange", () => {
  it("updates the matching rule and bumps the config version", async () => {
    const { owner, site } = await makeSite();
    const result = await applyPriceChange(db, {
      siteId: site.id,
      ownerUserId: owner.id,
      pattern: "/articles/premium-*",
      priceCents: 8,
    });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      before: [expect.objectContaining({ priceCents: 50 })],
      after: [expect.objectContaining({ priceCents: 8, audience: "agents" })],
    });
    const updated = await getSite(db, site.id);
    expect(updated?.version).not.toBe(site.version);
    expect(updated?.pricing[0]).toMatchObject({ pattern: "/articles/premium-*", priceCents: 8 });
    expect(updated?.pricing.slice(1)).toEqual(site.pricing.slice(1));

    const same = await applyPriceChange(db, {
      siteId: site.id,
      ownerUserId: owner.id,
      pattern: "/articles/premium-*",
      priceCents: 8,
    });
    expect(same).toMatchObject({ ok: true, changed: false });
    expect((await getSite(db, site.id))?.version).toBe(updated?.version);

    const audience = await applyPriceChange(db, {
      siteId: site.id,
      ownerUserId: owner.id,
      pattern: "/api/brew-ratio",
      audience: "agents",
    });
    expect(audience).toMatchObject({
      ok: true,
      changed: true,
      after: [expect.objectContaining({ audience: "agents", priceCents: 1 })],
    });
  });

  it("refuses unknown patterns, other owners, empty and invalid changes", async () => {
    const { owner, site } = await makeSite();
    const other = await makePublisher(db);
    const base = { siteId: site.id, ownerUserId: owner.id, pattern: "/articles/*" };
    expect(
      await applyPriceChange(db, { ...base, pattern: "/nope/*", priceCents: 5 }),
    ).toMatchObject({
      ok: false,
      reason: "unknown_pattern",
    });
    expect(
      await applyPriceChange(db, { ...base, ownerUserId: other.owner.id, priceCents: 5 }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await applyPriceChange(db, base)).toMatchObject({
      ok: false,
      reason: "nothing_to_change",
    });
    for (const priceCents of [0, 1.5, 100_01]) {
      expect(await applyPriceChange(db, { ...base, priceCents })).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    }
    expect((await getSite(db, site.id))?.version).toBe(site.version);
  });

  it("lets the demo persona change the demo site's price, restored at the next sign-in", async () => {
    const owner = await makeUser(db, "publisher");
    const { site } = await createSite(db, {
      ownerUserId: owner.id,
      name: DEMO_SITE_NAME,
      origin: "https://crema-demo.example",
      pricing: DEMO_SITE_PRICING,
      freePaths: ["/", "/catalog.json", "/health", "/static/*", "/favicon.ico"],
    });
    const changed = await applyPriceChange(db, {
      siteId: site.id,
      ownerUserId: owner.id,
      pattern: "/articles/premium-*",
      priceCents: 8,
    });
    expect(changed).toMatchObject({ ok: true, changed: true });
    await resetDemoPublisher(db, { userId: owner.id, payoutEmail: null });
    expect((await getSite(db, site.id))?.pricing[0]?.priceCents).toBe(50);
  });
});
