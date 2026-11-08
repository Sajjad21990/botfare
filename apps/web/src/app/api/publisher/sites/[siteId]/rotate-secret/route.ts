import { isLockedDemoSite } from "@botfare/contracts";
import { getSite, rotateSiteSecret } from "@botfare/core";
import { getDb } from "../../../../../../lib/server/db";
import { jsonError } from "../../../../../../lib/server/http";
import { judgeModeRefusal } from "../../../../../../lib/server/judge";
import { NO_STORE, toSiteView } from "../../../../../../lib/server/publisher";
import { requireApiUser } from "../../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a new site secret (shown once); the old one stops working at once. Owner only. Judges
 * cannot rotate the shared demo site's secret: the deployed demo publisher holds it.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { siteId } = await params;
  const db = getDb();
  const site = await getSite(db, siteId);
  if (!site || site.ownerUserId !== auth.user.id)
    return jsonError(404, "not_found", "Site not found");
  if (isLockedDemoSite(auth.user.email, site.name)) {
    return judgeModeRefusal("The live demo publisher runs with this site's secret.");
  }
  const rotated = await rotateSiteSecret(db, { siteId, ownerUserId: auth.user.id });
  if (!rotated) return jsonError(404, "not_found", "Site not found");
  return Response.json(
    { site: toSiteView(rotated.site, undefined, auth.user.email), siteSecret: rotated.siteSecret },
    { headers: NO_STORE },
  );
}
