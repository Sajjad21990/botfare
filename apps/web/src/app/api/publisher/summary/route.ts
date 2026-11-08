import { getDb } from "../../../../lib/server/db";
import { getPublisherDashboard, NO_STORE } from "../../../../lib/server/publisher";
import { requireApiUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in publisher's earnings, payouts and sites (with pricing). */
export async function GET(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const dashboard = await getPublisherDashboard(getDb(), auth.user.id);
  return Response.json(dashboard, { headers: NO_STORE });
}
