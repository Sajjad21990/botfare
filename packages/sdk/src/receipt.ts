import { decodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";

/** Decodes the PAYMENT-RESPONSE (settlement receipt) of a paid response; null when absent. */
export function readReceipt(response: Response): SettleResponse | null {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}
