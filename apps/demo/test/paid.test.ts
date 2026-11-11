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
import {
  FARE_COURT_STUB_PATH,
  FARE_COURT_STUB_SLUG,
  type RunningDemo,
  startDemo,
} from "../src/app";
import { loadArticles, truncate } from "../src/content";
import { subscribeStubPage } from "../src/pages";
import { freePaths, pricing, SITE_NAME } from "../src/pricing";

interface Preview {
  title: string;
  excerpt: string;
  wordCount: number;
}

describe("demo publisher with BotFare payments on", () => {
  let botfare: Awaited<ReturnType<typeof startFakeBotFare>>;
  let demo: RunningDemo;
  let agent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    botfare = await startFakeBotFare(siteConfig({ name: SITE_NAME, pricing, freePaths }));
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

  it("still serves humans the full recipe free", async () => {
    const res = await fetch(`${demo.url}/recipes/crispy-oven-potatoes`);
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-required")).toBeNull();
    const html = await res.text();
    expect(html).toContain("<h2>Timings and make-ahead</h2>");
    expect(html).toContain("AI agents pay 2¢ to read this page. People read free.");
  });

  it("offers an agent the dal recipe for 2¢ with a free preview", async () => {
    const res = await agent.fetch(`${demo.url}/recipes/weeknight-red-lentil-dal`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    expect(required.accepts[0]).toMatchObject({ amount: "2", payTo: SITE_ID, asset: "USD" });
    const { preview } = (await res.json()) as { preview: Preview };
    expect(preview.title).toBe("Weeknight red lentil dal that freezes well");
    expect(preview.excerpt.length).toBeLessThanOrEqual(280);
    expect(preview.excerpt).toMatch(/^Split red lentils need no soaking/);
    expect(preview.wordCount).toBeGreaterThan(400);
    expect(required.accepts[0]?.extra?.botfareOffer).toMatchObject({
      title: preview.title,
      preview: preview.excerpt,
    });
  });

  it("prices techniques at 5¢, the meal plan at 8¢ and the cookbook chapter at 50¢", async () => {
    for (const [path, amount] of [
      ["/techniques/freezing-and-reheating", "5"],
      ["/meal-plans/five-weeknight-dinners", "8"],
      ["/cookbook/spice-pantry-chapter", "50"],
    ]) {
      const res = await agent.fetch(`${demo.url}${path}`);
      expect(res.status, path).toBe(402);
      const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
      expect(required.accepts[0]?.amount, path).toBe(amount);
    }
  });

  it("lets an agent pay 2¢ and read a recipe, and keeps free paths free", async () => {
    const before = agent.wallet();
    const res = await agent.payingFetch(`${demo.url}/recipes/one-pan-lemon-chicken-rice`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h2>Variations</h2>");
    const receipt = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "");
    expect(receipt.success).toBe(true);
    expect(before - agent.wallet()).toBe(20_000); // 2¢ in micro-dollars

    for (const path of ["/", "/recipes", "/techniques", "/meal-plans", "/cookbook"]) {
      const free = await agent.fetch(`${demo.url}${path}`);
      expect(free.status, path).toBe(200);
      expect(free.headers.get("payment-required"), path).toBeNull();
    }
    expect((await agent.fetch(`${demo.url}/catalog.json`)).status).toBe(200);
    expect((await agent.fetch(`${demo.url}/health`)).status).toBe(200);
  });

  describe("Fare Court demo case: a paid agent gets a stub", () => {
    const url = () => `${demo.url}${FARE_COURT_STUB_PATH}`;
    const stubArticle = () => loadArticles().find((a) => a.slug === FARE_COURT_STUB_SLUG);

    it("is the sourdough starter recipe", () => {
      expect(FARE_COURT_STUB_SLUG).toBe("sourdough-starter");
      expect(FARE_COURT_STUB_PATH).toBe("/recipes/sourdough-starter");
      expect(stubArticle()?.path).toBe(FARE_COURT_STUB_PATH);
    });

    it("serves humans the full guide free", async () => {
      const res = await fetch(url());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<h2>Day by day</h2>");
      expect(html).toContain("Days 3 and 4.");
      expect(html).not.toContain("Subscribe to keep reading");
    });

    it("offers agents a real, useful preview of the full guide for 2¢", async () => {
      const res = await agent.fetch(url());
      expect(res.status).toBe(402);
      const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
      expect(required.accepts[0]?.amount).toBe("2");
      const { preview } = (await res.json()) as { preview: Preview };
      expect(preview.title).toBe("Sourdough starter from scratch");
      expect(preview.excerpt).toMatch(/^A sourdough starter is flour and water/);
      expect(preview.excerpt).toBe(truncate(stubArticle()?.lead ?? "", 280));
      expect(preview.wordCount).toBeGreaterThan(400);
      expect(required.accepts[0]?.extra?.botfareOffer).toMatchObject({
        title: "Sourdough starter from scratch",
        preview: preview.excerpt,
      });
    });

    it("charges 2¢ and serves a subscribe stub, whose digest botfare() attests", async () => {
      const before = agent.wallet();
      const res = await agent.payingFetch(url());
      expect(res.status).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      const html = new TextDecoder().decode(body);
      expect(html).toContain("Subscribe to keep reading");
      expect(html).not.toContain("Days 3 and 4.");
      expect(before - agent.wallet()).toBe(20_000);
      // The stub is deterministic, so scripts can recompute its digest without the server.
      const article = stubArticle();
      if (!article) throw new Error("no stub article");
      expect(html).toBe(subscribeStubPage(article));

      const receiptId = decodePaymentResponseHeader(
        res.headers.get("payment-response") ?? "",
      ).transaction;
      // The declared offer reached the facilitator's settle call.
      expect(botfare.settled.at(-1)?.extra?.botfareOffer).toMatchObject({
        title: "Sourdough starter from scratch",
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

    it("lists the guide in the catalog at 2¢", async () => {
      const catalog = (await (await fetch(`${demo.url}/catalog.json`)).json()) as {
        articles: { slug: string; section: string; priceCents: number }[];
      };
      expect(catalog.articles).toContainEqual(
        expect.objectContaining({ slug: FARE_COURT_STUB_SLUG, section: "recipes", priceCents: 2 }),
      );
    });
  });

  it("charges everyone 1¢ for the nutrition API", async () => {
    const human = await fetch(`${demo.url}/api/nutrition?recipe=crispy-oven-potatoes`);
    expect(human.status).toBe(402);
    expect(await human.json()).toEqual({
      preview: expect.objectContaining({ title: "Nutrition API" }),
    });
    const before = agent.wallet();
    const paid = await agent.payingFetch(`${demo.url}/api/nutrition?recipe=crispy-oven-potatoes`);
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({
      recipe: "crispy-oven-potatoes",
      servings: 4,
      perServing: { kcal: 310, proteinG: 6, carbsG: 51, fatG: 9 },
    });
    expect(before - agent.wallet()).toBe(10_000);
  });
});
