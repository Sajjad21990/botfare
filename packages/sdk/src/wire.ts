import type { AuthorizationClaims } from "@botfare/x402-paypal";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { decodeJwt } from "jose";
import { readPaymentRequired } from "./offer";
import { readReceipt } from "./receipt";

/** One step of the x402 handshake as it crossed the wire, for the wire inspector. */
export type WireEvent =
  | { stage: "payment-required"; url: string; header: string; decoded: PaymentRequired }
  | {
      stage: "payment-signature";
      url: string;
      header: string;
      decoded: PaymentPayload;
      authorizationClaims: AuthorizationClaims;
    }
  | { stage: "payment-response"; url: string; header: string; decoded: SettleResponse };

export type WireListener = (event: WireEvent) => void;

/** Reports a listener's errors to the console instead of breaking the payment. */
export function safeEmit(listener: WireListener | undefined, event: WireEvent) {
  if (!listener) return;
  try {
    listener(event);
  } catch (err) {
    console.error("[botfare] onWire listener threw:", err);
  }
}

export function emitPaymentRequired(
  listener: WireListener | undefined,
  url: string,
  response: Response,
) {
  const header = response.headers.get("PAYMENT-REQUIRED");
  const decoded = readPaymentRequired(response);
  if (header && decoded) {
    safeEmit(listener, { stage: "payment-required", url, header, decoded });
  }
}

export function emitPaymentSignature(listener: WireListener | undefined, request: Request) {
  const header = request.headers.get("PAYMENT-SIGNATURE");
  if (!header || !listener) return;
  try {
    const decoded = decodePaymentSignatureHeader(header);
    const authorization = (decoded.payload as { authorization?: unknown }).authorization;
    if (typeof authorization !== "string") return;
    // Our own client signed this a moment ago; decode (not verify) it for display.
    const authorizationClaims = decodeJwt(authorization) as unknown as AuthorizationClaims;
    safeEmit(listener, {
      stage: "payment-signature",
      url: request.url,
      header,
      decoded,
      authorizationClaims,
    });
  } catch {
    // Not decodable: nothing to show.
  }
}

export function emitPaymentResponse(
  listener: WireListener | undefined,
  url: string,
  response: Response,
) {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  const decoded = readReceipt(response);
  if (header && decoded) {
    safeEmit(listener, { stage: "payment-response", url, header, decoded });
  }
}
