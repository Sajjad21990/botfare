import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  IdPrefix,
  newId,
  type PricingRule,
  pricingRuleSchema,
  type SiteConfig,
  siteConfigSchema,
} from "@botfare/contracts";
import { PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../db";
import { type Site, sites } from "../schema";

/** Pricing rules as the dashboard sends them; defaults (method, audience) are filled in. */
export type PricingRuleInput = z.input<typeof pricingRuleSchema>;

const pricingSchema = z.array(pricingRuleSchema).max(100);
const freePathsSchema = z.array(z.string().startsWith("/")).max(100);
const originSchema = z.url().transform((url) => new URL(url).origin);

export function hashSiteSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newSiteSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** New on every save of the site config. */
function newVersion(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export interface CreateSiteInput {
  ownerUserId: string;
  name: string;
  origin: string;
  pricing: PricingRuleInput[];
  freePaths?: string[];
  chargeKnownBots?: boolean;
  payoutEmail?: string | null;
}

/** Creates a site. `siteSecret` is returned once; only its hash is stored. */
export async function createSite(
  db: DbOrTx,
  input: CreateSiteInput,
): Promise<{ site: Site; siteSecret: string }> {
  const siteSecret = newSiteSecret();
  const [site] = await db
    .insert(sites)
    .values({
      id: newId(IdPrefix.site),
      ownerUserId: input.ownerUserId,
      name: z.string().trim().min(1).max(200).parse(input.name),
      origin: originSchema.parse(input.origin),
      secretHash: hashSiteSecret(siteSecret),
      pricing: pricingSchema.parse(input.pricing),
      freePaths: freePathsSchema.parse(input.freePaths ?? []),
      chargeKnownBots: input.chargeKnownBots ?? false,
      payoutEmail: input.payoutEmail ? z.email().parse(input.payoutEmail) : null,
      version: newVersion(),
    })
    .returning();
  if (!site) throw new Error("Failed to create site");
  return { site, siteSecret };
}

export async function getSite(db: DbOrTx, siteId: string): Promise<Site | null> {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  return site ?? null;
}

export function listSites(db: DbOrTx, ownerUserId: string): Promise<Site[]> {
  return db
    .select()
    .from(sites)
    .where(eq(sites.ownerUserId, ownerUserId))
    .orderBy(desc(sites.createdAt));
}

/** The site if `secret` is its current secret, else null. Constant-time comparison. */
export async function authenticateSite(
  db: DbOrTx,
  siteId: string,
  secret: string,
): Promise<Site | null> {
  const site = await getSite(db, siteId);
  if (!site) return null;
  const expected = Buffer.from(site.secretHash, "hex");
  const actual = Buffer.from(hashSiteSecret(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? site : null;
}

export function toSiteConfig(site: Site): SiteConfig {
  return siteConfigSchema.parse({
    siteId: site.id,
    name: site.name,
    origin: site.origin,
    network: PAYPAL_SANDBOX,
    pricing: site.pricing,
    freePaths: site.freePaths,
    chargeKnownBots: site.chargeKnownBots,
    version: site.version,
  });
}

/** Config served to the publisher middleware. */
export async function getSiteConfig(db: DbOrTx, siteId: string): Promise<SiteConfig | null> {
  const site = await getSite(db, siteId);
  return site ? toSiteConfig(site) : null;
}

/** Saves new prices (and optionally free paths and bot charging); bumps the config version. */
export async function updateSitePricing(
  db: DbOrTx,
  input: {
    siteId: string;
    /** When given, only that user's site is updated. */
    ownerUserId?: string;
    pricing: PricingRuleInput[];
    freePaths?: string[];
    chargeKnownBots?: boolean;
  },
): Promise<Site | null> {
  const pricing: PricingRule[] = pricingSchema.parse(input.pricing);
  const [site] = await db
    .update(sites)
    .set({
      pricing,
      ...(input.freePaths ? { freePaths: freePathsSchema.parse(input.freePaths) } : {}),
      ...(input.chargeKnownBots !== undefined ? { chargeKnownBots: input.chargeKnownBots } : {}),
      version: newVersion(),
      updatedAt: new Date(),
    })
    .where(siteWhere(input.siteId, input.ownerUserId))
    .returning();
  return site ?? null;
}

/** Updates the site's name, origin or payout email; bumps the config version. */
export async function updateSiteProfile(
  db: DbOrTx,
  input: {
    siteId: string;
    ownerUserId?: string;
    name?: string;
    origin?: string;
    /** null clears it. */
    payoutEmail?: string | null;
  },
): Promise<Site | null> {
  const [site] = await db
    .update(sites)
    .set({
      ...(input.name !== undefined
        ? { name: z.string().trim().min(1).max(200).parse(input.name) }
        : {}),
      ...(input.origin !== undefined ? { origin: originSchema.parse(input.origin) } : {}),
      ...(input.payoutEmail !== undefined
        ? { payoutEmail: input.payoutEmail ? z.email().parse(input.payoutEmail) : null }
        : {}),
      version: newVersion(),
      updatedAt: new Date(),
    })
    .where(siteWhere(input.siteId, input.ownerUserId))
    .returning();
  return site ?? null;
}

/** Issues a new site secret; the old one stops working immediately. */
export async function rotateSiteSecret(
  db: DbOrTx,
  input: { siteId: string; ownerUserId?: string },
): Promise<{ site: Site; siteSecret: string } | null> {
  const siteSecret = newSiteSecret();
  const [site] = await db
    .update(sites)
    .set({ secretHash: hashSiteSecret(siteSecret), updatedAt: new Date() })
    .where(siteWhere(input.siteId, input.ownerUserId))
    .returning();
  return site ? { site, siteSecret } : null;
}

function siteWhere(siteId: string, ownerUserId?: string): SQL | undefined {
  return ownerUserId
    ? and(eq(sites.id, siteId), eq(sites.ownerUserId, ownerUserId))
    : eq(sites.id, siteId);
}
