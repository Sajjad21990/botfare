import { getDb } from "../../../../../lib/server/db";
import { applyAdvisorChange, applyRequestSchema } from "../../../../../lib/server/fare-advisor";
import { jsonError, readJson } from "../../../../../lib/server/http";
import { NO_STORE } from "../../../../../lib/server/publisher";
import { requireApiUser } from "../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Applies a Fare Advisor recommendation the publisher confirmed:
 * `{ siteId, pattern, method?, priceCents?, audience? }` → `{ site, before, after, changed }`.
 * Only the site's owner may; the site's config version changes so the middleware picks it up.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const body = await readJson(request, applyRequestSchema);
  if (!body.ok) return body.response;
  try {
    const result = await applyAdvisorChange(getDb(), auth.user, body.data);
    if (!result.ok) return jsonError(result.status, result.error, result.message);
    return Response.json(result.body, { headers: NO_STORE });
  } catch (err) {
    console.error("[advisor] apply:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}
