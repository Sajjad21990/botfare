import { pricingRuleSchema } from "@botfare/contracts";
import { updateSitePricing } from "@botfare/core";
import { z } from "zod";
import { getDb } from "../../../../../../lib/server/db";
import { jsonError, readJson } from "../../../../../../lib/server/http";
import { moneyErrorResponse, NO_STORE, toSiteView } from "../../../../../../lib/server/publisher";
import { requireApiUser } from "../../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `/exact/path` or a prefix ending in `*`; no spaces, `*` only at the end. */
const patternSchema = z
  .string()
  .trim()
  .startsWith("/", "Paths start with /")
  .max(300)
  .refine((pattern) => !/\s/.test(pattern), "Paths cannot contain spaces")
  .refine(
    (pattern) => !pattern.slice(0, -1).includes("*"),
    "Use * only at the end, e.g. /articles/*",
  );

const ruleSchema = pricingRuleSchema.extend({
  pattern: patternSchema,
  method: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(METHODS, "Method must be GET, POST, PUT, PATCH or DELETE"))
    .default("GET"),
  description: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((text) => text || undefined),
});

const pricingBodySchema = z.object({
  pricing: z.array(ruleSchema).max(100, "At most 100 rules"),
  freePaths: z.array(patternSchema).max(100, "At most 100 free paths").default([]),
  chargeKnownBots: z.boolean(),
});

/** Saves a site's prices, free paths and known-bot charging. Only the site's owner may. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { siteId } = await params;
  const body = await readJson(request, pricingBodySchema);
  if (!body.ok) return body.response;
  try {
    const site = await updateSitePricing(getDb(), {
      siteId,
      ownerUserId: auth.user.id,
      pricing: body.data.pricing,
      freePaths: body.data.freePaths,
      chargeKnownBots: body.data.chargeKnownBots,
    });
    if (!site) return jsonError(404, "not_found", "Site not found");
    return Response.json(
      { site: toSiteView(site, undefined, auth.user.email) },
      { headers: NO_STORE },
    );
  } catch (err) {
    return moneyErrorResponse(err);
  }
}
