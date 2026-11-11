import {
  CREMA_NOTES_DETECTION,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  LEGACY_DEMO_SITE_NAMES,
} from "@botfare/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  createSite,
  createUser,
  findDemoSites,
  getSite,
  getUserByEmail,
  getUserById,
  listSites,
  migrateLegacyDemoPublisher,
  resetDemoPublisher,
} from "../src";
import { makeUser, openTestDb } from "./helpers";

const { db, close } = openTestDb();
afterAll(close);

const LEGACY_NAME = LEGACY_DEMO_SITE_NAMES[0] as string;

/** Persona emails of their own, so this file never touches the real persona users. */
function emails() {
  const tag = crypto.randomUUID().slice(0, 8);
  return {
    email: `publisher-${tag}@saffron.example.test`,
    name: "Saffron & Salt publisher",
    legacyEmails: [`publisher-${tag}@crema.example.test`],
  };
}

describe("migrateLegacyDemoPublisher", () => {
  it("moves the legacy publisher to the new email in place, keeping its ID and sites", async () => {
    const persona = emails();
    const legacyEmail = persona.legacyEmails[0] as string;
    const legacy = await createUser(db, { email: legacyEmail, name: "Crema Notes publisher" });
    const { site } = await createSite(db, {
      ownerUserId: legacy.id,
      name: LEGACY_NAME,
      origin: "https://crema-legacy.example",
      pricing: [{ pattern: "/articles/*", priceCents: 3 }],
    });

    const first = await migrateLegacyDemoPublisher(db, persona);
    expect(first.migrated).toEqual({ userId: legacy.id, from: legacyEmail });
    expect(first.untouched).toEqual([]);
    expect(first.publisher).toMatchObject({
      id: legacy.id,
      email: persona.email,
      name: persona.name,
    });
    expect(await getUserByEmail(db, legacyEmail)).toBeNull();
    expect((await getUserByEmail(db, persona.email))?.id).toBe(legacy.id);
    expect((await listSites(db, legacy.id)).map((s) => s.id)).toEqual([site.id]);

    // Idempotent: nothing is left to move.
    const second = await migrateLegacyDemoPublisher(db, persona);
    expect(second).toMatchObject({ migrated: null, untouched: [] });
    expect(second.publisher?.id).toBe(legacy.id);
  });

  it("keeps the new publisher and leaves the legacy one untouched when both exist", async () => {
    const persona = emails();
    const legacyEmail = persona.legacyEmails[0] as string;
    const legacy = await createUser(db, { email: legacyEmail, name: "Crema Notes publisher" });
    const current = await createUser(db, { email: persona.email, name: persona.name });

    const result = await migrateLegacyDemoPublisher(db, persona);
    expect(result.migrated).toBeNull();
    expect(result.publisher?.id).toBe(current.id);
    expect(result.untouched).toEqual([{ userId: legacy.id, email: legacyEmail }]);
    expect(await getUserById(db, legacy.id)).toMatchObject({
      email: legacyEmail,
      name: "Crema Notes publisher",
    });
  });

  it("does nothing when there is no legacy publisher", async () => {
    const persona = emails();
    expect(await migrateLegacyDemoPublisher(db, persona)).toEqual({
      publisher: null,
      migrated: null,
      untouched: [],
    });
  });
});

describe("findDemoSites", () => {
  it("prefers sites named DEMO_SITE_NAME and falls back to legacy names", () => {
    const current = { id: "a", name: DEMO_SITE_NAME };
    const legacy = { id: "b", name: LEGACY_NAME };
    const other = { id: "c", name: "My cooking blog" };
    expect(findDemoSites([legacy, current, other])).toEqual([current]);
    expect(findDemoSites([other, legacy])).toEqual([legacy]);
    expect(findDemoSites([other])).toEqual([]);
  });
});

describe("resetDemoPublisher after the rename", () => {
  it("renames a legacy demo site in place and gives it the demo's prices, once", async () => {
    const publisher = await makeUser(db, "legacy-publisher");
    const { site } = await createSite(db, {
      ownerUserId: publisher.id,
      name: LEGACY_NAME,
      origin: "https://crema-notes-legacy.example",
      pricing: [{ pattern: "/articles/*", priceCents: 3 }],
      freePaths: ["/", "/health"],
      detection: CREMA_NOTES_DETECTION,
    });

    const first = await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null });
    expect(first).toMatchObject({ renamed: 1, pricingReset: 1, detectionReset: 0 });
    const renamed = await getSite(db, site.id);
    expect(renamed).toMatchObject({
      id: site.id,
      name: DEMO_SITE_NAME,
      secretHash: site.secretHash,
      pricing: DEMO_SITE_PRICING,
      freePaths: DEMO_SITE_FREE_PATHS,
    });

    const second = await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null });
    expect(second).toMatchObject({ renamed: 0, pricingReset: 0, detectionReset: 0 });
    expect((await getSite(db, site.id))?.version).toBe(renamed?.version);
  });

  it("leaves a legacy-named site alone when the publisher already has the demo site", async () => {
    const publisher = await makeUser(db, "two-sites-publisher");
    const { site: legacy } = await createSite(db, {
      ownerUserId: publisher.id,
      name: LEGACY_NAME,
      origin: "https://crema-notes-old.example",
      pricing: [{ pattern: "/articles/*", priceCents: 3 }],
    });
    await createSite(db, {
      ownerUserId: publisher.id,
      name: DEMO_SITE_NAME,
      origin: "https://saffron-and-salt-new.example",
      pricing: DEMO_SITE_PRICING,
      freePaths: DEMO_SITE_FREE_PATHS,
      detection: CREMA_NOTES_DETECTION,
    });

    const reset = await resetDemoPublisher(db, { userId: publisher.id, payoutEmail: null });
    expect(reset).toMatchObject({ renamed: 0, pricingReset: 0 });
    expect(await getSite(db, legacy.id)).toMatchObject({
      name: LEGACY_NAME,
      version: legacy.version,
    });
  });
});
