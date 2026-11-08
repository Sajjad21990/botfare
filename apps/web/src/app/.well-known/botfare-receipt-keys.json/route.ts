import { handleReceiptKeys } from "../../../lib/server/receipt-statements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RECEIPT_KEYS_PATH: the JWKS of BotFare's receipt-signing public keys (Ed25519, alg EdDSA,
 * use sig, kid = RFC 7638 thumbprint). Verify statements offline with `verifyStatement` from
 * `@botfare/contracts/receipts`. Public; never contains private key material.
 */
export function GET(): Promise<Response> {
  return handleReceiptKeys();
}
