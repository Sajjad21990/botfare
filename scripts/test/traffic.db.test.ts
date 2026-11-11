import { randomUUID } from "node:crypto";
import { DEMO_SITE_FREE_PATHS, DEMO_SITE_NAME, DEMO_SITE_PRICING } from "@botfare/contracts";
import {
  advisorInputs,
  checkLedgerInvariants,
  createSite,
  listDisputesForPublisher,
  listReceipts,
  walletBalanceMicros,
} from "@botfare/core";
import { afterAll, describe, expect, it } from "vitest";
import { FARE_COURT_STUB_PATH } from "../../apps/demo/src/app";
import { loadArticles } from "../../apps/demo/src/content";
import { NUTRITION_RECIPES as DEMO_NUTRITION_RECIPES } from "../../apps/demo/src/nutrition";
import { makeUser, openTestDb } from "../../packages/core/test/helpers";
import { runFareStory } from "../lib/fare-story";
import {
  DEMO_PAGES,
  demoPriceCents,
  NUTRITION_PATH,
  NUTRITION_RECIPES,
  nonceFor,
  planTraffic,
  runTraffic,
  weeklyRunKey,
} from "../lib/traffic";

const { db, close } = openTestDb();
afterAll(() => close());

const DAY_MS = 24 * 3600 * 1000;

async function demoSetup() {
  const owner = await makeUser(db, "traffic-owner");
  const publisher = await makeUser(db, "traffic-publisher");
  const { site } = await createSite(db, {
    ownerUserId: publisher.id,
    name: DEMO_SITE_NAME,
    // Decline notes find their site by origin: one per test, so earlier runs cannot take them.
    origin: `https://saffron-${randomUUID().slice(0, 8)}.example`,
    pricing: DEMO_SITE_PRICING,
    freePaths: DEMO_SITE_FREE_PATHS,
  });
  return { owner, publisher, site };
}

describe("seed:traffic", () => {
  it("plans each key's traffic on Saffron & Salt's pages at the demo's prices", () => {
    // Every planned page is one apps/demo serves, apart from the nutrition API.
    const pages = new Set(loadArticles().map((page) => page.path));
    for (const path of [...Object.values(DEMO_PAGES), FARE_COURT_STUB_PATH]) {
      expect(pages.has(path), `${path} is not in apps/demo/content`).toBe(true);
    }
    // The price watcher asks only for recipes the nutrition API knows (no 404s to pay for).
    for (const recipe of NUTRITION_RECIPES) expect(DEMO_NUTRITION_RECIPES).toContain(recipe);
    expect(demoPriceCents(DEMO_PAGES.dal)).toBe(2);
    expect(demoPriceCents(DEMO_PAGES.freezing)).toBe(5);
    expect(demoPriceCents(DEMO_PAGES.mealPlan)).toBe(8);
    expect(demoPriceCents(DEMO_PAGES.cookbook)).toBe(50);
    expect(demoPriceCents(`${NUTRITION_PATH}?recipe=crispy-oven-potatoes`)).toBe(1);
    expect(demoPriceCents("/recipes")).toBe(0);

    const plan = planTraffic("demo", new Date("2026-11-11T15:00:00Z"));
    expect(plan.length).toBeGreaterThan(100);
    const byKey = (name: string) => plan.filter((r) => r.key.name === name).map((r) => r.path);
    const research = byKey("Research agent");
    expect(research.every((p) => /^\/(recipes|techniques)\//.test(p))).toBe(true);
    expect(research).not.toContain(FARE_COURT_STUB_PATH);
    expect(research).toContain(DEMO_PAGES.dal);
    expect(research).toContain(DEMO_PAGES.freezing);
    const watcher = byKey("Price watcher");
    expect(watcher.length).toBeGreaterThan(20);
    expect(watcher.every((p) => p.startsWith(`${NUTRITION_PATH}?recipe=`))).toBe(true);
    const newsletter = byKey("Newsletter bot");
    expect(newsletter).toContain(DEMO_PAGES.mealPlan);
    expect(newsletter.every((p) => /^\/(meal-plans|techniques|cookbook)\//.test(p))).toBe(true);
    for (const request of plan) {
      expect(request.priceCents).toBe(demoPriceCents(request.path));
      expect(request.priceCents).toBeGreaterThan(0);
      expect(request.priceCents).toBeLessThanOrEqual(request.key.perRequestMaxCents);
    }
  });

  it("plans different traffic on different days, so the anchor has to be fixed", () => {
    const friday = new Date("2026-11-06T15:00:00Z");
    const saturday = new Date(friday.getTime() + DAY_MS);
    const a = planTraffic("demo", friday);
    const b = planTraffic("demo", saturday);
    const differs = a.some(
      (request, i) => b[i]?.key.name !== request.key.name || b[i]?.path !== request.path,
    );
    expect(differs || a.length !== b.length).toBe(true);
  });

  it("names the weekly refresh by ISO week", () => {
    expect(weeklyRunKey(new Date("2026-11-08T23:59:00Z"))).toBe("week-2026-W45"); // a Sunday
    expect(weeklyRunKey(new Date("2026-11-09T00:00:00Z"))).toBe("week-2026-W46"); // Monday
    expect(weeklyRunKey(new Date("2027-01-01T12:00:00Z"))).toBe("week-2026-W53");
    expect(weeklyRunKey(new Date("2026-01-01T12:00:00Z"))).toBe("week-2026-W01");
    expect(weeklyRunKey(new Date("2024-12-30T12:00:00Z"))).toBe("week-2025-W01");
  });

  it("moves no money when rerun with the same run key on a later day", async () => {
    const { owner, site } = await demoSetup();
    const first = new Date("2026-11-06T15:00:00Z");
    const run1 = await runTraffic(db, { runKey: "demo", ownerUserId: owner.id, site, now: first });
    expect(run1.funded).toBe(true);
    expect(run1.alreadyPaid).toBe(0);
    expect(run1.refunds).toBe(2);
    const balance = await walletBalanceMicros(db, owner.id);
    const receipts = (await listReceipts(db, { ownerUserId: owner.id, limit: 1000 })).length;
    expect(receipts).toBeGreaterThan(100);

    for (const later of [1, 3]) {
      const now = new Date(first.getTime() + later * DAY_MS);
      const rerun = await runTraffic(db, { runKey: "demo", ownerUserId: owner.id, site, now });
      expect(rerun.anchor).toEqual(first);
      expect(rerun.funded).toBe(false);
      expect(rerun.paid.size).toBe(0);
      expect(rerun.refunds).toBe(0);
      expect(rerun.plan.map((r) => nonceFor("demo", r.index))).toEqual(
        run1.plan.map((r) => nonceFor("demo", r.index)),
      );
      expect(rerun.plan.map((r) => [r.key.name, r.path, r.at.getTime()])).toEqual(
        run1.plan.map((r) => [r.key.name, r.path, r.at.getTime()]),
      );
    }
    expect(await walletBalanceMicros(db, owner.id)).toBe(balance);
    expect((await listReceipts(db, { ownerUserId: owner.id, limit: 1000 })).length).toBe(receipts);
    expect((await checkLedgerInvariants(db)).ok).toBe(true);
  });

  it("adds the Fare Court and Fare Advisor story once, consistent with the ledger", async () => {
    const { owner, publisher, site } = await demoSetup();
    const now = new Date("2026-11-08T15:00:00Z");
    const traffic = await runTraffic(db, { runKey: "story", ownerUserId: owner.id, site, now });
    const story = await runFareStory(db, {
      runKey: "story",
      ownerUserId: owner.id,
      site,
      anchor: traffic.anchor,
      trafficNonces: traffic.plan.map((r) => nonceFor("story", r.index)),
    });
    expect(story.stub.purchased).toBe(4);
    expect(story.stub.attested).toBe(4);
    expect(story.stub.disputes).toEqual({ refunded: 3, pending: 1, other: 0, alreadyFiled: 0 });
    expect(story.declines.recorded).toBeGreaterThan(10);
    expect(story.offers.skipped).toBe(false);
    expect(story.citations.cited).toBeGreaterThan(20);
    expect((await checkLedgerInvariants(db)).ok).toBe(true);

    const disputes = await listDisputesForPublisher(db, { publisherUserId: publisher.id });
    expect(disputes.map((d) => d.status).sort()).toEqual([
      "pending_publisher",
      "refunded",
      "refunded",
      "refunded",
    ]);
    expect(disputes.every((d) => d.contentDigestOk && d.declaredOffer?.title)).toBe(true);

    const inputs = await advisorInputs(db, {
      publisherUserId: publisher.id,
      siteId: site.id,
      now: traffic.anchor,
    });
    const rule = (pattern: string) => inputs?.rules.find((r) => r.pattern === pattern);
    const cookbook = rule("/cookbook/*");
    expect(cookbook?.declined).toBeGreaterThan(8);
    expect(cookbook?.topReasons[0]?.reason).toBe("Thin list, not worth 50¢");
    expect(cookbook?.topReasons.map((r) => r.reason)).toContain("Preview lists spice names only");
    expect(cookbook?.offers).toBeGreaterThanOrEqual(
      (cookbook?.paid ?? 0) + (cookbook?.declined ?? 0),
    );
    expect(cookbook?.offers).toBeGreaterThan(4 * (cookbook?.paid ?? 0));
    const recipes = rule("/recipes/*");
    const dal = recipes?.paths.find((p) => p.path === DEMO_PAGES.dal);
    expect(dal?.cited).toBeGreaterThan(cookbook?.cited ?? 0);
    // Most answers that paid for the dal or the freezing guide cite them.
    expect((dal?.cited ?? 0) * 2).toBeGreaterThan(dal?.paid ?? 0);
    const freezing = rule("/techniques/*")?.paths.find((p) => p.path === DEMO_PAGES.freezing);
    expect(freezing?.cited).toBeGreaterThan(0);
    expect(recipes?.disputed).toBe(4);
    expect(recipes?.paths.find((p) => p.path === FARE_COURT_STUB_PATH)?.disputed).toBe(4);
    expect(rule("/api/nutrition")?.paid).toBeGreaterThan(0);
    expect(rule("/meal-plans/*")?.paid).toBeGreaterThan(0);
    for (const r of inputs?.rules ?? []) expect(r.offers).toBeGreaterThanOrEqual(r.paid);

    // A rerun on a later day moves no money and adds no signals.
    const balance = await walletBalanceMicros(db, owner.id);
    const later = new Date(now.getTime() + 2 * DAY_MS);
    const rerunTraffic = await runTraffic(db, {
      runKey: "story",
      ownerUserId: owner.id,
      site,
      now: later,
    });
    const rerun = await runFareStory(db, {
      runKey: "story",
      ownerUserId: owner.id,
      site,
      anchor: rerunTraffic.anchor,
      trafficNonces: rerunTraffic.plan.map((r) => nonceFor("story", r.index)),
    });
    expect(rerun.stub).toMatchObject({ purchased: 0, alreadyPurchased: 4, attested: 0 });
    expect(rerun.stub.disputes.alreadyFiled).toBe(4);
    expect(rerun.declines.recorded).toBe(0);
    expect(rerun.offers.skipped).toBe(true);
    expect(rerun.citations.cited).toBe(story.citations.cited);
    expect(await walletBalanceMicros(db, owner.id)).toBe(balance);
    const again = await advisorInputs(db, {
      publisherUserId: publisher.id,
      siteId: site.id,
      now: traffic.anchor,
    });
    expect(again?.totals).toEqual(inputs?.totals);
    expect((await checkLedgerInvariants(db)).ok).toBe(true);
  });

  it("a weekly refresh adds a fresh story without counting earlier purchases again", async () => {
    const { owner, publisher, site } = await demoSetup();
    const first = new Date("2026-11-08T15:00:00Z");
    const runs = [
      { runKey: "week-2026-W45", now: first },
      { runKey: "week-2026-W46", now: new Date(first.getTime() + 7 * DAY_MS) },
    ];
    for (const { runKey, now } of runs) {
      const traffic = await runTraffic(db, { runKey, ownerUserId: owner.id, site, now });
      await runFareStory(db, {
        runKey,
        ownerUserId: owner.id,
        site,
        anchor: traffic.anchor,
        trafficNonces: traffic.plan.map((r) => nonceFor(runKey, r.index)),
      });
    }
    // One "offer shown" per purchase, never two, though the runs' windows overlap by a week.
    const purchases = await db.query.receipts.findMany({
      where: (t, { eq }) => eq(t.siteId, site.id),
    });
    const purchaseOffers = await db.query.offerEvents.findMany({
      where: (t, { and, eq }) => and(eq(t.siteId, site.id), eq(t.signal, "agent-header")),
    });
    expect(purchaseOffers.length).toBe(purchases.length);

    // Two weeks after the first run its story has left the 14-day window; the second run's
    // last eight days are what the Advisor shows (the next weekly run tops it up again).
    const inputs = await advisorInputs(db, {
      publisherUserId: publisher.id,
      siteId: site.id,
      now: new Date(first.getTime() + 14 * DAY_MS),
    });
    const cookbook = inputs?.rules.find((r) => r.pattern === "/cookbook/*");
    expect(cookbook?.declined).toBeGreaterThan(4);
    expect(cookbook?.topReasons.map((r) => r.reason)).toContain("Thin list, not worth 50¢");
    for (const r of inputs?.rules ?? []) expect(r.offers).toBeGreaterThanOrEqual(r.paid);
    expect((await checkLedgerInvariants(db)).ok).toBe(true);
  });
});
