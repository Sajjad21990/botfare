import { z } from "zod";
import { clientIp } from "../../../../lib/server/ai-budget";
import { getDb } from "../../../../lib/server/db";
import { getAdvisor } from "../../../../lib/server/fare-advisor";
import { jsonError } from "../../../../lib/server/http";
import { NO_STORE } from "../../../../lib/server/publisher";
import { requireApiUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A fresh AI answer can take a while; the funnel alone returns at once. */
export const maxDuration = 90;

const flag = z
  .enum(["0", "1", "true", "false"])
  .optional()
  .transform((value) => value === "1" || value === "true");

const querySchema = z.object({
  siteId: z.string().min(1).max(100),
  days: z.coerce.number().int().min(1).max(90).optional(),
  ai: flag,
  refresh: flag,
});

/**
 * Fare Advisor for one of the signed-in publisher's sites:
 * `{ recommendations, inputsSummary, generatedAt, aiAvailable, aiStatus, aiMessage, dropped }`.
 * `?ai=1` generates recommendations when none are cached (about ten seconds); without it only
 * cached ones come back (`aiStatus: "pending"` otherwise). `?refresh=1` asks for fresh ones.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return jsonError(400, "invalid_request", "Give a siteId; days must be 1 to 90");
  }
  try {
    const advisor = await getAdvisor(getDb(), {
      user: auth.user,
      siteId: query.data.siteId,
      days: query.data.days,
      ai: query.data.ai || query.data.refresh,
      refresh: query.data.refresh,
      visitorKey: `${auth.user.id}:${clientIp(request)}`,
    });
    if (!advisor) return jsonError(404, "not_found", "Site not found");
    return Response.json(advisor, { headers: NO_STORE });
  } catch (err) {
    console.error("[advisor] GET:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}
