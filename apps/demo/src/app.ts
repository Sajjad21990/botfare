/**
 * The Saffron & Salt demo publisher: original recipes, techniques, a meal plan and a cookbook
 * chapter, plus a nutrition API, behind `botfare()`. Humans read free; agents pay per request.
 * Without BotFare credentials it runs in free mode.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AGENT_HEADER, type OfferPreview } from "@botfare/contracts";
import { type BotFareLocals, botfare, normalizePath } from "@botfare/express";
import express, { type Request } from "express";
import { type Article, loadArticles, SECTIONS, sectionById, truncate } from "./content";
import { NUTRITION_RECIPES, nutritionFor, nutritionQuerySchema } from "./nutrition";
import { articlePage, homePage, notFoundPage, sectionPage, subscribeStubPage } from "./pages";
import { priceCentsFor, SITE_NAME, SITE_TAGLINE } from "./pricing";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const PREVIEW_CHARS = 280;

/**
 * FARE COURT DEMO CASE (deliberately bad publisher behaviour). This 2¢ recipe has a real, useful
 * preview, and humans reading free get the full guide, but an agent that *pays* for it is served
 * a "subscribe to keep reading" stub instead. botfare() still attests the digest of that stub, so
 * the agent can prove what it received, file a dispute, and Fare Court refunds the fare. Every
 * other page is served honestly.
 */
export const FARE_COURT_STUB_SLUG = "sourdough-starter";
/** Where the stub page lives (its section prefix plus FARE_COURT_STUB_SLUG). */
export const FARE_COURT_STUB_PATH = "/recipes/sourdough-starter";

/** True when botfare() verified a payment for this request (the handler only runs after that). */
function isPaidRequest(res: express.Response): boolean {
  const detection = res.locals.botfare as BotFareLocals | undefined;
  return Boolean(detection?.charge && detection.signal);
}

export interface DemoOptions {
  /** BotFare site ID (`site_…`). With the secret and URL set, agents pay; otherwise free mode. */
  siteId?: string;
  siteSecret?: string;
  /** BotFare app origin; the facilitator lives at `${botfareUrl}/api/x402`. */
  botfareUrl?: string;
  /** Public origin used for URLs in catalog.json. Default: the request's own origin. */
  origin?: string;
  /** Directory of markdown pages. Default: apps/demo/content. */
  contentDir?: string;
  /** Passed to botfare(). */
  configTtlMs?: number;
  /**
   * Cloudflare Turnstile secret for the "Reading as a human? Continue free." check (env
   * TURNSTILE_SECRET_KEY). Optional: with Cloudflare's test site key, botfare() falls back to
   * Cloudflare's always-pass test secret, and without a site key there is no human check.
   */
  turnstileSecret?: string;
  /** Default: `console.log` with a `[demo]` prefix (botfare() logs get `[botfare]`). */
  logger?: (msg: string) => void;
}

export function createApp(options: DemoOptions = {}): express.Express {
  const log = options.logger ?? ((msg: string) => console.log(`[demo] ${msg}`));
  const articles = loadArticles(options.contentDir);
  const bySlug = new Map(articles.map((article) => [article.slug, article]));
  const priced = (article: Article) => ({
    ...article,
    priceCents: priceCentsFor("GET", article.path),
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true); // Render terminates TLS in front of us; keeps req.protocol right

  const { siteId, siteSecret, botfareUrl } = options;
  const paymentsOn = Boolean(siteId && siteSecret && botfareUrl);
  app.locals.paymentsOn = paymentsOn;
  if (siteId && siteSecret && botfareUrl) {
    log(`${SITE_NAME}: BotFare payments on for ${siteId} via ${botfareUrl}`);
    app.use(
      botfare({
        siteId,
        siteSecret,
        botfareUrl,
        configTtlMs: options.configTtlMs,
        turnstileSecret: options.turnstileSecret,
        logger: options.logger,
        preview: (req) => previewFor(req, bySlug),
      }),
    );
  } else {
    log(
      `${SITE_NAME}: free mode, everything is free for everyone. Set BOTFARE_SITE_ID, BOTFARE_SITE_SECRET and BOTFARE_URL to charge agents.`,
    );
  }

  app.use("/static", express.static(PUBLIC_DIR, { maxAge: "1h" }));

  app.get("/", (_req, res) => {
    res.type("html").send(homePage(articles.map(priced)));
  });

  app.get("/api/nutrition", (req, res) => {
    const query = nutritionQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        error: "invalid_query",
        message: `Use ?recipe=<slug>, one of: ${NUTRITION_RECIPES.join(", ")}`,
        recipes: NUTRITION_RECIPES,
      });
      return;
    }
    const nutrition = nutritionFor(query.data.recipe);
    if (!nutrition) {
      res.status(404).json({
        error: "unknown_recipe",
        message: `No nutrition figures for "${query.data.recipe}". Use one of: ${NUTRITION_RECIPES.join(", ")}`,
        recipes: NUTRITION_RECIPES,
      });
      return;
    }
    res.json(nutrition);
  });

  app.get("/catalog.json", (req, res) => {
    const origin = options.origin ?? `${req.protocol}://${req.get("host")}`;
    res.json({
      site: { name: SITE_NAME, description: SITE_TAGLINE, url: `${origin}/` },
      access: {
        humans: "free",
        agents: `pay per request over x402 (scheme "prepaid", network "paypal:sandbox", amounts in USD cents); send the ${AGENT_HEADER} header`,
        payments: paymentsOn ? "on" : "off (free mode)",
      },
      sections: SECTIONS.map((section) => ({
        id: section.id,
        name: section.name,
        description: section.description,
        url: `${origin}/${section.id}`,
      })),
      articles: articles.map((article) => ({
        slug: article.slug,
        section: article.section,
        url: `${origin}${article.path}`,
        title: article.title,
        excerpt: article.excerpt,
        priceCents: priced(article).priceCents,
        wordCount: article.wordCount,
      })),
      api: [
        {
          method: "GET",
          path: "/api/nutrition",
          url: `${origin}/api/nutrition`,
          description: "Calories, protein, carbs and fat per serving for one recipe.",
          priceCents: priceCentsFor("GET", "/api/nutrition"),
          audience: "everyone",
          query: { recipe: NUTRITION_RECIPES },
          example: `${origin}/api/nutrition?recipe=${NUTRITION_RECIPES[0]}`,
        },
      ],
    });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, site: SITE_NAME, payments: paymentsOn ? "on" : "off" });
  });

  app.get("/favicon.ico", (_req, res) => {
    res.redirect(301, "/static/favicon.svg");
  });

  // Section indexes (free) and pages (priced by section). Express matches case-insensitively and
  // ignores a trailing slash, the same as botfare()'s path normalization.
  app.get("/:section", (req, res, next) => {
    const section = sectionById(req.params.section);
    if (!section) return next();
    const pages = articles.filter((article) => article.section === section.id).map(priced);
    res.type("html").send(sectionPage(section, pages));
  });

  app.get("/:section/:slug", (req, res, next) => {
    const section = sectionById(req.params.section);
    if (!section) return next();
    const article = bySlug.get(req.params.slug.toLowerCase());
    if (!article || article.section !== section.id) {
      res.status(404).type("html").send(notFoundPage());
      return;
    }
    if (article.slug === FARE_COURT_STUB_SLUG && isPaidRequest(res)) {
      res.type("html").send(subscribeStubPage(article)); // the Fare Court demo case, see above
      return;
    }
    res.type("html").send(articlePage(article, priced(article).priceCents));
  });

  app.use((_req, res) => {
    res.status(404).type("html").send(notFoundPage());
  });

  return app;
}

const PAGE_PATH = /^\/([a-z0-9-]+)\/([^/]+)$/;

/** The free preview in the 402 body: title, the first ~280 characters and the length. */
function previewFor(req: Request, bySlug: Map<string, Article>): OfferPreview | undefined {
  const path = normalizePath(req.baseUrl + req.path);
  if (path === "/api/nutrition") {
    return {
      title: "Nutrition API",
      excerpt: `JSON for one recipe per call: servings, plus calories, protein, carbs and fat per serving. Recipes: ${NUTRITION_RECIPES.join(", ")}.`,
    };
  }
  const [, section, slug] = PAGE_PATH.exec(path) ?? [];
  const article = slug ? bySlug.get(slug) : undefined;
  if (article && article.section === section) {
    return {
      title: article.title,
      excerpt: truncate(article.lead, PREVIEW_CHARS),
      wordCount: article.wordCount,
    };
  }
  return undefined;
}

/**
 * PORT (default 4000), HOST (default 0.0.0.0), BOTFARE_SITE_ID, BOTFARE_SITE_SECRET,
 * BOTFARE_URL, DEMO_ORIGIN (public origin for catalog URLs; default: the request's origin).
 */
export function demoOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? "0.0.0.0",
    siteId: env.BOTFARE_SITE_ID || undefined,
    siteSecret: env.BOTFARE_SITE_SECRET || undefined,
    botfareUrl: withScheme(env.BOTFARE_URL),
    origin: env.DEMO_ORIGIN || undefined,
    turnstileSecret: env.TURNSTILE_SECRET_KEY?.trim() || undefined,
  } satisfies DemoOptions & { port: number; host: string };
}

/**
 * BOTFARE_URL may be a bare `host:port` (Render's `fromService` hostport on the private network);
 * that gets `http://`. Full URLs pass through unchanged.
 */
export function withScheme(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export interface RunningDemo {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

/** Starts the demo on `port` (0 picks a free one). Used by server.ts, tests and the e2e script. */
export function startDemo(
  options: DemoOptions & { port?: number; host?: string } = {},
): Promise<RunningDemo> {
  const app = createApp(options);
  return new Promise((resolve, reject) => {
    const server = app.listen(options.port ?? 0, options.host ?? "127.0.0.1", (error?: Error) => {
      if (error) return reject(error);
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${options.host === "0.0.0.0" ? "localhost" : (options.host ?? "127.0.0.1")}:${port}`,
        port,
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
