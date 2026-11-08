// The Crema Notes site that `pnpm seed` registers, locally or in a deployed database.
import { CREMA_NOTES_DETECTION, detectionConfigSchema } from "@botfare/contracts";
import {
  authenticateSite,
  createSite,
  type Db,
  listSites,
  rotateSiteSecret,
  siteDetection,
  updateSiteDetection,
  updateSitePricing,
  updateSiteProfile,
} from "@botfare/core";
import { freePaths, pricing, SITE_NAME } from "../../apps/demo/src/pricing";

export const DEFAULT_DEMO_ORIGIN = "http://localhost:4000";

/** The demo's public origin: DEMO_ORIGIN (the deployed botfare-demo URL) or the local default. */
export function demoSiteOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEMO_ORIGIN?.trim() || DEFAULT_DEMO_ORIGIN;
}

export interface EnsureDemoSiteInput {
  publisherId: string;
  origin: string;
  payoutEmail: string | null;
  /** BOTFARE_SITE_ID and BOTFARE_SITE_SECRET as the running demo knows them, if any. */
  current?: { siteId?: string; siteSecret?: string };
  /** Issue a new secret even when `current` still works. */
  rotate?: boolean;
}

export interface DemoSite {
  siteId: string;
  siteSecret: string;
  action: "created" | "kept" | "rotated";
}

/**
 * Creates the site, or brings an existing one up to apps/demo's pricing, free paths, origin and bot
 * detection (CREMA_NOTES_DETECTION: standard level with Cloudflare's Turnstile test site key).
 * The current secret is kept when it still authenticates, so running the seed again does not break
 * a demo (local or on Render) that already holds it; otherwise a new secret is issued.
 */
export async function ensureDemoSite(db: Db, input: EnsureDemoSiteInput): Promise<DemoSite> {
  const existing = (await listSites(db, input.publisherId)).find((s) => s.name === SITE_NAME);
  if (!existing) {
    const created = await createSite(db, {
      ownerUserId: input.publisherId,
      name: SITE_NAME,
      origin: input.origin,
      pricing,
      freePaths,
      payoutEmail: input.payoutEmail,
      detection: CREMA_NOTES_DETECTION,
    });
    return { siteId: created.site.id, siteSecret: created.siteSecret, action: "created" };
  }

  await updateSitePricing(db, { siteId: existing.id, pricing, freePaths });
  await updateSiteProfile(db, {
    siteId: existing.id,
    origin: input.origin,
    payoutEmail: input.payoutEmail,
  });
  // Written only when it differs, so a running demo's cached config stays valid.
  const detection = detectionConfigSchema.parse(CREMA_NOTES_DETECTION);
  if (JSON.stringify(siteDetection(existing)) !== JSON.stringify(detection)) {
    await updateSiteDetection(db, { siteId: existing.id, detection });
  }

  const { siteId, siteSecret } = input.current ?? {};
  if (
    !input.rotate &&
    siteId === existing.id &&
    siteSecret &&
    (await authenticateSite(db, existing.id, siteSecret))
  ) {
    return { siteId: existing.id, siteSecret, action: "kept" };
  }
  const rotated = await rotateSiteSecret(db, { siteId: existing.id });
  if (!rotated) throw new Error(`Site ${existing.id} vanished`);
  return { siteId: rotated.site.id, siteSecret: rotated.siteSecret, action: "rotated" };
}
