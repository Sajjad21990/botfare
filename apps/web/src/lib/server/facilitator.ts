import { PostgresPrepaidLedger } from "@botfare/core";
import { PAYPAL_SANDBOX, PrepaidPayPalFacilitator } from "@botfare/x402-paypal";
import { x402Facilitator } from "@x402/core/facilitator";
import { getDb } from "./db";

const globalForFacilitator = globalThis as typeof globalThis & {
  __botfareFacilitator?: x402Facilitator;
};

/**
 * The official x402 facilitator with BotFare's `prepaid` scheme registered for `paypal:sandbox`,
 * settling into the Postgres ledger.
 */
export function getFacilitator(): x402Facilitator {
  globalForFacilitator.__botfareFacilitator ??= new x402Facilitator().register(
    PAYPAL_SANDBOX,
    new PrepaidPayPalFacilitator({ ledger: new PostgresPrepaidLedger(getDb()) }),
  );
  return globalForFacilitator.__botfareFacilitator;
}

/** Drops the cached facilitator (tests that reopen the database). */
export function resetFacilitator(): void {
  globalForFacilitator.__botfareFacilitator = undefined;
}
