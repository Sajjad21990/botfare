import "server-only";
import { createPayPalClient, type PayPalClient } from "@botfare/paypal";

/** One PayPal sandbox client per process (it caches its OAuth token), kept across dev reloads. */
const globalForPayPal = globalThis as typeof globalThis & { __botfarePayPal?: PayPalClient };

export function getPayPal(): PayPalClient {
  if (!globalForPayPal.__botfarePayPal) {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)");
    }
    globalForPayPal.__botfarePayPal = createPayPalClient({
      clientId,
      clientSecret,
      logger: (e) =>
        console.info(
          `[paypal] ${e.method} ${e.path} -> ${e.status} (${e.ms} ms, debug ${e.debugId ?? "-"})`,
        ),
    });
  }
  return globalForPayPal.__botfarePayPal;
}

/** The sandbox client ID is public (the JS SDK needs it in the browser); the secret never leaves the server. */
export function paypalClientId(): string | null {
  return process.env.PAYPAL_CLIENT_ID ?? null;
}
