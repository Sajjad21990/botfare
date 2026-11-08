/**
 * The Crema Notes demo publisher: original articles and a brew-ratio API behind `botfare()`.
 * Humans read free; agents pay per request. Without BotFare credentials it runs in free mode.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AGENT_HEADER, type OfferPreview } from "@botfare/contracts";
import { botfare, normalizePath } from "@botfare/express";
import express, { type Request } from "express";
import { BREW_METHODS, brewRatio, brewRatioQuerySchema } from "./brew-ratio";
import { type Article, loadArticles, truncate } from "./content";
import { articlePage, indexPage, notFoundPage } from "./pages";
import { priceCentsFor, SITE_NAME, SITE_TAGLINE } from "./pricing";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const PREVIEW_CHARS = 280;

export interface DemoOptions {
  /** BotFare site ID (`site_…`). With the secret and URL set, agents pay; otherwise free mode. */
  siteId?: string;
  siteSecret?: string;
  /** BotFare app origin; the facilitator lives at `${botfareUrl}/api/x402`. */
  botfareUrl?: string;
  /** Public origin used for URLs in catalog.json. Default: the request's own origin. */
  origin?: string;
  /** Directory of markdown articles. Default: apps/demo/content. */
  contentDir?: string;
  /** Passed to botfare(). */
  configTtlMs?: number;
  /** Default: `console.log` with a `[demo]` prefix (botfare() logs get `[botfare]`). */
  logger?: (msg: string) => void;
}

export function createApp(options: DemoOptions = {}): express.Express {
  const log = options.logger ?? ((msg: string) => console.log(`[demo] ${msg}`));
  const articles = loadArticles(options.contentDir);
  const bySlug = new Map(articles.map((article) => [article.slug, article]));
  const priced = (article: Article) => ({
    ...article,
    priceCents: priceCentsFor("GET", `/articles/${article.slug}`),
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
    res.type("html").send(indexPage(articles.map(priced)));
  });

  app.get("/articles/:slug", (req, res) => {
    const article = bySlug.get(req.params.slug.toLowerCase());
    if (!article) {
      res.status(404).type("html").send(notFoundPage());
      return;
    }
    res.type("html").send(articlePage(article));
  });

  app.get("/api/brew-ratio", (req, res) => {
    const query = brewRatioQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        error: "invalid_query",
        message: `Use ?method=${Object.keys(BREW_METHODS).join("|")}&coffeeGrams=1..250`,
        issues: query.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      return;
    }
    res.json(brewRatio(query.data.method, query.data.coffeeGrams));
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
      articles: articles.map((article) => ({
        slug: article.slug,
        url: `${origin}/articles/${article.slug}`,
        title: article.title,
        excerpt: article.excerpt,
        priceCents: priced(article).priceCents,
        wordCount: article.wordCount,
      })),
      api: [
        {
          method: "GET",
          path: "/api/brew-ratio",
          url: `${origin}/api/brew-ratio`,
          description: "Water, grind, time and temperature for a dose of coffee.",
          priceCents: priceCentsFor("GET", "/api/brew-ratio"),
          audience: "everyone",
          query: {
            method: Object.keys(BREW_METHODS),
            coffeeGrams: "number, 1 to 250",
          },
          example: `${origin}/api/brew-ratio?method=v60&coffeeGrams=15`,
        },
      ],
    });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, site: SITE_NAME, payments: paymentsOn ? "on" : "off" });
  });

  app.use((_req, res) => {
    res.status(404).type("html").send(notFoundPage());
  });

  return app;
}

/** The free preview in the 402 body: title, the first ~280 characters and the length. */
function previewFor(req: Request, bySlug: Map<string, Article>): OfferPreview | undefined {
  const path = normalizePath(req.baseUrl + req.path);
  const slug = /^\/articles\/([^/]+)$/.exec(path)?.[1];
  const article = slug ? bySlug.get(slug) : undefined;
  if (article) {
    return {
      title: article.title,
      excerpt: truncate(article.lead, PREVIEW_CHARS),
      wordCount: article.wordCount,
    };
  }
  if (path === "/api/brew-ratio") {
    return {
      title: "Brew ratio API",
      excerpt:
        "JSON recipe for a dose of coffee: water (or espresso yield) in grams, ratio, grind size, brew time and temperature. Methods: v60, espresso, french-press.",
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
