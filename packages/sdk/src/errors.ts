import type { Offer } from "./offer";

/** The agent key string could not be decoded. The message never contains key material. */
export class BotFareAgentKeyError extends Error {
  override readonly name = "BotFareAgentKeyError";
}

/** A 402 that is not a BotFare (x402 V2, `prepaid` on `paypal:sandbox`) offer. */
export class BotFareOfferError extends Error {
  override readonly name = "BotFareOfferError";
}

/**
 * The price is above the agent's `maxPerRequestUsd`. Thrown by `agent.fetch` before anything is
 * signed, so no payment left the agent and no money moved.
 */
export class BotFareSpendLimitError extends Error {
  override readonly name = "BotFareSpendLimitError";
  readonly offer: Offer;
  readonly maxPerRequestCents: number;

  constructor(offer: Offer, maxPerRequestCents: number) {
    super(
      `${offer.url} costs ${offer.priceUsd}, above this agent's per-request max of $${(maxPerRequestCents / 100).toFixed(2)}; nothing was signed or paid`,
    );
    this.offer = offer;
    this.maxPerRequestCents = maxPerRequestCents;
  }
}
