/**
 * The demo behind a real botfare() against the in-process fake BotFare from packages/express:
 * the site config is exactly pricing.ts, the agent pays through the official @x402/fetch.
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAgent,
  SITE_ID,
  SITE_SECRET,
  siteConfig,
  startFakeBotFare,
} from "../../../packages/express/test/helpers";
import { type RunningDemo, startDemo } from "../src/app";
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
