// The demo publisher's site (Saffron & Salt) that `pnpm seed` registers, locally or in a deployed
// database, and the move of a database seeded before the rename (Crema Notes) onto it.
import {
  CREMA_NOTES_DETECTION,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  detectionConfigSchema,
} from "@botfare/contracts";
import {
  authenticateSite,
  createSite,
  type Db,
  findDemoSites,
  listSites,
  rotateSiteSecret,
  type Site,
  siteDetection,
  updateSiteDetection,
  updateSitePricing,
  updateSiteProfile,
} from "@botfare/core";

export const DEFAULT_DEMO_ORIGIN = "http://localhost:4000";

/**
 * The demo's public origin: DEMO_ORIGIN (the deployed botfare-demo URL), else the origin of
 * DEMO_PUBLIC_URL (what botfare-web's Shell on Render has), else the local default. Without the
 * second step, rerunning the seed on Render would move the demo site back to localhost.
 */
export function demoSiteOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DEMO_ORIGIN?.trim();
  if (explicit) return explicit;
  const publicUrl = env.DEMO_PUBLIC_URL?.trim();
  if (publicUrl) {
    try {
      const { origin } = new URL(publicUrl);
      if (origin !== "null") return origin;
    } catch {
      // Not a URL: fall through to the local default.
    }
  }
  return DEFAULT_DEMO_ORIGIN;
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
  /** The site's name before this run, when it was renamed to DEMO_SITE_NAME. */
  renamedFrom?: string;
}

/**
 * The publisher's existing demo site: the one BOTFARE_SITE_ID names (only among this publisher's
 * own sites), else the one named DEMO_SITE_NAME, else one under a legacy name (Crema Notes).
 */
export function findExistingDemoSite(sites: Site[], currentSiteId?: string): Site | undefined {
  const byId = currentSiteId ? sites.find((site) => site.id === currentSiteId) : undefined;
  return byId ?? findDemoSites(sites)[0];
}

/**
 * Creates the site, or brings an existing one up to the demo's name, pricing, free paths, origin
 * and bot detection (CREMA_NOTES_DETECTION: standard level with Cloudflare's Turnstile test site
 * key). A site from before the rename keeps its ID and history and is renamed in place. The
 * current secret is kept when it still authenticates, so running the seed again does not break a
 * demo (local or on Render) that already holds it; otherwise a new secret is issued.
 */
export async function ensureDemoSite(db: Db, input: EnsureDemoSiteInput): Promise<DemoSite> {
  const existing = findExistingDemoSite(
    await listSites(db, input.publisherId),
    input.current?.siteId,
  );
  if (!existing) {
    const created = await createSite(db, {
      ownerUserId: input.publisherId,
      name: DEMO_SITE_NAME,
      origin: input.origin,
      pricing: DEMO_SITE_PRICING,
      freePaths: DEMO_SITE_FREE_PATHS,
      payoutEmail: input.payoutEmail,
      detection: CREMA_NOTES_DETECTION,
    });
    return { siteId: created.site.id, siteSecret: created.siteSecret, action: "created" };
  }

  const renamedFrom = existing.name !== DEMO_SITE_NAME ? existing.name : undefined;
  await updateSitePricing(db, {
    siteId: existing.id,
    pricing: DEMO_SITE_PRICING,
    freePaths: DEMO_SITE_FREE_PATHS,
  });
  await updateSiteProfile(db, {
    siteId: existing.id,
    name: DEMO_SITE_NAME,
    origin: input.origin,
    payoutEmail: input.payoutEmail,
  });
  // Written only when it differs, so a running demo's cached config stays valid.
  const detection = detectionConfigSchema.parse(CREMA_NOTES_DETECTION);
  if (JSON.stringify(siteDetection(existing)) !== JSON.stringify(detection)) {
    await updateSiteDetection(db, { siteId: existing.id, detection });
  }
  const renamed = renamedFrom ? { renamedFrom } : {};

  const { siteId, siteSecret } = input.current ?? {};
  if (
    !input.rotate &&
    siteId === existing.id &&
    siteSecret &&
    (await authenticateSite(db, existing.id, siteSecret))
  ) {
    return { siteId: existing.id, siteSecret, action: "kept", ...renamed };
  }
  const rotated = await rotateSiteSecret(db, { siteId: existing.id });
  if (!rotated) throw new Error(`Site ${existing.id} vanished`);
  return {
    siteId: rotated.site.id,
    siteSecret: rotated.siteSecret,
    action: "rotated",
    ...renamed,
  };
}
