/**
 * /verify's example receipt: the latest clean, attested purchase on the demo site (Saffron & Salt,
 * owned by the publisher persona). Each test uses its own publisher email, so receipts other test
 * files leave in botfare_test never match. `ledger.charge` takes any resource URL, so paths that
 * the real demo would never settle (a bare /api/nutrition) still work as fixtures.
 */
import { readdir, readFile } from "node:fs/promises";
import { DEMO_SITE_NAME } from "@botfare/contracts";
import { contentDigestSha256 } from "@botfare/contracts/fare";
import {
  attestReceipt,
  createSite,
  createUser,
  openDispute,
  PostgresPrepaidLedger,
  type ReceiptKeyring,
  receiptJwks,
  receiptKeyringFromEnv,
  refundReceipt,
  setReceiptKeyring,
} from "@botfare/core";
import { PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, getDbHandle } from "../src/lib/server/db";
import {
  EXAMPLE_CACHE_MS,
  exampleReceiptId,
  FARE_COURT_STUB_PATH,
  findExampleReceiptId,
  resetExampleReceiptCache,
} from "../src/lib/server/verify-example";
import { makeAgent, useTestDatabase } from "./helpers";

// Server modules run outside Next: no "server-only" guard.
vi.mock("server-only", () => ({}));

const ORIGIN = "https://saffron-and-salt.example";
const ARTICLE = "<h1>Red lentil dal</h1><p>Rinse the lentils, then simmer for 20 minutes.</p>";

let keyring: ReceiptKeyring;
let kids: string[];
let counter = 0;

beforeAll(async () => {
  useTestDatabase();
  keyring = await receiptKeyringFromEnv({
    BOTFARE_RECEIPT_KEY_SEED: "verify-example-receipt-seed-0123456789-abcdef",
    BOTFARE_URL: "https://botfare.example",
    NODE_ENV: "test",
  });
  // attestReceipt and refundReceipt sign with the process keyring.
  setReceiptKeyring(keyring);
  kids = receiptJwks(keyring).keys.map((jwk) => jwk.kid as string);
});
beforeEach(() => resetExampleReceiptCache());
afterAll(async () => {
  setReceiptKeyring(undefined);
  resetExampleReceiptCache();
  await closeDb();
});

function uniqueEmail(): string {
  counter += 1;
  return `verify-example-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/** A publisher with a site named like the demo site, an agent that pays it, and a fixed clock. */
async function demoWorld(name = DEMO_SITE_NAME) {
  const db = getDb();
  const email = uniqueEmail();
  const publisher = await createUser(db, { email, name: "Verify example publisher" });
  const { site } = await createSite(db, {
    ownerUserId: publisher.id,
    name,
    origin: ORIGIN,
    pricing: [{ pattern: "/recipes/*", priceCents: 2 }],
  });
  const agent = await makeAgent(db, 200);
  // Receipts a second apart, so "latest" never depends on timing.
  let clock = Date.now() - 10 * 60_000;
  const ledger = new PostgresPrepaidLedger(db, { keyring, now: () => new Date(clock) });

  async function buy(
    path: string,
    options: { attest?: boolean; siteId?: string } = {},
  ): Promise<string> {
    const siteId = options.siteId ?? site.id;
    clock += 1_000;
    const charged = await ledger.charge({
      keyId: agent.key.id,
      payTo: siteId,
      nonce: crypto.randomUUID(),
      amountCents: 2,
      network: PAYPAL_SANDBOX,
      resourceUrl: `${ORIGIN}${path}`,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    if (!charged.ok) throw new Error(`charge failed: ${charged.message}`);
    if (options.attest ?? true) {
      const attested = await attestReceipt(db, {
        siteId,
        receiptId: charged.transaction,
        attestation: {
          contentDigest: await contentDigestSha256(ARTICLE),
          contentLength: ARTICLE.length,
          contentType: "text/html; charset=utf-8",
          status: 200,
        },
      });
      if (!attested.ok) throw new Error(`attest failed: ${attested.message}`);
    }
    return charged.transaction;
  }

  return { db, email, publisher, site, agent, buy };
}

describe("findExampleReceiptId", () => {
  it("is null without a demo site, without receipts, or without published keys", async () => {
    const { sql } = getDbHandle();
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: uniqueEmail() })).toBeNull();

    const world = await demoWorld();
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBeNull();

    await world.buy("/recipes/weeknight-red-lentil-dal");
    expect(await findExampleReceiptId(sql, { kids: [], publisherEmail: world.email })).toBeNull();
  });

  it("picks the latest attested, unrefunded, undisputed purchase that is not the stub", async () => {
    const { sql } = getDbHandle();
    const world = await demoWorld();

    const older = await world.buy("/recipes/weeknight-red-lentil-dal");
    const latestClean = await world.buy("/recipes/crispy-oven-potatoes");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(
      latestClean,
    );

    // Newer, but refunded: skipped.
    const refunded = await world.buy("/techniques/tempering-spices");
    const refund = await refundReceipt(world.db, { receiptId: refunded, siteId: world.site.id });
    expect(refund.ok).toBe(true);
    // Newer, but never attested (no delivery statement): skipped.
    await world.buy("/recipes/one-pan-lemon-chicken-rice", { attest: false });
    // Newer, but the Fare Court stub recipe: skipped.
    await world.buy(FARE_COURT_STUB_PATH);
    // Newer, but disputed (still open): skipped.
    const disputed = await world.buy("/meal-plans/five-weeknight-dinners");
    const dispute = await openDispute(world.db, {
      agentKeyId: world.agent.key.id,
      request: {
        receiptId: disputed,
        reason: "not_as_described",
        contentBase64: Buffer.from(ARTICLE).toString("base64"),
      },
    });
    expect(dispute.ok).toBe(true);

    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(
      latestClean,
    );
    expect(latestClean).not.toBe(older);

    // A newer clean purchase takes over.
    const newest = await world.buy("/techniques/freezing-and-reheating");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(newest);
  });

  it("prefers a page to the nutrition API", async () => {
    const { sql } = getDbHandle();
    const world = await demoWorld();
    const recipe = await world.buy("/recipes/weeknight-red-lentil-dal");
    await world.buy("/api/nutrition");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(recipe);

    const technique = await world.buy("/techniques/tempering-spices");
    await world.buy("/api/nutrition");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(technique);
  });

  it("falls back to the nutrition API when it is the only clean purchase", async () => {
    const { sql } = getDbHandle();
    const world = await demoWorld();
    const api = await world.buy("/api/nutrition");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(api);
  });

  it("skips URLs with a query string or fragment, which the buyer chooses", async () => {
    const { sql } = getDbHandle();
    const world = await demoWorld();
    await world.buy("/recipes/weeknight-red-lentil-dal?note=hello");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBeNull();

    const plain = await world.buy("/recipes/weeknight-red-lentil-dal");
    await world.buy("/recipes/crispy-oven-potatoes?utm_source=anyone");
    await world.buy("/techniques/tempering-spices#notes");
    await world.buy("/api/nutrition?recipe=weeknight-red-lentil-dal");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(plain);
  });

  it("only counts statements signed by a published key", async () => {
    const { sql } = getDbHandle();
    const world = await demoWorld();
    await world.buy("/recipes/weeknight-red-lentil-dal");
    const other = await receiptKeyringFromEnv({
      BOTFARE_RECEIPT_KEY_SEED: "some-other-receipt-seed-0123456789-abcdefgh",
      BOTFARE_URL: "https://botfare.example",
      NODE_ENV: "test",
    });
    const otherKids = receiptJwks(other).keys.map((jwk) => jwk.kid as string);
    expect(
      await findExampleReceiptId(sql, { kids: otherKids, publisherEmail: world.email }),
    ).toBeNull();
  });

  it("only reads the seeded demo site: the publisher's oldest site with the demo name", async () => {
    const { sql } = getDbHandle();
    const world = await demoWorld();
    const seeded = await world.buy("/recipes/weeknight-red-lentil-dal");
    // A newer site with the same name (a judge added one through the persona): ignored.
    const { site: copy } = await createSite(world.db, {
      ownerUserId: world.publisher.id,
      name: DEMO_SITE_NAME,
      origin: "https://copy.example",
      pricing: [{ pattern: "/recipes/*", priceCents: 2 }],
    });
    await world.buy("/recipes/crispy-oven-potatoes", { siteId: copy.id });
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: world.email })).toBe(seeded);

    // A site with another name is not the demo site.
    const renamed = await demoWorld("Saffron & Salt (copy)");
    await renamed.buy("/recipes/weeknight-red-lentil-dal");
    expect(await findExampleReceiptId(sql, { kids, publisherEmail: renamed.email })).toBeNull();
  });

  it("names the same stub recipe as apps/demo", async () => {
    expect(FARE_COURT_STUB_PATH).toBe("/recipes/sourdough-starter");
    const dir = new URL("../../demo/src/", import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
    const sources = await Promise.all(files.map((name) => readFile(new URL(name, dir), "utf8")));
    const slug = FARE_COURT_STUB_PATH.split("/").pop();
    expect(sources.some((source) => source.includes(`FARE_COURT_STUB_SLUG = "${slug}"`))).toBe(
      true,
    );
  });
});

describe("exampleReceiptId", () => {
  it("caches the lookup for a minute", async () => {
    const world = await demoWorld();
    const first = await world.buy("/recipes/weeknight-red-lentil-dal");
    let now = Date.now();
    const lookup = () => exampleReceiptId({ publisherEmail: world.email, now: () => now });

    expect(await lookup()).toBe(first);
    const second = await world.buy("/recipes/crispy-oven-potatoes");
    now += EXAMPLE_CACHE_MS - 1;
    expect(await lookup()).toBe(first);
    now += 2;
    expect(await lookup()).toBe(second);
  });
});
