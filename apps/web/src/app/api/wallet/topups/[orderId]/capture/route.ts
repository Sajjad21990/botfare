import { completeTopUp } from "@botfare/core";
import type { CaptureResponse } from "../../../../../../components/wallet/types";
import { getDb } from "../../../../../../lib/server/db";
import { jsonError } from "../../../../../../lib/server/http";
import { currentPayPal } from "../../../../../../lib/server/paypal-test-hooks";
import { requireApiUser } from "../../../../../../lib/server/session";
import { walletErrorResponse } from "../../../../../../lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PayPal order IDs are short uppercase alphanumerics (e.g. 5O190127TN364715T). */
const ORDER_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Captures an approved top-up and credits the wallet. Only the user who started the top-up may
 * capture it (anyone else gets 404). Safe to repeat: the capture and the credit are idempotent.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { orderId } = await params;
  if (!ORDER_ID.test(orderId)) return jsonError(404, "not_found", "Top-up not found");

  try {
    const result = await completeTopUp(getDb(), currentPayPal(), {
      ownerUserId: auth.user.id,
      orderId,
    });
    const body: CaptureResponse = {
      status: result.status,
      walletMicros: result.walletMicros,
      captureId: result.captureId,
      grossCents: result.grossCents,
      feeCents: result.feeCents,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return walletErrorResponse(err, `capture ${orderId}`);
  }
}
