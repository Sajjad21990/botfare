import {
  CREMA_NOTES_DETECTION,
  DEFAULT_DETECTION,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  detectionConfigSchema,
  LEGACY_DEMO_SITE_NAMES,
} from "@botfare/contracts";
import {
  authenticateSite,
  createSite,
  getSite,
  listSites,
  updateSiteDetection,
} from "@botfare/core";
import { afterAll, describe, expect, it } from "vitest";
import { makeUser, openTestDb } from "../../packages/core/test/helpers";
import { DEFAULT_DEMO_ORIGIN, demoSiteOrigin, ensureDemoSite } from "../lib/demo-site";

const { db, close } = openTestDb();
afterAll(() => close());

const DEPLOYED = "https://botfare-demo.onrender.com";

describe("demoSiteOrigin", () => {
  it("uses DEMO_ORIGIN when set, else the local demo", () => {
    expect(demoSiteOrigin({ DEMO_ORIGIN: ` ${DEPLOYED} ` })).toBe(DEPLOYED);
    expect(demoSiteOrigin({ DEMO_ORIGIN: "" })).toBe(DEFAULT_DEMO_ORIGIN);
    expect(demoSiteOrigin({})).toBe(DEFAULT_DEMO_ORIGIN);
  });

  it("falls back to DEMO_PUBLIC_URL's origin (botfare-web on Render), ignoring invalid URLs", () => {
    expect(demoSiteOrigin({ DEMO_PUBLIC_URL: `${DEPLOYED}/articles?x=1` })).toBe(DEPLOYED);
    expect(
      demoSiteOrigin({ DEMO_ORIGIN: "http://demo.test", DEMO_PUBLIC_URL: `${DEPLOYED}/` }),
    ).toBe("http://demo.test");
    expect(demoSiteOrigin({ DEMO_PUBLIC_URL: "not a url" })).toBe(DEFAULT_DEMO_ORIGIN);
    expect(demoSiteOrigin({ DEMO_PUBLIC_URL: " " })).toBe(DEFAULT_DEMO_ORIGIN);
  });
});

describe("ensureDemoSite", () => {
  it("creates the site at the given origin with the demo's prices", async () => {
    const publisher = await makeUser(db, "seed-publisher");
    const site = await ensureDemoSite(db, {
      publisherId: publisher.id,
      origin: DEPLOYED,
      payoutEmail: null,
    });
    expect(site.action).toBe("created");
    const row = await getSite(db, site.siteId);
    expect(row?.origin).toBe(DEPLOYED);
    expect(row?.name).toBe(DEMO_SITE_NAME);
    expect(row?.pricing).toHaveLength(DEMO_SITE_PRICING.length);
    expect(row?.freePaths).toEqual(DEMO_SITE_FREE_PATHS);
    expect(row?.detection).toEqual(detectionConfigSchema.parse(CREMA_NOTES_DETECTION));
    expect(await authenticateSite(db, site.siteId, site.siteSecret)).not.toBeNull();
  });

  it("puts the demo site's bot detection back on a rerun", async () => {
    const publisher = await makeUser(db, "seed-publisher");
    const base = { publisherId: publisher.id, origin: DEFAULT_DEMO_ORIGIN, payoutEmail: null };
    const first = await ensureDemoSite(db, base);
    await updateSiteDetection(db, { siteId: first.siteId, detection: DEFAULT_DETECTION });
    await ensureDemoSite(db, {
      ...base,
      current: { siteId: first.siteId, siteSecret: first.siteSecret },
    });
    expect((await getSite(db, first.siteId))?.detection).toEqual(
      detectionConfigSchema.parse(CREMA_NOTES_DETECTION),
    );
  });

  it("keeps a working secret on a rerun, so a configured demo keeps charging", async () => {
    const publisher = await makeUser(db, "seed-publisher");
    const first = await ensureDemoSite(db, {
      publisherId: publisher.id,
      origin: DEFAULT_DEMO_ORIGIN,
      payoutEmail: null,
    });
    const again = await ensureDemoSite(db, {
      publisherId: publisher.id,
      origin: DEPLOYED,
      payoutEmail: null,
      current: { siteId: first.siteId, siteSecret: first.siteSecret },
    });
    expect(again).toEqual({ siteId: first.siteId, siteSecret: first.siteSecret, action: "kept" });
    expect((await getSite(db, first.siteId))?.origin).toBe(DEPLOYED);
    expect(await authenticateSite(db, first.siteId, first.siteSecret)).not.toBeNull();
  });

  it("issues a new secret when the current one is missing, wrong, or rotation is asked for", async () => {
    const publisher = await makeUser(db, "seed-publisher");
    const base = { publisherId: publisher.id, origin: DEFAULT_DEMO_ORIGIN, payoutEmail: null };
    const first = await ensureDemoSite(db, base);

    const missing = await ensureDemoSite(db, base);
    expect(missing.action).toBe("rotated");
    expect(missing.siteId).toBe(first.siteId);
    expect(await authenticateSite(db, first.siteId, first.siteSecret)).toBeNull();

    const wrong = await ensureDemoSite(db, {
      ...base,
      current: { siteId: missing.siteId, siteSecret: "not-the-secret" },
    });
    expect(wrong.action).toBe("rotated");

    const forced = await ensureDemoSite(db, {
      ...base,
      current: { siteId: wrong.siteId, siteSecret: wrong.siteSecret },
      rotate: true,
    });
    expect(forced.action).toBe("rotated");
    expect(forced.siteSecret).not.toBe(wrong.siteSecret);
    expect(await authenticateSite(db, forced.siteId, wrong.siteSecret)).toBeNull();
    expect(await authenticateSite(db, forced.siteId, forced.siteSecret)).not.toBeNull();
  });
});

describe("ensureDemoSite on a database seeded before the rename", () => {
  const LEGACY_NAME = LEGACY_DEMO_SITE_NAMES[0] as string;
  const OLD_PRICING = [{ pattern: "/articles/*", priceCents: 3 }];

  async function legacySite(name = LEGACY_NAME) {
    const publisher = await makeUser(db, "seed-legacy-publisher");
    const created = await createSite(db, {
      ownerUserId: publisher.id,
      name,
      origin: DEFAULT_DEMO_ORIGIN,
      pricing: OLD_PRICING,
      freePaths: ["/", "/health"],
      detection: CREMA_NOTES_DETECTION,
    });
    return { publisher, site: created.site, siteSecret: created.siteSecret };
  }

  it("renames the legacy site in place with the new prices and free paths, once", async () => {
    const { publisher, site, siteSecret } = await legacySite();
    const input = {
      publisherId: publisher.id,
      origin: DEPLOYED,
      payoutEmail: null,
      current: { siteId: site.id, siteSecret },
    };

    const first = await ensureDemoSite(db, input);
    expect(first).toEqual({
      siteId: site.id,
      siteSecret,
      action: "kept",
      renamedFrom: LEGACY_NAME,
    });
    const row = await getSite(db, site.id);
    expect(row).toMatchObject({
      name: DEMO_SITE_NAME,
      origin: DEPLOYED,
      pricing: DEMO_SITE_PRICING,
      freePaths: DEMO_SITE_FREE_PATHS,
      secretHash: site.secretHash,
    });
    expect(await authenticateSite(db, site.id, siteSecret)).not.toBeNull();
    expect((await listSites(db, publisher.id)).map((s) => s.id)).toEqual([site.id]);

    // A rerun finds the renamed site and changes nothing else.
    const again = await ensureDemoSite(db, input);
    expect(again).toEqual({ siteId: site.id, siteSecret, action: "kept" });
    expect((await listSites(db, publisher.id)).map((s) => s.name)).toEqual([DEMO_SITE_NAME]);
  });

  it("finds the legacy site by name when .env has no site ID, issuing a new secret", async () => {
    const { publisher, site, siteSecret } = await legacySite();
    const result = await ensureDemoSite(db, {
      publisherId: publisher.id,
      origin: DEFAULT_DEMO_ORIGIN,
      payoutEmail: null,
    });
    expect(result).toMatchObject({ siteId: site.id, action: "rotated", renamedFrom: LEGACY_NAME });
    expect(await authenticateSite(db, site.id, siteSecret)).toBeNull();
    expect((await getSite(db, site.id))?.name).toBe(DEMO_SITE_NAME);
  });

  it("finds the site by BOTFARE_SITE_ID under any name, but only among the publisher's own", async () => {
    const { publisher, site, siteSecret } = await legacySite("Coffee blog (old demo)");
    const byId = await ensureDemoSite(db, {
      publisherId: publisher.id,
      origin: DEFAULT_DEMO_ORIGIN,
      payoutEmail: null,
      current: { siteId: site.id, siteSecret },
    });
    expect(byId).toMatchObject({ siteId: site.id, action: "kept" });
    expect((await getSite(db, site.id))?.name).toBe(DEMO_SITE_NAME);

    // Another publisher's site ID is ignored: this publisher gets a site of its own.
    const other = await makeUser(db, "seed-other-publisher");
    const created = await ensureDemoSite(db, {
      publisherId: other.id,
      origin: DEFAULT_DEMO_ORIGIN,
      payoutEmail: null,
      current: { siteId: site.id, siteSecret },
    });
    expect(created.action).toBe("created");
    expect(created.siteId).not.toBe(site.id);
    expect((await getSite(db, site.id))?.ownerUserId).toBe(publisher.id);
  });
});
