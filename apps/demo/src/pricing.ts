/**
 * Saffron & Salt's prices, one per section. The seed script registers exactly these rules and free paths with BotFare,
 * and the catalog reads prices from here, so the site and the dashboard never disagree. They live
 * in @botfare/contracts so the app can restore them when a judge signs in.
 */
import {
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  findPricingRule,
  type PricingRule,
  type SiteConfig,
} from "@botfare/contracts";

export const SITE_NAME = DEMO_SITE_NAME;
export const SITE_TAGLINE = "Home cooking for weeknights, from a cook who freezes everything.";

/** First match wins; each rule is a section prefix (`/recipes/*` and so on) or the nutrition API. */
export const pricing: PricingRule[] = DEMO_SITE_PRICING;

/** Always free, even for agents. */
export const freePaths: string[] = DEMO_SITE_FREE_PATHS;

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
