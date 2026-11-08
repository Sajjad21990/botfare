import { authenticateSite, getSite } from "@botfare/core";
import { afterAll, describe, expect, it } from "vitest";
import { freePaths, pricing } from "../../apps/demo/src/pricing";
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
    expect(row?.pricing).toHaveLength(pricing.length);
    expect(row?.freePaths).toEqual(freePaths);
    expect(await authenticateSite(db, site.siteId, site.siteSecret)).not.toBeNull();
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
