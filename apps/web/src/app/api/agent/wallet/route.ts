import { listReceipts, walletBalanceMicros } from "@botfare/core";
import { authenticateAgent } from "../../../../lib/server/agent-auth";
import { getDb } from "../../../../lib/server/db";
import { jsonError } from "../../../../lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MICROS_PER_USD = 1_000_000;

/**
 * The calling agent key's budget, authenticated by the request's Web Bot Auth signature:
 * `{ keyId, keyName, balanceUsd, spentTodayUsd, dailyCapUsd, perRequestMaxUsd, allowedSiteIds }`.
 * `balanceUsd` is the owner's wallet (shared by all of the owner's keys); `spentTodayUsd` is this
 * key's settled spend in the current UTC day, the way the facilitator counts the daily cap.
 * Null limits mean "no limit"; null `allowedSiteIds` means any site.
 */
export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  const auth = await authenticateAgent(db, request);
  if (!auth.ok) return auth.response;
  const { key } = auth;
  try {
    const now = new Date();
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const [balanceMicros, recent] = await Promise.all([
      walletBalanceMicros(db, key.ownerUserId),
      listReceipts(db, { agentKeyId: key.id, limit: 500 }),
    ]);
    const spentTodayMicros = recent
      .filter((r) => r.status === "settled" && r.createdAt.getTime() >= dayStart)
      .reduce((sum, r) => sum + r.amountMicros, 0);
    return Response.json(
      {
        keyId: key.id,
        keyName: key.name,
        balanceUsd: balanceMicros / MICROS_PER_USD,
        spentTodayUsd: spentTodayMicros / MICROS_PER_USD,
        dailyCapUsd: key.dailyCapCents === null ? null : key.dailyCapCents / 100,
        perRequestMaxUsd: key.perRequestMaxCents === null ? null : key.perRequestMaxCents / 100,
        allowedSiteIds: key.allowedSiteIds,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[agent-api] wallet:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}
