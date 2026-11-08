/**
 * Contracts shared by the BotFare app (apps/web, packages/core), the publisher middleware
 * (packages/express), the agent SDK (packages/sdk) and the demo site. Keep this file free of
 * server-only code: it is imported on both sides of every HTTP boundary.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// IDs

export const IdPrefix = {
  user: "usr",
  site: "site",
  agentKey: "ak",
  receipt: "rcpt",
  topup: "top",
  payout: "po",
  transaction: "txn",
  dispute: "dsp",
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

/** `<prefix>_<16 lowercase hex chars>`, e.g. `site_8f2a91c04d7be311`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------------------------
// Base64 helpers that work in Node and in the browser (agent keys are generated in the browser).

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toBase64Url(base64: string): string {
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(base64url: string): string {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  return base64 + "=".repeat((4 - (base64.length % 4)) % 4);
}

// ---------------------------------------------------------------------------------------------
// HTTP surface of the BotFare app

/** The x402 facilitator lives at `${BOTFARE_URL}${FACILITATOR_PATH}`: GET /supported, POST /verify, POST /settle, POST /refund. */
export const FACILITATOR_PATH = "/api/x402";

/** Site config for the middleware: GET `${BOTFARE_URL}/api/sites/${siteId}/config` with site auth. */
export function siteConfigPath(siteId: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/config`;
}

/**
 * Publishers authenticate to the facilitator and the site-config endpoint with HTTP Basic auth:
 * `Authorization: Basic base64(siteId:siteSecret)`. `/supported` needs no auth.
 */
export function siteAuthHeader(siteId: string, siteSecret: string): string {
  return `Basic ${utf8ToBase64(`${siteId}:${siteSecret}`)}`;
}

export function parseSiteAuthHeader(
  header: string | null | undefined,
): { siteId: string; siteSecret: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header?.trim() ?? "");
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = base64ToUtf8(match[1]);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { siteId: decoded.slice(0, colon), siteSecret: decoded.slice(colon + 1) };
}

// ---------------------------------------------------------------------------------------------
// Who gets a 402

/** Agents opt in to paid access by sending this header (any value). Humans never send it. */
export const AGENT_HEADER = "x-botfare-agent";

/** Known AI crawlers/agents; charged only when the site enables `chargeKnownBots`. */
export const KNOWN_AI_BOTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "Applebot-Extended",
  "meta-externalagent",
] as const;

export function isKnownAiBot(userAgent: string | null | undefined): boolean {
  const ua = userAgent?.toLowerCase() ?? "";
  return KNOWN_AI_BOTS.some((bot) => ua.includes(bot.toLowerCase()));
}

// ---------------------------------------------------------------------------------------------
// Agent detection (who gets a 402). Score-based: "pay, or prove you're human", never a hard block.

/**
 * Strictness of agent detection on a site:
 * - "off": only self-identified agents (AGENT_HEADER, PAYMENT-SIGNATURE, signed agents) pay.
 * - "known-bots": also charge known AI crawlers (same as the old chargeKnownBots switch).
 * - "standard": also charge requests whose combined automation score reaches the threshold
 *   (edge bot scores, crawler impostors, automation heuristics); suspected humans can pass the
 *   human check (Turnstile) and read free.
 * - "strict": like standard with a lower threshold.
 */
export const detectionLevelSchema = z.enum(["off", "known-bots", "standard", "strict"]);
export type DetectionLevel = z.infer<typeof detectionLevelSchema>;

/** Why a request was treated as an agent; recorded on each receipt for "revenue recovered" analytics. */
export const detectionSignalSchema = z.enum([
  "agent-header", // sent X-BotFare-Agent
  "payment-signature", // arrived with an x402 payment
  "signed-agent", // valid HTTP Message Signature (Web Bot Auth style) from a BotFare agent key
  "known-bot", // user agent of a known AI crawler from its published IP ranges
  "bot-impostor", // claims to be a known crawler but comes from outside its published ranges
  "edge-score", // CDN bot score (Cloudflare, Akamai) below the site's threshold
  "automation", // heuristics: HTTP client libraries, headless browsers, missing browser headers
  "everyone", // the path charges everyone (APIs)
]);
export type DetectionSignal = z.infer<typeof detectionSignalSchema>;

export const detectionConfigSchema = z.object({
  level: detectionLevelSchema.default("known-bots"),
  /** Score in [0, 100] at or above which a request counts as automated ("standard": 60, "strict": 40 when unset). */
  threshold: z.number().int().min(1).max(100).optional(),
  edge: z
    .object({
      /** Cloudflare Bot Management score forwarded as a request header (1 = bot, 99 = human). */
      cloudflare: z
        .object({
          enabled: z.boolean().default(false),
          scoreHeader: z.string().default("cf-bot-score"),
          verifiedBotHeader: z.string().default("cf-verified-bot"),
          /** Scores at or below this count as bots. */
          maxBotScore: z.number().int().min(1).max(99).default(29),
        })
        .default({
          enabled: false,
          scoreHeader: "cf-bot-score",
          verifiedBotHeader: "cf-verified-bot",
          maxBotScore: 29,
        }),
      /** Akamai Bot Manager result forwarded as a request header. */
      akamai: z
        .object({
          enabled: z.boolean().default(false),
          header: z.string().default("akamai-bot"),
        })
        .default({ enabled: false, header: "akamai-bot" }),
    })
    .default({
      cloudflare: {
        enabled: false,
        scoreHeader: "cf-bot-score",
        verifiedBotHeader: "cf-verified-bot",
        maxBotScore: 29,
      },
      akamai: { enabled: false, header: "akamai-bot" },
    }),
  /** Cloudflare Turnstile site key for the "prove you're human" escape hatch; null disables it. */
  turnstileSiteKey: z.string().nullable().default(null),
});
export type DetectionConfig = z.infer<typeof detectionConfigSchema>;

export const DEFAULT_DETECTION: DetectionConfig = detectionConfigSchema.parse({});

/** Signed agents (Web Bot Auth style): BotFare publishes active agent public keys here as a JWKS. */
export const SIGNATURE_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

// ---------------------------------------------------------------------------------------------
// Site config (set in the dashboard, read by the middleware)

/**
 * A pricing rule. `pattern` is an exact path (`/api/brew-ratio`) or a prefix ending in `*`
 * (`/articles/*`). The first matching rule wins. `audience: "agents"` charges only requests
 * identified as agents (humans browse free); `"everyone"` charges every request (APIs).
 */
export const pricingRuleSchema = z.object({
  pattern: z.string().startsWith("/"),
  method: z.string().toUpperCase().default("GET"),
  priceCents: z.number().int().min(1).max(100_00),
  audience: z.enum(["agents", "everyone"]).default("agents"),
  description: z.string().max(200).optional(),
  mimeType: z.string().optional(),
});

export type PricingRule = z.infer<typeof pricingRuleSchema>;

export const siteConfigSchema = z.object({
  siteId: z.string().startsWith(`${IdPrefix.site}_`),
  name: z.string(),
  /** Public origin of the publisher, e.g. `https://brewlab-demo.onrender.com`. */
  origin: z.string().url(),
  network: z.literal("paypal:sandbox"),
  pricing: z.array(pricingRuleSchema),
  /** Paths that are always free, even for agents (same pattern syntax). */
  freePaths: z.array(z.string()).default([]),
  /** Legacy switch; superseded by detection.level ("known-bots" or stricter charges known AI crawlers). */
  chargeKnownBots: z.boolean().default(false),
  /** Agent detection settings; older configs without it behave as before. */
  detection: detectionConfigSchema.default(DEFAULT_DETECTION),
  /** Changes whenever the dashboard saves the site; lets the middleware skip unchanged configs. */
  version: z.string(),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export function matchesPattern(pattern: string, path: string): boolean {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

/** First rule matching the method and path, unless the path is free. */
export function findPricingRule(
  config: Pick<SiteConfig, "pricing" | "freePaths">,
  method: string,
  path: string,
): PricingRule | undefined {
  if (config.freePaths.some((free) => matchesPattern(free, path))) return undefined;
  const upper = method.toUpperCase();
  return config.pricing.find((rule) => rule.method === upper && matchesPattern(rule.pattern, path));
}

// ---------------------------------------------------------------------------------------------
// Agent keys

/**
 * An agent key travels as one string, e.g. in `BOTFARE_AGENT_KEY`:
 * `bfk_` + base64url(JSON `{ v: 1, keyId, privateJwk }`). BotFare stores only the public JWK.
 */
export const agentKeyPayloadSchema = z.object({
  v: z.literal(1),
  keyId: z.string().startsWith(`${IdPrefix.agentKey}_`),
  privateJwk: z
    .object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string(), d: z.string() })
    .loose(),
});

export type AgentKeyPayload = z.infer<typeof agentKeyPayloadSchema>;

const AGENT_KEY_PREFIX = "bfk_";

export function encodeAgentKey(payload: AgentKeyPayload): string {
  return AGENT_KEY_PREFIX + toBase64Url(utf8ToBase64(JSON.stringify(payload)));
}

export function decodeAgentKey(key: string): AgentKeyPayload {
  if (!key.startsWith(AGENT_KEY_PREFIX)) throw new Error("Agent key must start with bfk_");
  const json = base64ToUtf8(fromBase64Url(key.slice(AGENT_KEY_PREFIX.length)));
  return agentKeyPayloadSchema.parse(JSON.parse(json));
}

// ---------------------------------------------------------------------------------------------
// Free preview in the 402 body (read by the agent before deciding to pay)

export const offerPreviewSchema = z.object({
  title: z.string(),
  excerpt: z.string().max(600),
  wordCount: z.number().int().nonnegative().optional(),
});

export type OfferPreview = z.infer<typeof offerPreviewSchema>;

// ---------------------------------------------------------------------------------------------
// Demo personas (judge mode). The seed script creates these users; the app signs judges in as them.

export const DEMO_PERSONAS = {
  publisher: {
    email: "publisher@crema-notes.example",
    name: "Crema Notes publisher",
    label: "Publisher",
    description:
      "Runs the Crema Notes coffee site, sets prices, watches AI revenue, withdraws to PayPal.",
    home: "/publisher",
  },
  agentOwner: {
    email: "agent-owner@botfare.example",
    name: "Demo agent owner",
    label: "Agent owner",
    description: "Tops up a wallet with PayPal and gives research agents keys with budgets.",
    home: "/wallet",
  },
} as const;

export type DemoPersona = keyof typeof DEMO_PERSONAS;

// ---------------------------------------------------------------------------------------------
// The shared demo (judge mode). Every judge signs in as the same two persona users, so anything
// that would break the demo for the next judge is locked or reset for them.

/** The demo publisher's site, as `pnpm seed` registers it and apps/demo serves it. */
export const DEMO_SITE_NAME = "Crema Notes";

/** Crema Notes' prices. First match wins, so the specific article rules come first. */
export const DEMO_SITE_PRICING: PricingRule[] = [
  {
    pattern: "/articles/premium-*",
    method: "GET",
    priceCents: 50,
    audience: "agents",
    description: "Premium article (full text)",
    mimeType: "text/html",
  },
  {
    pattern: "/articles/dialing-in-espresso",
    method: "GET",
    priceCents: 5,
    audience: "agents",
    description: "Full article: Dialing in espresso at home",
    mimeType: "text/html",
  },
  {
    pattern: "/articles/*",
    method: "GET",
    priceCents: 3,
    audience: "agents",
    description: "Full article (text)",
    mimeType: "text/html",
  },
  {
    pattern: "/api/brew-ratio",
    method: "GET",
    priceCents: 1,
    audience: "everyone",
    description: "Brew ratio API: water, grind and time for a dose of coffee",
    mimeType: "application/json",
  },
];

/** Always free on Crema Notes, even for agents. */
export const DEMO_SITE_FREE_PATHS: string[] = [
  "/",
  "/catalog.json",
  "/health",
  "/static/*",
  "/favicon.ico",
];

/** Cloudflare's published Turnstile test site key that always passes (sandbox demos only). */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";

/**
 * Crema Notes' agent detection as seeded: score-based ("standard") with the Turnstile human check,
 * so a suspected human can always prove it and read free. Judge mode restores it at sign-in.
 */
export const CREMA_NOTES_DETECTION: DetectionConfig = detectionConfigSchema.parse({
  level: "standard",
  turnstileSiteKey: TURNSTILE_TEST_SITE_KEY,
});

/** Agent keys `pnpm seed` and `pnpm seed:traffic` issue to the agent-owner persona. */
export const DEMO_AGENT_KEY_NAMES: readonly string[] = [
  "Demo research agent",
  "Research agent",
  "Price watcher",
  "Newsletter bot",
];

/** True for the shared judge-mode users. */
export function isDemoPersonaEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  return Object.values(DEMO_PERSONAS).some((persona) => persona.email === normalized);
}

/** The seeded demo site, seen by a persona: its secret cannot be rotated. */
export function isLockedDemoSite(
  viewerEmail: string | null | undefined,
  siteName: string,
): boolean {
  return isDemoPersonaEmail(viewerEmail) && siteName === DEMO_SITE_NAME;
}

/** A seeded demo agent key, seen by a persona: it cannot be revoked. */
export function isLockedDemoKey(viewerEmail: string | null | undefined, keyName: string): boolean {
  return isDemoPersonaEmail(viewerEmail) && DEMO_AGENT_KEY_NAMES.includes(keyName);
}
