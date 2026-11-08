import { handlePayPalWebhookEvent } from "@botfare/core";
import { getDb } from "../../../../lib/server/db";
import { jsonError } from "../../../../lib/server/http";
import { currentPayPal } from "../../../../lib/server/paypal-test-hooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PayPal webhooks (PAYMENT.CAPTURE.*, PAYMENT.PAYOUTS-ITEM.*, PAYMENT.PAYOUTSBATCH.*).
 * The signature is verified with PayPal before anything else; then core records the event once
 * (deduped by event ID) and applies it idempotently. PayPal redelivers on non-2xx, so we answer
 * 2xx for duplicates and ignored events, and non-2xx only when a retry can help.
 */
export async function POST(request: Request): Promise<Response> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) {
    console.error("[paypal-webhook] PAYPAL_WEBHOOK_ID is not set: webhooks are not configured");
    return jsonError(503, "webhooks_not_configured", "Webhooks are not configured");
  }

  const raw = await request.text();
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return jsonError(400, "invalid_json", "Body must be JSON");
  }

  const paypal = currentPayPal();
  let verified: boolean;
  try {
    verified = await paypal.verifyWebhookSignature({
      headers: request.headers,
      webhookId,
      event,
    });
  } catch (err) {
    // PayPal's verification API itself failed: let PayPal redeliver later.
    console.error(`[paypal-webhook] signature check failed to run: ${(err as Error).message}`);
    return jsonError(503, "verification_unavailable", "Could not verify the signature");
  }
  if (!verified) {
    console.warn("[paypal-webhook] rejected an event with an invalid signature");
    return jsonError(400, "invalid_signature", "Webhook signature did not verify");
  }

  const result = await handlePayPalWebhookEvent(getDb(), paypal, event);
  console.info(
    `[paypal-webhook] ${result.eventType ?? "?"} ${result.eventId ?? "?"} -> ${result.status}` +
      (result.error ? ` (${result.error})` : ""),
  );
  if (result.status === "failed" && result.retryable) {
    return jsonError(500, "processing_failed", "Event could not be processed; retry later");
  }
  return Response.json({ status: result.status, eventId: result.eventId ?? null });
}
