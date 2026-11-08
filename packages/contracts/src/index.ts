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
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

/** `<prefix>_<16 lowercase hex chars>`, e.g. `site_8f2a91c04d7be311`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
  return `Basic ${Buffer.from(`${siteId}:${siteSecret}`).toString("base64")}`;
}

export function parseSiteAuthHeader(
  header: string | null | undefined,
): { siteId: string; siteSecret: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header?.trim() ?? "");
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
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
  chargeKnownBots: z.boolean().default(false),
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
  return AGENT_KEY_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeAgentKey(key: string): AgentKeyPayload {
  if (!key.startsWith(AGENT_KEY_PREFIX)) throw new Error("Agent key must start with bfk_");
  const json = Buffer.from(key.slice(AGENT_KEY_PREFIX.length), "base64url").toString("utf8");
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
