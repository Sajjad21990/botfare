import { listReceipts } from "@botfare/core";
import { z } from "zod";
import { authenticateAgent } from "../../../../lib/server/agent-auth";
import { getDb } from "../../../../lib/server/db";
import { jsonError } from "../../../../lib/server/http";
import { listSiteDirectory } from "../../../../lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limitSchema = z.coerce.number().int().min(1).max(100).default(10);

/**
 * The calling agent key's most recent receipts, newest first, authenticated by the request's
 * Web Bot Auth signature. `?limit=` is 1-100 (default 10). Each receipt:
 * `{ receiptId, time, site, siteId, url, amountUsd, status }`.
 */
export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  const auth = await authenticateAgent(db, request);
  if (!auth.ok) return auth.response;

  const raw = new URL(request.url).searchParams.get("limit");
  const limit = limitSchema.safeParse(raw === null || raw === "" ? undefined : raw);
  if (!limit.success) {
    return jsonError(400, "invalid_request", "limit must be a whole number from 1 to 100");
  }
  try {
    const [receipts, sites] = await Promise.all([
      listReceipts(db, { agentKeyId: auth.key.id, limit: limit.data }),
      listSiteDirectory(db),
    ]);
    const siteNames = new Map(sites.map((site) => [site.id, site.name]));
    return Response.json(
      {
        keyId: auth.key.id,
        receipts: receipts.map((receipt) => ({
          receiptId: receipt.id,
          time: receipt.createdAt.toISOString(),
          site: siteNames.get(receipt.siteId) ?? receipt.siteId,
          siteId: receipt.siteId,
          url: receipt.resourceUrl,
          amountUsd: receipt.amountMicros / 1_000_000,
          status: receipt.status,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[agent-api] receipts:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}
