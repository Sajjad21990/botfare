import { listPayouts, OPEN_PAYOUT_STATUSES, syncPayoutBatch } from "@botfare/core";
import { getDb } from "../../../../../lib/server/db";
import { currentPayPal } from "../../../../../lib/server/paypal-test-hooks";
import { NO_STORE, toPayoutView } from "../../../../../lib/server/publisher";
import { requireApiUser } from "../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPEN = new Set<string>(OPEN_PAYOUT_STATUSES);

/**
 * "Refresh status": pulls the latest PayPal status for the signed-in publisher's open payouts
 * (one call per batch) and resubmits any batch PayPal never confirmed.
 */
export async function POST(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const db = getDb();
  const own = await listPayouts(db, auth.user.id, { limit: 500 });
  const batchKeys = [...new Set(own.filter((p) => OPEN.has(p.status)).map((p) => p.batchKey))];
  const errors: { batchKey: string; error: string }[] = [];
  if (batchKeys.length > 0) {
    const paypal = currentPayPal();
    for (const batchKey of batchKeys) {
      try {
        await syncPayoutBatch(db, paypal, batchKey);
      } catch (err) {
        console.warn(`[payouts] sync ${batchKey} failed: ${(err as Error).message}`);
        errors.push({ batchKey, error: "PayPal did not answer; try again shortly" });
      }
    }
  }
  const payouts = await listPayouts(db, auth.user.id, { limit: 50 });
  return Response.json(
    { synced: batchKeys.length, errors, payouts: payouts.map(toPayoutView) },
    { headers: NO_STORE },
  );
}
