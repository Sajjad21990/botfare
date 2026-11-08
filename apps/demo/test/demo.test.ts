import { pricingRuleSchema } from "@botfare/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoOptionsFromEnv, type RunningDemo, startDemo, withScheme } from "../src/app";
import { brewRatio } from "../src/brew-ratio";
import { loadArticles, parseArticle, truncate } from "../src/content";
import { markdownToHtml } from "../src/markdown";
import { freePaths, priceCentsFor, pricing } from "../src/pricing";

interface Catalog {
  site: { name: string };
  articles: Array<{
    slug: string;
    url: string;
    title: string;
    excerpt: string;
    priceCents: number;
    wordCount: number;
  }>;
  api: Array<{ method: string; path: string; priceCents: number }>;
}

describe("demo publisher in free mode (no BotFare configured)", () => {
  let demo: RunningDemo;
  const logs: string[] = [];

  beforeAll(async () => {
    demo = await startDemo({ logger: (msg) => logs.push(msg) });
  });
  afterAll(() => demo.close());

  it("starts and says it is in free mode", async () => {
    expect(logs.join("\n")).toMatch(/free mode/);
    const res = await fetch(`${demo.url}/health`);
    expect(await res.json()).toEqual({ ok: true, site: "Crema Notes", payments: "off" });
  });

  it("lists every article and the API in catalog.json with the prices from pricing.ts", async () => {
    const catalog = (await (await fetch(`${demo.url}/catalog.json`)).json()) as Catalog;
    expect(catalog.site.name).toBe("Crema Notes");
    const prices = Object.fromEntries(catalog.articles.map((a) => [a.slug, a.priceCents]));
    expect(prices).toEqual({
      "burr-basics": 3,
      "dialing-in-espresso": 5,
      "grinder-maintenance": 3,
      "grinders-under-200": 3,
      "latte-art-hearts": 3,
      "premium-grinder-roundup": 50,
    });
    for (const article of catalog.articles) {
      expect(article.url).toBe(`${demo.url}/articles/${article.slug}`);
      expect(article.priceCents).toBe(priceCentsFor("GET", `/articles/${article.slug}`));
      expect(article.wordCount).toBeGreaterThanOrEqual(500);
      expect(article.wordCount).toBeLessThanOrEqual(900);
      expect(article.title).not.toBe("");
      expect(article.excerpt).not.toBe("");
    }
    expect(catalog.api).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/brew-ratio", priceCents: 1 }),
    ]);
  });

  it("keeps each article's front-matter price in line with the pricing rules", () => {
    for (const article of loadArticles()) {
      expect(article.priceCents, article.slug).toBe(
        priceCentsFor("GET", `/articles/${article.slug}`),
      );
    }
  });

  it("serves a human the full article for free", async () => {
    const res = await fetch(`${demo.url}/articles/grinders-under-200`, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("<h1>Choosing a home grinder under $200</h1>");
    expect(html).toContain("<strong>Okto Flatline 54</strong>");
    expect(html).toContain("A clean grinder at $129 will beat a dirty one at $199.");
  });

  it("serves the index, static assets and 404s", async () => {
    const index = await (await fetch(`${demo.url}/`)).text();
    expect(index).toContain("Humans read everything free.");
    expect(index).toContain('href="/articles/latte-art-hearts"');
    expect((await fetch(`${demo.url}/static/style.css`)).status).toBe(200);
    expect((await fetch(`${demo.url}/articles/no-such-article`)).status).toBe(404);
  });

  it("answers the brew-ratio API and rejects bad queries", async () => {
    const ok = await fetch(`${demo.url}/api/brew-ratio?method=pour-over&coffeeGrams=15`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      method: "pour-over",
      coffeeGrams: 15,
      waterGrams: 240,
    });
    const bad = await fetch(`${demo.url}/api/brew-ratio?method=drip&coffeeGrams=abc`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_query" });
  });
});

describe("demoOptionsFromEnv()", () => {
  it("reads the BotFare settings and accepts a bare host:port for BOTFARE_URL", () => {
    expect(withScheme("botfare-web:10000")).toBe("http://botfare-web:10000");
    expect(withScheme("https://botfare.example")).toBe("https://botfare.example");
    expect(withScheme("  ")).toBeUndefined();
    expect(
      demoOptionsFromEnv({ BOTFARE_URL: "botfare-web:10000", BOTFARE_SITE_ID: "site_x" }),
    ).toMatchObject({
      port: 4000,
      host: "0.0.0.0",
      siteId: "site_x",
      siteSecret: undefined,
      botfareUrl: "http://botfare-web:10000",
      turnstileSecret: undefined,
    });
    expect(demoOptionsFromEnv({ TURNSTILE_SECRET_KEY: " 0x4AAA-secret " }).turnstileSecret).toBe(
      "0x4AAA-secret",
    );
  });
});

describe("brewRatio()", () => {
  it("scales each house recipe to the dose", () => {
    expect(brewRatio("pour-over", 15)).toMatchObject({ waterGrams: 240, ratio: "1:16" });
    expect(brewRatio("pour-over", 22)).toMatchObject({ waterGrams: 352 });
    expect(brewRatio("espresso", 18)).toMatchObject({
      waterGrams: 36,
      ratio: "1:2",
      brewSeconds: { min: 26, max: 32 },
    });
    expect(brewRatio("french-press", 30)).toMatchObject({ waterGrams: 450, ratio: "1:15" });
  });

  it("rounds the dose to 0.1 g and water to the gram", () => {
    expect(brewRatio("pour-over", 15.04)).toMatchObject({ coffeeGrams: 15, waterGrams: 240 });
    expect(brewRatio("espresso", 18.26)).toMatchObject({ coffeeGrams: 18.3, waterGrams: 37 });
  });
});

describe("pricing.ts", () => {
  it("contains only valid rules, most specific first", () => {
    for (const rule of pricing) expect(pricingRuleSchema.parse(rule)).toEqual(rule);
    expect(pricing.map((r) => [r.pattern, r.priceCents, r.audience])).toEqual([
      ["/articles/premium-*", 50, "agents"],
      ["/articles/dialing-in-espresso", 5, "agents"],
      ["/articles/*", 3, "agents"],
      ["/api/brew-ratio", 1, "everyone"],
    ]);
    expect(freePaths).toEqual(
      expect.arrayContaining(["/", "/catalog.json", "/health", "/static/*"]),
    );
    expect(priceCentsFor("GET", "/")).toBe(0);
    expect(priceCentsFor("GET", "/static/style.css")).toBe(0);
  });
});

describe("content helpers", () => {
  it("parses front matter and renders the markdown subset safely", () => {
    const article = parseArticle(
      '---\nslug: x\ntitle: "A: b"\nexcerpt: e\npriceCents: 3\n---\n# T\n\nOne *two* **three** <b>.\n\n- a\n- b\n\n1. c\n',
    );
    expect(article).toMatchObject({ slug: "x", title: "A: b", priceCents: 3, wordCount: 8 });
    expect(article.html).toBe(
      "<h1>T</h1>\n<p>One <em>two</em> <strong>three</strong> &lt;b&gt;.</p>\n<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li></ol>",
    );
    expect(markdownToHtml("[x](javascript:alert(1))")).not.toContain("<a");
  });

  it("truncates at a word boundary", () => {
    expect(truncate("short", 280)).toBe("short");
    const cut = truncate("word ".repeat(100), 280);
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(cut.endsWith("word…")).toBe(true);
  });
});
