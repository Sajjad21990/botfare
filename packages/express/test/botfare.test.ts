import { AGENT_HEADER } from "@botfare/contracts";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAgent,
  type Listening,
  listen,
  SITE_ID,
  siteConfig,
  sleep,
  startFakeBotFare,
  startPublisher,
} from "./helpers";

const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)";

describe("botfare() with BotFare up", () => {
  let botfare: Awaited<ReturnType<typeof startFakeBotFare>>;
  let site: Awaited<ReturnType<typeof startPublisher>>;
  let agent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    botfare = await startFakeBotFare();
    site = await startPublisher({ botfareUrl: botfare.url });
    agent = await createAgent(botfare.ledger);
  });
  afterAll(async () => {
    await site.close();
    await botfare.close();
  });

  it("serves a human on an agents-only path for free", async () => {
    const res = await fetch(`${site.url}/articles/burr-basics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The full article.");
    expect(res.headers.get("payment-required")).toBeNull();
  });

  it("answers an agent with a V2 402 and the preview body", async () => {
    const res = await agent.fetch(`${site.url}/articles/burr-basics`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    expect(required.x402Version).toBe(2);
    expect(required.resource).toMatchObject({
      url: `${site.url}/articles/burr-basics`,
      description: "Full article",
      mimeType: "text/html",
    });
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: "prepaid",
        network: "paypal:sandbox",
        asset: "USD",
        amount: "3",
        payTo: SITE_ID,
        maxTimeoutSeconds: 60,
      }),
    ]);
    expect(await res.json()).toEqual({
      preview: {
        title: "Preview of /articles/burr-basics",
        excerpt: "Burr grinders crush beans between two abrasive surfaces...",
        wordCount: 1200,
      },
    });
  });

  it("serves a paid retry with PAYMENT-RESPONSE and moves the wallet", async () => {
    const before = agent.wallet();
    const res = await agent.payingFetch(`${site.url}/articles/burr-basics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The full article.");
    const settlement = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "");
    expect(settlement).toMatchObject({
      success: true,
      payer: "ak_test",
      network: "paypal:sandbox",
    });
    expect(settlement.transaction).toMatch(/^rcpt_/);
    expect(before - agent.wallet()).toBe(30_000);
    expect(botfare.ledger.balanceMicros(`earnings:${SITE_ID}`)).toBe(28_500);
    expect(botfare.ledger.totalMicros()).toBe(0);
  });

  it("sends the site's Basic auth to verify and settle", () => {
    expect(botfare.calls).toContain("POST /api/x402/verify");
    expect(botfare.calls).toContain("POST /api/x402/settle");
  });

  it("charges everyone on an 'everyone' path, even without the agent header", async () => {
    const res = await fetch(`${site.url}/api/brew-ratio`);
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    expect(required.accepts[0]?.amount).toBe("2");
  });

  it("shows a browser on an 'everyone' path a plain HTML paywall", async () => {
    const res = await fetch(`${site.url}/api/brew-ratio`, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
    });
    expect(res.status).toBe(402);
    expect(await res.text()).toContain("costs $0.02 per request");
  });

  it("leaves unpriced and free paths free, even for agents", async () => {
    const about = await agent.fetch(`${site.url}/about`);
    expect(about.status).toBe(200);
    const free = await agent.fetch(`${site.url}/articles/free-sample`);
    expect(free.status).toBe(200);
  });

  it("prices other spellings of a paid path the same", async () => {
    for (const path of ["/API/Brew-Ratio", "/api/brew-ratio/", "//api//brew-ratio"]) {
      const res = await fetch(`${site.url}${path}`);
      expect(res.status, path).toBe(402);
    }
  });

  it("does not charge a known AI bot unless the site opts in", async () => {
    const res = await fetch(`${site.url}/articles/burr-basics`, {
      headers: { "user-agent": GPTBOT_UA },
    });
    expect(res.status).toBe(200);
  });
});

describe("botfare() config refresh", () => {
  it("charges known bots when chargeKnownBots is on, and picks up price changes after the TTL", async () => {
    const botfare = await startFakeBotFare(siteConfig({ chargeKnownBots: true }));
    const site = await startPublisher({ botfareUrl: botfare.url, configTtlMs: 150 });
    try {
      const bot = await fetch(`${site.url}/articles/burr-basics`, {
        headers: { "user-agent": GPTBOT_UA },
      });
      expect(bot.status).toBe(402);

      const priceOf = async () => {
        const res = await fetch(`${site.url}/api/brew-ratio`);
        return decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "").accepts[0]
          ?.amount;
      };
      expect(await priceOf()).toBe("2");
      const base = siteConfig({ chargeKnownBots: true });
      botfare.setConfig({
        ...base,
        version: "v2",
        pricing: base.pricing.map((rule) =>
          rule.pattern === "/api/brew-ratio" ? { ...rule, priceCents: 5 } : rule,
        ),
      });
      expect(await priceOf()).toBe("2"); // still cached
      await sleep(200);
      expect(await priceOf()).toBe("5");
      expect(site.logs).toContain("site config version v2 loaded");
    } finally {
      await site.close();
      await botfare.close();
    }
  });
});

describe("botfare() with BotFare down", () => {
  it("passes every request through when no config has ever loaded", async () => {
    const dead: Listening = await listen((await import("express")).default());
    await dead.close();
    const site = await startPublisher({ botfareUrl: dead.url });
    try {
      const human = await fetch(`${site.url}/articles/burr-basics`);
      expect(human.status).toBe(200);
      const agent = await fetch(`${site.url}/api/brew-ratio`, {
        headers: { [AGENT_HEADER]: "1" },
      });
      expect(agent.status).toBe(200);
      expect(site.logs.some((msg) => msg.includes("site config fetch failed"))).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("keeps serving humans and answers agents 503 when the facilitator is unreachable", async () => {
    const botfare = await startFakeBotFare();
    const site = await startPublisher({ botfareUrl: botfare.url });
    try {
      // Load the config while BotFare is up, then take BotFare down before any paid request.
      expect((await fetch(`${site.url}/about`)).status).toBe(200);
      await botfare.close();

      const human = await fetch(`${site.url}/articles/burr-basics`);
      expect(human.status).toBe(200);

      const agent = await fetch(`${site.url}/articles/burr-basics`, {
        headers: { [AGENT_HEADER]: "1" },
      });
      expect(agent.status).toBe(503);
      expect(agent.headers.get("retry-after")).toBe("5");
      expect(await agent.json()).toMatchObject({ error: "botfare_unavailable" });
    } finally {
      await site.close();
    }
  });
});
