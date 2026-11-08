import { detectionConfigSchema } from "@botfare/contracts";
import { getSite, revenueBySignal, siteDetection, updateSiteDetection } from "@botfare/core";
import { z } from "zod";
import type { DetectionResponse } from "../../../../../../components/publisher/types";
import { getDb } from "../../../../../../lib/server/db";
import { jsonError, readJson } from "../../../../../../lib/server/http";
import { moneyErrorResponse, NO_STORE, toSiteView } from "../../../../../../lib/server/publisher";
import { requireApiUser } from "../../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A request header name as the CDN forwards it, e.g. `cf-bot-score`. */
const headerName = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter a header name")
  .max(100)
  .regex(/^[a-z0-9-]+$/, "Header names use letters, digits and dashes only");

const detectionBodySchema = detectionConfigSchema.extend({
  edge: z
    .object({
      cloudflare: detectionConfigSchema.shape.edge
        .unwrap()
        .shape.cloudflare.unwrap()
        .extend({
          scoreHeader: headerName.default("cf-bot-score"),
          verifiedBotHeader: headerName.default("cf-verified-bot"),
        }),
      akamai: detectionConfigSchema.shape.edge
        .unwrap()
        .shape.akamai.unwrap()
        .extend({
          header: headerName.default("akamai-bot"),
        }),
    })
    .partial()
    .optional(),
  /** An empty key turns the human check off. */
  turnstileSiteKey: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9_-]*$/, "Turnstile site keys use letters, digits, - and _ only")
    .nullable()
    .default(null)
    .transform((key) => key || null),
});

/**
 * The site's detection settings and the revenue each detection signal brought in (settled
 * receipts, after BotFare's fee), for the "Bot detection" panel. Only the site's owner may read it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { siteId } = await params;
  const db = getDb();
  const site = await getSite(db, siteId);
  if (!site || site.ownerUserId !== auth.user.id) {
    return jsonError(404, "not_found", "Site not found");
  }
  const body: DetectionResponse = {
    detection: siteDetection(site),
    revenueBySignal: await revenueBySignal(db, auth.user.id, { siteId }),
  };
  return Response.json(body, { headers: NO_STORE });
}

/**
 * Saves a site's agent detection settings: strictness, edge bot-score headers and the Turnstile
 * human check. Only the site's owner may. In judge mode the shared publisher persona may change
 * them too; the next persona sign-in restores Crema Notes' seeded settings.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { siteId } = await params;
  const body = await readJson(request, detectionBodySchema);
  if (!body.ok) return body.response;
  try {
    const site = await updateSiteDetection(getDb(), {
      siteId,
      ownerUserId: auth.user.id,
      detection: body.data,
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
