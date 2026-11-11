import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREMA_NOTES_DETECTION,
  DEFAULT_DETECTION,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
} from "@botfare/contracts";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createSite,
  getReceipt,
  getSite,
  getSiteConfig,
  migrationsFolder,
  PostgresPrepaidLedger,
  receiptsForPublisher,
  refundReceipt,
  resetDemoPublisher,
  revenueBySignal,
  updateSiteDetection,
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

describe("sites.detection migration", () => {
  it("gives new sites DEFAULT_DETECTION and serves it in the site config", async () => {
    const { site } = await makePublisher(db);
    expect(site.detection).toEqual(DEFAULT_DETECTION);
    expect((await getSiteConfig(db, site.id))?.detection).toEqual(DEFAULT_DETECTION);

    // The column default applies to rows written without the field (older code paths).
    const owner = await makeUser(db);
    const id = `site_raw${Date.now().toString(36)}`;
    await db.execute(sql`
      insert into sites (id, owner_user_id, name, origin, secret_hash, version)
      values (${id}, ${owner.id}, 'Raw', 'https://raw.example', 'x', 'v1')`);
    expect((await getSite(db, id))?.detection).toEqual(DEFAULT_DETECTION);
  });

  it("backfills existing sites from charge_known_bots: on is known-bots, off is off", async () => {
    const owner = await makeUser(db);
    const stamp = Date.now().toString(36);
    const on = `site_on${stamp}`;
    const off = `site_off${stamp}`;
    await db.execute(sql`
      insert into sites (id, owner_user_id, name, origin, secret_hash, version, charge_known_bots)
      values (${on}, ${owner.id}, 'On', 'https://on.example', 'x', 'v1', true),
             (${off}, ${owner.id}, 'Off', 'https://off.example', 'x', 'v1', false)`);

    // Re-run the migration's backfill statement, limited to these two rows.
    const migration = readFileSync(join(migrationsFolder(), "0003_detection.sql"), "utf8");
    const backfill = migration
      .split("--> statement-breakpoint")
      .map((part) =>
        part
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .find((part) => part.startsWith("UPDATE"));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(`${backfill?.replace(/;$/, "")} AND "id" IN ('${on}', '${off}')`));

    expect((await getSite(db, on))?.detection).toEqual({
      ...DEFAULT_DETECTION,
      level: "known-bots",
    });
    expect((await getSite(db, off))?.detection).toEqual({ ...DEFAULT_DETECTION, level: "off" });
  });
});

describe("updateSiteDetection", () => {
  it("saves validated settings for the owner only and bumps the config version", async () => {
    const { site, owner } = await makePublisher(db);
    const other = await makeUser(db);
    expect(
      await updateSiteDetection(db, {
        siteId: site.id,
        ownerUserId: other.id,
        detection: { level: "off" },
      }),
    ).toBeNull();
    expect((await getSite(db, site.id))?.version).toBe(site.version);

    const updated = await updateSiteDetection(db, {
      siteId: site.id,
      ownerUserId: owner.id,
      detection: {
        level: "strict",
        threshold: 35,
        edge: { cloudflare: { enabled: true, maxBotScore: 20 } },
        turnstileSiteKey: "0x4AAAAAAAfictional",
      },
    });
    expect(updated?.version).not.toBe(site.version);
    const config = await getSiteConfig(db, site.id);
    expect(config?.version).toBe(updated?.version);
    expect(config?.detection).toEqual({
      level: "strict",
      threshold: 35,
      edge: {
        cloudflare: {
          enabled: true,
          scoreHeader: "cf-bot-score",
          verifiedBotHeader: "cf-verified-bot",
          maxBotScore: 20,
        },
        akamai: { enabled: false, header: "akamai-bot" },
      },
      turnstileSiteKey: "0x4AAAAAAAfictional",
    });

    await expect(
      updateSiteDetection(db, {
        siteId: site.id,
        detection: { level: "paranoid" as "strict" },
      }),
    ).rejects.toThrow();
    await expect(
      updateSiteDetection(db, { siteId: site.id, detection: { threshold: 0 } }),
    ).rejects.toThrow();
  });

  it("lets createSite take detection settings", async () => {
    const owner = await makeUser(db);
    const { site } = await createSite(db, {
      ownerUserId: owner.id,
      name: "Strict Site",
      origin: "https://strict.example",
      pricing: [],
      detection: { level: "strict" },
    });
    expect(site.detection).toEqual({ ...DEFAULT_DETECTION, level: "strict" });
  });
});

describe("detection signal on receipts", () => {
  it("stores a known signal from the requirements' extra, and null for unknown or missing", async () => {
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });

    const known = await ledger.charge({
      ...chargeRequest(agent.key.id, publisher.site.id),
      extra: { botfareSignal: "edge-score", other: 1 },
    });
    const unknown = await ledger.charge({
      ...chargeRequest(agent.key.id, publisher.site.id),
      extra: { botfareSignal: "mind-reading" },
    });
    const wrongType = await ledger.charge({
      ...chargeRequest(agent.key.id, publisher.site.id),
      extra: { botfareSignal: 7 },
    });
    const missing = await ledger.charge(chargeRequest(agent.key.id, publisher.site.id));
    if (!known.ok || !unknown.ok || !wrongType.ok || !missing.ok) {
      throw new Error("charges should succeed");
    }

    expect((await getReceipt(db, known.transaction))?.detectionSignal).toBe("edge-score");
    expect((await getReceipt(db, unknown.transaction))?.detectionSignal).toBeNull();
    expect((await getReceipt(db, wrongType.transaction))?.detectionSignal).toBeNull();
    expect((await getReceipt(db, missing.transaction))?.detectionSignal).toBeNull();

    const rows = await receiptsForPublisher(db, publisher.owner.id);
    expect(rows.find((row) => row.id === known.transaction)?.detectionSignal).toBe("edge-score");
    expect(rows.find((row) => row.id === missing.transaction)?.detectionSignal).toBeNull();
  });

  it("sums settled revenue per signal for the publisher", async () => {
    const publisher = await makePublisher(db);
    const otherPublisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 500 });
    const pay = async (payTo: string, signal: string | undefined, amountCents = 3) => {
      const result = await ledger.charge({
        ...chargeRequest(agent.key.id, payTo, { amountCents }),
        ...(signal ? { extra: { botfareSignal: signal } } : {}),
      });
      if (!result.ok) throw new Error(result.message);
      return result.transaction;
    };
    await pay(publisher.site.id, "agent-header");
    await pay(publisher.site.id, "agent-header");
    await pay(publisher.site.id, "automation", 10);
    await pay(publisher.site.id, undefined);
    const refunded = await pay(publisher.site.id, "known-bot");
    await pay(otherPublisher.site.id, "agent-header");
    const refund = await refundReceipt(db, { receiptId: refunded, siteId: publisher.site.id });
    expect(refund.ok).toBe(true);

    expect(await revenueBySignal(db, publisher.owner.id)).toEqual([
      { signal: "automation", paidRequests: 1, earningsMicros: 95_000 },
      { signal: "agent-header", paidRequests: 2, earningsMicros: 57_000 },
      { signal: null, paidRequests: 1, earningsMicros: 28_500 },
    ]);
    expect(
      await revenueBySignal(db, publisher.owner.id, { since: new Date(Date.now() + 60_000) }),
    ).toEqual([]);
  });
});

describe("resetDemoPublisher", () => {
  it("restores the demo site's detection to the seeded value, once", async () => {
    const publisher = await makeUser(db, "demo-publisher");
    const { site } = await createSite(db, {
      ownerUserId: publisher.id,
      name: DEMO_SITE_NAME,
      origin: "https://saffron-and-salt.example",
      pricing: DEMO_SITE_PRICING,
      freePaths: DEMO_SITE_FREE_PATHS,
      detection: CREMA_NOTES_DETECTION,
    });
    expect(CREMA_NOTES_DETECTION).toMatchObject({
      level: "standard",
      turnstileSiteKey: "1x00000000000000000000AA",
    });

    // Seeded as is: nothing to restore, the version stays.
    const first = await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null });
    expect(first).toMatchObject({ pricingReset: 0, detectionReset: 0 });
    expect((await getSite(db, site.id))?.version).toBe(site.version);

    // A judge turns detection off and drops the human check.
    await updateSiteDetection(db, {
      siteId: site.id,
      ownerUserId: publisher.id,
      detection: { level: "off", turnstileSiteKey: null },
    });
    const second = await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null });
    expect(second).toMatchObject({ pricingReset: 0, detectionReset: 1 });
    const restored = await getSite(db, site.id);
    expect(restored?.detection).toEqual(CREMA_NOTES_DETECTION);
    expect((await getSiteConfig(db, site.id))?.detection).toEqual(CREMA_NOTES_DETECTION);

    const third = await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null });
    expect(third.detectionReset).toBe(0);
    expect((await getSite(db, site.id))?.version).toBe(restored?.version);
  });
});
