import { DEMO_SITE_FREE_PATHS, DEMO_SITE_NAME, pricingRuleSchema } from "@botfare/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  demoOptionsFromEnv,
  FARE_COURT_STUB_PATH,
  FARE_COURT_STUB_SLUG,
  type RunningDemo,
  startDemo,
  withScheme,
} from "../src/app";
import { loadArticles, parseArticle, SECTIONS, truncate } from "../src/content";
import { markdownToHtml } from "../src/markdown";
import { NUTRITION, NUTRITION_RECIPES, nutritionFor } from "../src/nutrition";
import { fare, fareNote } from "../src/pages";
import { freePaths, priceCentsFor, pricing, SITE_NAME, SITE_TAGLINE } from "../src/pricing";

interface Catalog {
  site: { name: string; description: string };
  sections: Array<{ id: string; name: string; url: string }>;
  articles: Array<{
    slug: string;
    section: string;
    url: string;
    title: string;
    excerpt: string;
    priceCents: number;
    wordCount: number;
  }>;
  api: Array<{ method: string; path: string; priceCents: number; query: { recipe: string[] } }>;
}

const BROWSER = { accept: "text/html", "user-agent": "Mozilla/5.0" };

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
    expect(await res.json()).toEqual({ ok: true, site: "Saffron & Salt", payments: "off" });
  });

  it("lists every page and the API in catalog.json with the prices from pricing.ts", async () => {
    const catalog = (await (await fetch(`${demo.url}/catalog.json`)).json()) as Catalog;
    expect(catalog.site).toMatchObject({
      name: "Saffron & Salt",
      description: "Home cooking for weeknights, from a cook who freezes everything.",
    });
    expect(catalog.sections.map((s) => s.url)).toEqual([
      `${demo.url}/recipes`,
      `${demo.url}/techniques`,
      `${demo.url}/meal-plans`,
      `${demo.url}/cookbook`,
    ]);
    expect(catalog.articles.map((a) => [`/${a.section}/${a.slug}`, a.priceCents])).toEqual([
      ["/recipes/weeknight-red-lentil-dal", 2],
      ["/recipes/crispy-oven-potatoes", 2],
      ["/recipes/one-pan-lemon-chicken-rice", 2],
      ["/recipes/sourdough-starter", 2],
      ["/techniques/tempering-spices", 5],
      ["/techniques/freezing-and-reheating", 5],
      ["/meal-plans/five-weeknight-dinners", 8],
      ["/cookbook/spice-pantry-chapter", 50],
    ]);
    for (const article of catalog.articles) {
      const path = `/${article.section}/${article.slug}`;
      expect(article.url).toBe(`${demo.url}${path}`);
      expect(article.priceCents).toBe(priceCentsFor("GET", path));
      expect(article.title).not.toBe("");
      expect(article.excerpt).not.toBe("");
    }
    expect(catalog.api).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/api/nutrition",
        priceCents: 1,
        query: { recipe: NUTRITION_RECIPES },
      }),
    ]);
  });

  it("keeps each page's front-matter price in line with the pricing rules", () => {
    for (const article of loadArticles()) {
      expect(article.priceCents, article.slug).toBe(priceCentsFor("GET", article.path));
    }
  });

  it("serves a human the full dal recipe for free, with the agent price note", async () => {
    const res = await fetch(`${demo.url}/recipes/weeknight-red-lentil-dal`, { headers: BROWSER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("<h1>Weeknight red lentil dal that freezes well</h1>");
    expect(html).toContain("AI agents pay 2¢ to read this page. People read free.");
    expect(html).toContain("<h2>Freezing and reheating</h2>");
    expect(html).toContain("make the tadka");
    expect(html).toContain('href="/techniques/freezing-and-reheating"');
    expect(html).toContain('<a href="/recipes" aria-current="page">Recipes</a>');
    expect(html).toContain("<article");
  });

  it("shows each section's price in the note on its pages", async () => {
    for (const [path, note] of [
      ["/techniques/tempering-spices", "AI agents pay 5¢ to read this page."],
      ["/meal-plans/five-weeknight-dinners", "AI agents pay 8¢ to read this page."],
      ["/cookbook/spice-pantry-chapter", "AI agents pay 50¢ to read this page."],
    ] as const) {
      const html = await (await fetch(`${demo.url}${path}`, { headers: BROWSER })).text();
      expect(html, path).toContain(note);
    }
  });

  it("serves the home page, section indexes, static assets and 404s", async () => {
    const home = await (await fetch(`${demo.url}/`)).text();
    expect(home).toContain("<title>Saffron &amp; Salt</title>");
    expect(home).toContain("People read every page free. AI agents pay 2¢ to 50¢ a page");
    for (const section of SECTIONS) expect(home).toContain(`href="/${section.id}"`);
    expect(home).toContain('href="/recipes/weeknight-red-lentil-dal"');
    expect(home).toContain('href="/cookbook/spice-pantry-chapter"');

    const recipes = await (await fetch(`${demo.url}/recipes`)).text();
    expect(recipes).toContain("<h1>Recipes</h1>");
    expect(recipes).toContain('href="/recipes/crispy-oven-potatoes"');
    expect(recipes).not.toContain('href="/techniques/tempering-spices"');
    expect((await fetch(`${demo.url}/meal-plans/`)).status).toBe(200);
    expect((await fetch(`${demo.url}/Cookbook`)).status).toBe(200);

    expect((await fetch(`${demo.url}/static/style.css`)).status).toBe(200);
    expect((await fetch(`${demo.url}/static/favicon.svg`)).status).toBe(200);
    expect((await fetch(`${demo.url}/recipes/no-such-recipe`)).status).toBe(404);
    // A page is served only under its own section.
    expect((await fetch(`${demo.url}/techniques/weeknight-red-lentil-dal`)).status).toBe(404);
    expect((await fetch(`${demo.url}/articles/weeknight-red-lentil-dal`)).status).toBe(404);
    expect((await fetch(`${demo.url}/desserts`)).status).toBe(404);
  });

  it("answers the nutrition API, with 404 for an unknown recipe and 400 for a bad query", async () => {
    const ok = await fetch(`${demo.url}/api/nutrition?recipe=weeknight-red-lentil-dal`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      recipe: "weeknight-red-lentil-dal",
      servings: 4,
      perServing: { kcal: 345, proteinG: 16, carbsG: 46, fatG: 12 },
    });
    const unknown = await fetch(`${demo.url}/api/nutrition?recipe=chocolate-cake`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "unknown_recipe" });
    expect((await fetch(`${demo.url}/api/nutrition?recipe=constructor`)).status).toBe(404);
    const bad = await fetch(`${demo.url}/api/nutrition`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_query", recipes: NUTRITION_RECIPES });
  });
});

describe("the pages", () => {
  const articles = loadArticles();
  const bySlug = new Map(articles.map((article) => [article.slug, article]));

  it("are the eight pages in the spec, in section order", () => {
    expect(articles.map((a) => a.path)).toEqual([
      "/recipes/weeknight-red-lentil-dal",
      "/recipes/crispy-oven-potatoes",
      "/recipes/one-pan-lemon-chicken-rice",
      "/recipes/sourdough-starter",
      "/techniques/tempering-spices",
      "/techniques/freezing-and-reheating",
      "/meal-plans/five-weeknight-dinners",
      "/cookbook/spice-pantry-chapter",
    ]);
  });

  it("are 400 to 700 words, except the longer meal plan and the thin cookbook chapter", () => {
    for (const article of articles) {
      const [min, max] =
        article.section === "cookbook"
          ? [100, 300]
          : article.section === "meal-plans"
            ? [400, 900]
            : [400, 700];
      expect(article.wordCount, article.slug).toBeGreaterThanOrEqual(min);
      expect(article.wordCount, article.slug).toBeLessThanOrEqual(max);
    }
  });

  it("open with their title and keep the copy plain", () => {
    for (const article of articles) {
      expect(article.markdown.startsWith(`# ${article.title}\n`), article.slug).toBe(true);
      expect(article.excerpt.length, article.slug).toBeLessThanOrEqual(200);
      for (const text of [article.markdown, article.excerpt]) {
        expect(text, article.slug).not.toMatch(/—|\bseamless|\bsimply\b|\bjust\b|\binstantly\b/i);
        expect(text, article.slug).not.toMatch(/\?/);
      }
    }
  });

  it("give temperatures in both Celsius and Fahrenheit", () => {
    for (const article of articles) {
      const celsius = article.markdown.match(/-?\d+°C(?! \()/g) ?? [];
      expect(celsius, `${article.slug} has a °C with no °F`).toEqual([]);
    }
  });

  it("answer the research agent's dal, potato and sourdough questions", () => {
    const dal = bySlug.get("weeknight-red-lentil-dal")?.markdown ?? "";
    expect(dal).toMatch(/tadka/);
    expect(dal).toMatch(/## Freezing and reheating/);
    expect(dal).toMatch(/250 g/);
    const freezing = bySlug.get("freezing-and-reheating")?.markdown ?? "";
    expect(freezing).toMatch(/dal/);
    expect(freezing).toMatch(/-18°C \(0°F\)/);
    const potatoes = bySlug.get("crispy-oven-potatoes")?.markdown ?? "";
    expect(potatoes).toMatch(/baking soda/);
    expect(potatoes).toMatch(/220°C \(425°F\)/);
    const sourdough = bySlug.get(FARE_COURT_STUB_SLUG);
    expect(sourdough?.path).toBe(FARE_COURT_STUB_PATH);
    expect(truncate(sourdough?.lead ?? "", 280)).toMatch(/^A sourdough starter is flour and water/);
  });

  it("keep the cookbook chapter to a short list of about 20 spices", () => {
    const chapter = bySlug.get("spice-pantry-chapter");
    expect(chapter?.markdown.match(/^- /gm)?.length).toBe(20);
    expect(chapter?.priceCents).toBe(50);
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

describe("nutrition", () => {
  it("has figures for every recipe, with servings matching its yield", () => {
    const recipes = loadArticles().filter((article) => article.section === "recipes");
    expect([...NUTRITION_RECIPES].sort()).toEqual(recipes.map((r) => r.slug).sort());
    for (const recipe of recipes) {
      const serves = /^Serves (\d+)$/.exec(recipe.yield ?? "")?.[1];
      if (serves) expect(NUTRITION[recipe.slug]?.servings, recipe.slug).toBe(Number(serves));
    }
  });

  it("has plausible numbers: energy close to 4/4/9 kcal per gram of protein, carbs and fat", () => {
    for (const slug of NUTRITION_RECIPES) {
      const { perServing } = nutritionFor(slug) ?? { perServing: undefined };
      if (!perServing) throw new Error(slug);
      const computed = 4 * perServing.proteinG + 4 * perServing.carbsG + 9 * perServing.fatG;
      expect(Math.abs(computed - perServing.kcal) / perServing.kcal, slug).toBeLessThan(0.1);
    }
  });

  it("returns undefined for an unknown recipe, including object keys", () => {
    expect(nutritionFor("chocolate-cake")).toBeUndefined();
    expect(nutritionFor("constructor")).toBeUndefined();
    expect(nutritionFor("crispy-oven-potatoes")).toMatchObject({ servings: 4 });
  });
});

describe("pricing.ts", () => {
  it("is the contracts' demo site: one rule per section, then the nutrition API", () => {
    expect(SITE_NAME).toBe(DEMO_SITE_NAME);
    expect(SITE_TAGLINE).toBe("Home cooking for weeknights, from a cook who freezes everything.");
    for (const rule of pricing) expect(pricingRuleSchema.parse(rule)).toEqual(rule);
    expect(pricing.map((r) => [r.pattern, r.priceCents, r.audience])).toEqual([
      ["/cookbook/*", 50, "agents"],
      ["/meal-plans/*", 8, "agents"],
      ["/techniques/*", 5, "agents"],
      ["/recipes/*", 2, "agents"],
      ["/api/nutrition", 1, "everyone"],
    ]);
    expect(freePaths).toEqual(DEMO_SITE_FREE_PATHS);
    expect(freePaths).toEqual(
      expect.arrayContaining(["/", "/catalog.json", "/health", "/static/*", "/favicon.ico"]),
    );
  });

  it("keeps the home page, section indexes and plumbing free", () => {
    for (const path of ["/", "/recipes", "/techniques", "/meal-plans", "/cookbook"]) {
      expect(priceCentsFor("GET", path), path).toBe(0);
    }
    expect(priceCentsFor("GET", "/static/style.css")).toBe(0);
    expect(priceCentsFor("GET", "/catalog.json")).toBe(0);
  });

  it("prices only the cookbook chapter above the research agent's 10¢ page cap", () => {
    const overCap = loadArticles().filter((article) => article.priceCents > 10);
    expect(overCap.map((article) => article.path)).toEqual(["/cookbook/spice-pantry-chapter"]);
  });
});

describe("page helpers", () => {
  it("formats fares and the agent note", () => {
    expect(fare(2)).toBe("2¢");
    expect(fare(50)).toBe("50¢");
    expect(fare(150)).toBe("$1.50");
    expect(fareNote(2)).toBe("AI agents pay 2¢ to read this page. People read free.");
    expect(fareNote(0)).toBe("Free for everyone, AI agents included.");
  });
});

describe("content helpers", () => {
  it("parses front matter and renders the markdown subset safely", () => {
    const article = parseArticle(
      '---\nslug: x\nsection: techniques\ntitle: "A: b"\nexcerpt: e\npriceCents: 3\nyield: Serves 2\n---\n# T\n\nOne *two* **three** <b>.\n\n- a\n- b\n\n1. c\n',
    );
    expect(article).toMatchObject({
      slug: "x",
      section: "techniques",
      path: "/techniques/x",
      title: "A: b",
      priceCents: 3,
      yield: "Serves 2",
      wordCount: 8,
    });
    expect(article.html).toBe(
      "<h1>T</h1>\n<p>One <em>two</em> <strong>three</strong> &lt;b&gt;.</p>\n<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li></ol>",
    );
    expect(markdownToHtml("[x](javascript:alert(1))")).not.toContain("<a");
  });

  it("rejects a page without a known section", () => {
    const page = (section: string) =>
      `---\nslug: x\n${section}title: t\nexcerpt: e\npriceCents: 3\n---\n# T\n`;
    expect(() => parseArticle(page(""))).toThrow();
    expect(() => parseArticle(page("section: desserts\n"))).toThrow();
  });

  it("truncates at a word boundary", () => {
    expect(truncate("short", 280)).toBe("short");
    const cut = truncate("word ".repeat(100), 280);
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(cut.endsWith("word…")).toBe(true);
  });
});
