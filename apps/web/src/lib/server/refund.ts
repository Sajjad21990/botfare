import { refundReceipt } from "@botfare/core";
import { z } from "zod";
import { authenticateSiteRequest, unauthorized } from "./auth";
import { getDb } from "./db";
import { jsonError, readJson } from "./http";

const refundRequestSchema = z.object({
  /** The receipt ID returned as the x402 `transaction` by settle. */
  transaction: z.string().min(1).max(100),
});

/**
 * POST /api/x402/refund: a publisher refunds one of its own receipts (a BotFare extension, not
 * part of the x402 handshake). Repeat calls return the first refund with `alreadyRefunded: true`.
 */
export async function handleRefund(request: Request): Promise<Response> {
  const site = await authenticateSiteRequest(request);
  if (!site) return unauthorized();
  const body = await readJson(request, refundRequestSchema);
  if (!body.ok) return body.response;

  const result = await refundReceipt(getDb(), {
    receiptId: body.data.transaction,
    siteId: site.id,
  });
  if (!result.ok) {
    return result.reason === "not_found"
      ? jsonError(404, "not_found", `No receipt ${body.data.transaction} for site ${site.id}`)
      : jsonError(409, result.reason, result.message);
  }
  console.info(`[x402] refund ${site.id} ${result.receipt.id} already=${result.alreadyRefunded}`);
  return Response.json({
    ok: true,
    transaction: result.receipt.id,
    status: result.receipt.status,
    amountCents: result.receipt.amountCents,
    refundTransaction: result.refundTransactionId,
    alreadyRefunded: result.alreadyRefunded,
  });
}
