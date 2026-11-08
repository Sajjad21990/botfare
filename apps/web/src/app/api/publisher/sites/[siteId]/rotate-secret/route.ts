import { rotateSiteSecret } from "@botfare/core";
import { getDb } from "../../../../../../lib/server/db";
import { jsonError } from "../../../../../../lib/server/http";
import { NO_STORE, toSiteView } from "../../../../../../lib/server/publisher";
import { requireApiUser } from "../../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Issues a new site secret (shown once); the old one stops working at once. Owner only. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { siteId } = await params;
  const rotated = await rotateSiteSecret(getDb(), { siteId, ownerUserId: auth.user.id });
  if (!rotated) return jsonError(404, "not_found", "Site not found");
  return Response.json(
    { site: toSiteView(rotated.site), siteSecret: rotated.siteSecret },
    { headers: NO_STORE },
  );
}
