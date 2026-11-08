import { DEFAULT_DETECTION } from "@botfare/contracts";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  authenticateSite,
  createAgentKey,
  getSiteConfig,
  getUserByEmail,
  listAgentKeys,
  listReceipts,
  PostgresPrepaidLedger,
  revokeAgentKey,
  rotateSiteSecret,
  updateSitePricing,
  updateSiteProfile,
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
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

describe("users", () => {
  it("finds users by email, case-insensitively", async () => {
    const user = await makeUser(db, "Mixed");
    expect((await getUserByEmail(db, user.email.toUpperCase()))?.id).toBe(user.id);
    expect(await getUserByEmail(db, "nobody@example.test")).toBeNull();
  });
});

describe("sites", () => {
  it("stores only the secret hash and authenticates with the secret", async () => {
    const { site, siteSecret } = await makePublisher(db);
    expect(site.id).toMatch(/^site_/);
    expect(site.secretHash).not.toContain(siteSecret);
    expect(siteSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await authenticateSite(db, site.id, siteSecret))?.id).toBe(site.id);
    expect(await authenticateSite(db, site.id, `${siteSecret}x`)).toBeNull();
    expect(await authenticateSite(db, "site_missing", siteSecret)).toBeNull();

    const rotated = await rotateSiteSecret(db, { siteId: site.id });
    expect(rotated?.siteSecret).not.toBe(siteSecret);
    expect(await authenticateSite(db, site.id, siteSecret)).toBeNull();
    expect((await authenticateSite(db, site.id, rotated?.siteSecret ?? ""))?.id).toBe(site.id);
  });

  it("serves the site config and bumps its version on save", async () => {
    const { site, owner } = await makePublisher(db);
    const config = await getSiteConfig(db, site.id);
    expect(config).toEqual({
      siteId: site.id,
      name: "Brewlab Demo",
      origin: "https://brewlab.example",
      network: "paypal:sandbox",
      pricing: [{ pattern: "/articles/*", method: "GET", priceCents: 3, audience: "agents" }],
      freePaths: [],
      chargeKnownBots: false,
      detection: DEFAULT_DETECTION,
      version: site.version,
    });

    const other = await makeUser(db);
    expect(
      await updateSitePricing(db, { siteId: site.id, ownerUserId: other.id, pricing: [] }),
    ).toBeNull();
    const updated = await updateSitePricing(db, {
      siteId: site.id,
      ownerUserId: owner.id,
      pricing: [{ pattern: "/api/brew-ratio", priceCents: 1, audience: "everyone" }],
      freePaths: ["/articles/free-*"],
      chargeKnownBots: true,
    });
    expect(updated?.version).not.toBe(site.version);
    expect(await getSiteConfig(db, site.id)).toMatchObject({
      pricing: [{ pattern: "/api/brew-ratio", method: "GET", priceCents: 1, audience: "everyone" }],
      freePaths: ["/articles/free-*"],
      chargeKnownBots: true,
      version: updated?.version,
    });
    await expect(
      updateSitePricing(db, { siteId: site.id, pricing: [{ pattern: "nope", priceCents: 0 }] }),
    ).rejects.toThrow();
  });

  it("updates origin and payout email, only for the owner", async () => {
    const { site, owner } = await makePublisher(db);
    const other = await makeUser(db);
    expect(
      await updateSiteProfile(db, { siteId: site.id, ownerUserId: other.id, name: "Stolen" }),
    ).toBeNull();
    const updated = await updateSiteProfile(db, {
      siteId: site.id,
      ownerUserId: owner.id,
      origin: "http://localhost:4000/ignored/path",
      payoutEmail: "payee@example.test",
    });
    expect(updated).toMatchObject({
      name: site.name,
      origin: "http://localhost:4000",
      payoutEmail: "payee@example.test",
    });
    expect(updated?.version).not.toBe(site.version);
    const cleared = await updateSiteProfile(db, { siteId: site.id, payoutEmail: null });
    expect(cleared?.payoutEmail).toBeNull();
    await expect(
      updateSiteProfile(db, { siteId: site.id, payoutEmail: "not-an-email" }),
    ).rejects.toThrow();
  });
});

describe("agent keys", () => {
  it("stores only public keys and revokes", async () => {
    const owner = await makeUser(db);
    const keys = await generateAgentKeyPair();
    await expect(
      createAgentKey(db, { ownerUserId: owner.id, name: "leaky", publicJwk: keys.privateJwk }),
    ).rejects.toThrow(/public key only/);

    const key = await createAgentKey(db, {
      ownerUserId: owner.id,
      name: "agent",
      publicJwk: { ...keys.publicJwk, kid: "ignored" },
      dailyCapCents: 500,
    });
    expect(key.id).toMatch(/^ak_/);
    expect(key.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x: keys.publicJwk.x });
    expect(key).toMatchObject({ status: "active", dailyCapCents: 500, allowedSiteIds: null });
    expect((await listAgentKeys(db, owner.id)).map((k) => k.id)).toEqual([key.id]);

    const other = await makeUser(db);
    expect(await revokeAgentKey(db, { keyId: key.id, ownerUserId: other.id })).toBeNull();
    const revoked = await revokeAgentKey(db, { keyId: key.id, ownerUserId: owner.id });
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
  });
});

describe("listReceipts", () => {
  it("filters by owner, site and key, newest first", async () => {
    const ledger = new PostgresPrepaidLedger(db);
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, { balanceCents: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await ledger.charge(chargeRequest(agent.key.id, publisher.site.id));
      if (result.ok) ids.push(result.transaction);
    }
    const byOwner = await listReceipts(db, { ownerUserId: agent.owner.id });
    expect(byOwner.map((r) => r.id).sort()).toEqual([...ids].sort());
    const times = byOwner.map((r) => r.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(await listReceipts(db, { siteId: publisher.site.id, limit: 2 })).toHaveLength(2);
    expect(await listReceipts(db, { agentKeyId: agent.key.id })).toHaveLength(3);
    expect(await listReceipts(db, { ownerUserId: publisher.owner.id })).toHaveLength(0);
  });
});
