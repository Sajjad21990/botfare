import "server-only";
import type { PayPalClient } from "@botfare/paypal";
import { getPayPal } from "./paypal";

/**
 * The PayPal client route handlers should use. Tests swap in a mock with `setPayPalForTests`, so
 * money routes can be exercised without the sandbox; in the app it is always `getPayPal()`.
 */
const globalForHooks = globalThis as typeof globalThis & { __botfarePayPalOverride?: PayPalClient };

export function currentPayPal(): PayPalClient {
  return globalForHooks.__botfarePayPalOverride ?? getPayPal();
}

/** Tests only: use `client` instead of the sandbox client; `null` restores the real one. */
export function setPayPalForTests(client: Partial<PayPalClient> | null): void {
  globalForHooks.__botfarePayPalOverride = (client as PayPalClient | null) ?? undefined;
}

/** True when the server has both PayPal credentials (or a test client is installed). */
export function paypalConfigured(): boolean {
  return Boolean(
    globalForHooks.__botfarePayPalOverride ||
      (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
  );
}
