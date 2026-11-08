import { toSiteConfig } from "@botfare/core";
import { authenticateSiteRequest, unauthorized } from "../../../../../lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Site config for the publisher middleware. The site may read only its own config. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const { siteId } = await params;
  const site = await authenticateSiteRequest(request);
  if (!site || site.id !== siteId) return unauthorized();
  return Response.json(toSiteConfig(site));
}
