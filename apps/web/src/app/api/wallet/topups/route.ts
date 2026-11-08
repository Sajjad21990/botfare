import { startTopUp } from "@botfare/core";
import { z } from "zod";
import { getDb } from "../../../../lib/server/db";
import { readJson } from "../../../../lib/server/http";
import { currentPayPal } from "../../../../lib/server/paypal-test-hooks";
import { requireApiUser } from "../../../../lib/server/session";
import { walletErrorResponse } from "../../../../lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  amountCents: z.union([z.literal(500), z.literal(1000), z.literal(2000)], {
    error: "amountCents must be 500, 1000 or 2000",
  }),
});

/**
 * Starts a wallet top-up: creates a PayPal order for the signed-in user and returns its ID for
 * the JS SDK's payment session. The amount is one of three fixed choices; the owner is the session.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const body = await readJson(request, bodySchema);
  if (!body.ok) return body.response;

  const base = process.env.BOTFARE_URL || new URL(request.url).origin;
  try {
    const { orderId } = await startTopUp(getDb(), currentPayPal(), {
      ownerUserId: auth.user.id,
      amountCents: body.data.amountCents,
      returnUrl: `${base}/wallet?topup=return`,
      cancelUrl: `${base}/wallet?topup=cancel`,
    });
    return Response.json({ orderId }, { status: 201 });
  } catch (err) {
    return walletErrorResponse(err, "start top-up");
  }
}
