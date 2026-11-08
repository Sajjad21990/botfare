/**
 * BotFare agent SDK: pay BotFare-enabled sites over x402 from a PayPal-funded balance.
 * Built on the official @x402/fetch with BotFare's `prepaid` scheme on `paypal:sandbox`.
 */
export {
  type BotFareAgent,
  type BotFareAgentOptions,
  createBotFareAgent,
  DEFAULT_MAX_PER_REQUEST_USD,
  type PaidResult,
} from "./agent";
export { BotFareAgentKeyError, BotFareOfferError, BotFareSpendLimitError } from "./errors";
export { type Offer, parseOffer } from "./offer";
export { readReceipt } from "./receipt";
export type { WireEvent, WireListener } from "./wire";
