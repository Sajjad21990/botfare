import {
  AGENT_HEADER,
  findPricingRule,
  isKnownAiBot,
  type PricingRule,
  type SiteConfig,
} from "@botfare/contracts";
import type { Request } from "express";

/**
 * True when the request comes from an agent: it says so (`x-botfare-agent`), it carries an x402
 * payment, or the site charges known AI crawlers and the user agent is one of them.
 */
export function isAgentRequest(
  req: Pick<Request, "get">,
  config: Pick<SiteConfig, "chargeKnownBots">,
): boolean {
  if (req.get(AGENT_HEADER) !== undefined) return true;
  if (req.get("payment-signature")) return true;
  return config.chargeKnownBots && isKnownAiBot(req.get("user-agent"));
}

/**
 * Express routes case-insensitively and ignores a trailing slash by default, so
 * `/API/Brew-Ratio/` reaches the same handler as `/api/brew-ratio`. Matching on a normalized
 * path (decoded, lower case, single slashes, no trailing slash) keeps those spellings from
 * slipping past a price.
 */
export function normalizePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // keep the raw path if it is not valid percent-encoding
  }
  const collapsed = decoded.replace(/\/{2,}/g, "/").toLowerCase();
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

function normalizePattern(pattern: string): string {
  return pattern.endsWith("*") ? pattern.toLowerCase() : normalizePath(pattern);
}

/** The config with its patterns normalized the same way as request paths. */
export function normalizeConfig(config: SiteConfig): SiteConfig {
  return {
    ...config,
    pricing: config.pricing.map((rule) => ({ ...rule, pattern: normalizePattern(rule.pattern) })),
    freePaths: config.freePaths.map(normalizePattern),
  };
}

/** The pricing rule for this request, if any. `config` must come from `normalizeConfig`. */
export function ruleFor(req: Request, config: SiteConfig): PricingRule | undefined {
  return findPricingRule(config, req.method, normalizePath(req.baseUrl + req.path));
}
