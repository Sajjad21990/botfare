/**
 * Crema Notes' prices. The seed script registers exactly these rules and free paths with BotFare,
 * and the catalog reads prices from here, so the site and the dashboard never disagree.
 */
import { findPricingRule, type PricingRule, type SiteConfig } from "@botfare/contracts";

export const SITE_NAME = "Crema Notes";
export const SITE_TAGLINE = "Field notes on grinders, espresso and milk, from a home coffee bench.";

/** First match wins, so the specific article rules come before the `/articles/*` catch-all. */
export const pricing: PricingRule[] = [
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

/** Always free, even for agents. */
export const freePaths: string[] = ["/", "/catalog.json", "/health", "/static/*", "/favicon.ico"];

/** Everything the dashboard needs to register the demo site, apart from IDs and origin. */
export const siteSettings: Pick<SiteConfig, "name" | "pricing" | "freePaths" | "chargeKnownBots"> =
  {
    name: SITE_NAME,
    pricing,
    freePaths,
    chargeKnownBots: false,
  };

/** Price an agent pays for `METHOD path`, or 0 when it is free. */
export function priceCentsFor(method: string, path: string): number {
  return findPricingRule({ pricing, freePaths }, method, path)?.priceCents ?? 0;
}
