import {
  decideAsPublisher,
  getPublisherDisputes,
  publisherDecisionSchema,
} from "../../../../lib/server/fare-court-api";
import { jsonError, readJson } from "../../../../lib/server/http";
import { requireApiUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Disputes on the signed-in publisher's sites, newest first, with the AI's reasoning, the declared
 * offer and the delivered excerpt; `pendingCount` is how many wait for them. `?siteId=` narrows.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const siteId = new URL(request.url).searchParams.get("siteId")?.trim() || undefined;
  try {
    const data = await getPublisherDisputes(auth.user.id, siteId ? { siteId } : {});
    return Response.json(data, { headers: NO_STORE });
  } catch (err) {
    console.error("[fare-court] publisher disputes:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}

/** `{ disputeId, decision: "accept" | "reject" }`: accept refunds the agent, reject closes it. */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const body = await readJson(request, publisherDecisionSchema);
  if (!body.ok) return body.response;
  return decideAsPublisher(auth.user.id, body.data);
}
