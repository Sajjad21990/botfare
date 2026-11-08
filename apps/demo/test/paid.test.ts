/**
 * The demo behind a real botfare() against the in-process fake BotFare from packages/express:
 * the site config is exactly pricing.ts, the agent pays through the official @x402/fetch.
 */
import { contentDigestSha256 } from "@botfare/contracts/fare";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAgent,
  SITE_ID,
  SITE_SECRET,
  siteConfig,
  startFakeBotFare,
} from "../../../packages/express/test/helpers";
import { FARE_COURT_STUB_SLUG, type RunningDemo, startDemo } from "../src/app";
import { freePaths, pricing } from "../src/pricing";

describe("demo publisher with BotFare payments on", () => {
  let botfare: Awaited<ReturnType<typeof startFakeBotFare>>;
  let demo: RunningDemo;
  let agent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    botfare = await startFakeBotFare(siteConfig({ name: "Crema Notes", pricing, freePaths }));
    demo = await startDemo({
      siteId: SITE_ID,
      siteSecret: SITE_SECRET,
      botfareUrl: botfare.url,
      logger: () => {},
    });
    agent = await createAgent(botfare.ledger, 100);
  });
  afterAll(async () => {
    await demo.close();
    await botfare.close();
  });

  it("still serves humans the full article free", async () => {
    const res = await fetch(`${demo.url}/articles/burr-basics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.text()).toContain("<h2>Conical and flat burrs</h2>");
  });

  it("offers an agent the article for 3¢ with a free preview", async () => {
    const res = await agent.fetch(`${demo.url}/articles/latte-art-hearts`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    expect(required.accepts[0]).toMatchObject({ amount: "3", payTo: SITE_ID, asset: "USD" });
    const { preview } = (await res.json()) as {
      preview: { title: string; excerpt: string; wordCount: number };
    };
    expect(preview.title).toBe("Pouring your first latte-art heart");
    expect(preview.excerpt.length).toBeLessThanOrEqual(280);
    expect(preview.excerpt).toMatch(/^The heart is the first pattern/);
    expect(preview.wordCount).toBeGreaterThan(500);
  });

  it("prices the premium roundup at 50¢ and dialing-in at 5¢", async () => {
    for (const [slug, amount] of [
      ["premium-grinder-roundup", "50"],
      ["dialing-in-espresso", "5"],
    ]) {
      const res = await agent.fetch(`${demo.url}/articles/${slug}`);
      expect(res.status).toBe(402);
      const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
      expect(required.accepts[0]?.amount).toBe(amount);
    }
  });

  it("lets an agent pay and read, and keeps free paths free", async () => {
    const before = agent.wallet();
    const res = await agent.payingFetch(`${demo.url}/articles/grinders-under-200`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Okto Flatline 54");
    const receipt = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "");
    expect(receipt.success).toBe(true);
    expect(before - agent.wallet()).toBe(30_000); // 3¢ in micro-dollars

    expect((await agent.fetch(`${demo.url}/catalog.json`)).status).toBe(200);
    expect((await agent.fetch(`${demo.url}/health`)).status).toBe(200);
  });

  describe("Fare Court demo case: a paid agent gets a stub", () => {
    const url = () => `${demo.url}/articles/${FARE_COURT_STUB_SLUG}`;

    it("serves humans the full article free", async () => {
      const res = await fetch(url());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Step 3: clear the chute");
      expect(html).not.toContain("Subscribe to keep reading");
    });

    it("offers agents a real, useful preview of the full article for 3¢", async () => {
      const res = await agent.fetch(url());
      expect(res.status).toBe(402);
      const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
      expect(required.accepts[0]?.amount).toBe("3");
      const { preview } = (await res.json()) as {
        preview: { title: string; excerpt: string; wordCount: number };
      };
      expect(preview.title).toBe("Grinder maintenance, step by step");
      expect(preview.excerpt).toMatch(/^A burr grinder slowly fills with old coffee/);
      expect(preview.wordCount).toBeGreaterThan(500);
      expect(required.accepts[0]?.extra?.botfareOffer).toMatchObject({
        title: "Grinder maintenance, step by step",
        preview: preview.excerpt,
      });
    });

    it("charges 3¢ and serves a subscribe stub, whose digest botfare() attests", async () => {
      const before = agent.wallet();
      const res = await agent.payingFetch(url());
      expect(res.status).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      const html = new TextDecoder().decode(body);
      expect(html).toContain("Subscribe to keep reading");
      expect(html).not.toContain("Step 3: clear the chute");
      expect(before - agent.wallet()).toBe(30_000);

      const receiptId = decodePaymentResponseHeader(
        res.headers.get("payment-response") ?? "",
      ).transaction;
      // The declared offer reached the facilitator's settle call.
      expect(botfare.settled.at(-1)?.extra?.botfareOffer).toMatchObject({
        title: "Grinder maintenance, step by step",
      });
      let attestation: (typeof botfare.attestations)[number] | undefined;
      for (let i = 0; i < 100 && !attestation; i++) {
        attestation = botfare.attestations.find((a) => a.receiptId === receiptId);
        if (!attestation) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(attestation?.body).toMatchObject({
        contentDigest: await contentDigestSha256(body),
        contentLength: body.length,
        status: 200,
      });
    });

    it("lists the article in the catalog at 3¢", async () => {
      const catalog = (await (await fetch(`${demo.url}/catalog.json`)).json()) as {
        articles: { slug: string; priceCents: number }[];
      };
      expect(catalog.articles).toContainEqual(
        expect.objectContaining({ slug: FARE_COURT_STUB_SLUG, priceCents: 3 }),
      );
    });
  });

  it("charges everyone 1¢ for the brew-ratio API", async () => {
    const human = await fetch(`${demo.url}/api/brew-ratio?method=espresso&coffeeGrams=18`);
    expect(human.status).toBe(402);
    expect(await human.json()).toEqual({
      preview: expect.objectContaining({ title: "Brew ratio API" }),
    });
    const paid = await agent.payingFetch(
      `${demo.url}/api/brew-ratio?method=espresso&coffeeGrams=18`,
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ waterGrams: 36, ratio: "1:2" });
  });
});
