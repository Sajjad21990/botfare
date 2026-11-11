import { listPayouts, requestPayout } from "@botfare/core";
import { getDb } from "../../../../lib/server/db";
import { jsonError } from "../../../../lib/server/http";
import { currentPayPal, paypalConfigured } from "../../../../lib/server/paypal-test-hooks";
import {
  MINIMUM_PAYOUT_CENTS,
  moneyErrorResponse,
  NO_STORE,
  toPayoutView,
} from "../../../../lib/server/publisher";
import { requireApiUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in publisher's payouts, newest first. */
export async function GET(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const payouts = await listPayouts(getDb(), auth.user.id, { limit: 50 });
  return Response.json({ payouts: payouts.map(toPayoutView) }, { headers: NO_STORE });
}

/**
 * "Withdraw now": pays the publisher's whole-cent earnings to their payout email through PayPal
 * Payouts. The amount comes from the ledger, never from the browser. The payout may come back
 * already failed (PayPal refused it; the money is back in earnings) or pending with an error
 * (PayPal did not answer; "Refresh status" retries the same batch). 503 without PayPal credentials.
 */
export async function POST(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  if (!paypalConfigured()) {
    return jsonError(503, "paypal_not_configured", "PayPal is not configured on this server");
  }
  try {
    const payout = await requestPayout(getDb(), currentPayPal(), {
      publisherUserId: auth.user.id,
      minimumCents: MINIMUM_PAYOUT_CENTS,
    });
    return Response.json({ payout: toPayoutView(payout) }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return moneyErrorResponse(err);
  }
}
