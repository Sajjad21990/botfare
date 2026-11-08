import { z } from "zod";
import {
  getPublisherAnalytics,
  MAX_RECEIPT_ROWS,
} from "../../../../../lib/server/analytics-receipts";
import { getDb } from "../../../../../lib/server/db";
import { jsonError } from "../../../../../lib/server/http";
import { requireApiUser } from "../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RECEIPT_ROWS).optional(),
});

/**
 * The signed-in publisher's receipts as analytics rows, plus their earnings balance.
 * `?limit=N` returns only the newest N rows (the dashboard polls with a small limit).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return jsonError(400, "invalid_request", "limit must be 1 to 5000");
  const body = await getPublisherAnalytics(getDb(), auth.user.id, { limit: query.data.limit });
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
