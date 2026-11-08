/**
 * BotFare agent SDK: pay BotFare-enabled sites over x402 from a PayPal-funded balance.
 * Built on the official @x402/fetch with BotFare's `prepaid` scheme on `paypal:sandbox`.
 */

export type {
  DeclineCategory,
  DisputeOutcome,
  DisputeReason,
  DisputeStatus,
  DisputeVerdict,
} from "@botfare/contracts/fare";
export type {
  AnswerManifest,
  AnswerSource,
  BotFareStatement,
  DeliveryStatement,
  PaymentStatement,
  ReceiptStatements,
  RefundStatement,
  StatementKind,
} from "@botfare/contracts/receipts";
export {
  createDirectoryKeyResolver,
  createRequestSigner,
  jwkThumbprint,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  signRequest,
  type VerifySignedRequestResult,
  verifySignedRequest,
  type WebBotAuthHeaders,
} from "@botfare/contracts/web-bot-auth";
export {
  type BotFareAgent,
  type BotFareAgentOptions,
  createBotFareAgent,
  DEFAULT_MAX_PER_REQUEST_USD,
  type PaidResult,
} from "./agent";
export {
  BotFareAgentKeyError,
  BotFareApiError,
  BotFareOfferError,
  BotFareSpendLimitError,
} from "./errors";
export {
  type CitationReportInput,
  type DeclineInput,
  type DisputeInput,
  disputeOutcomeSchema,
} from "./fare";
export { type Offer, parseOffer } from "./offer";
export { readReceipt } from "./receipt";
export {
  createReceiptVerifier,
  type ReceiptVerification,
  type ReceiptVerifier,
  type ReceiptVerifierOptions,
  readReceiptStatement,
  type VerifyReceiptOptions,
  verifyReceipt,
} from "./receipts";
export type { WireEvent, WireListener } from "./wire";
