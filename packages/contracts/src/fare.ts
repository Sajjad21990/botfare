/**
 * Contracts for Fare Court (AI arbitration of micro-disputes) and Fare Advisor (pricing from what
 * agents say and do). Shared by the middleware, the SDK, the MCP server, the web app and core.
 * Works in Node and the browser (WebCrypto, no Buffer).
 */
import { z } from "zod";
import { detectionSignalSchema, FACILITATOR_PATH, IdPrefix } from "./index";

// ---------------------------------------------------------------------------------------------
// Endpoints

/** Publisher → BotFare, site Basic auth: "this is the body I delivered for this receipt". */
export function receiptAttestationPath(receiptId: string): string {
  return `${FACILITATOR_PATH}/receipts/${encodeURIComponent(receiptId)}/attest`;
}

/** Publisher middleware → BotFare, site Basic auth: batched "offer shown" events (402s). */
export const OFFER_TELEMETRY_PATH = `${FACILITATOR_PATH}/telemetry`;

/** Agent → BotFare, signed with the agent key (Web Bot Auth): open a dispute on a receipt. */
export const DISPUTES_PATH = "/api/disputes";

/** Agent → BotFare, signed: an optional, free note saying why an offer was not bought. */
export const DECLINES_PATH = "/api/offers/decline";

/** Agent → BotFare, signed: which receipts an answer actually cited. */
export const CITATIONS_PATH = "/api/citations";

// ---------------------------------------------------------------------------------------------
// Proof of delivery (RFC 9530 Content-Digest)

const CONTENT_DIGEST_PATTERN = /^sha-256=:[A-Za-z0-9+/]{43}=:$/;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `sha-256=:<base64>:` over the exact bytes delivered, as in RFC 9530's Content-Digest field. */
export async function contentDigestSha256(body: Uint8Array | string): Promise<string> {
  // A copy backed by a plain ArrayBuffer, as WebCrypto requires (a view may sit on a SharedArrayBuffer).
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha-256=:${bytesToBase64(digest)}:`;
}

export function isContentDigest(value: string): boolean {
  return CONTENT_DIGEST_PATTERN.test(value);
}

/** What the publisher's middleware attests after delivering a paid response. */
export const receiptAttestationSchema = z.object({
  contentDigest: z.string().regex(CONTENT_DIGEST_PATTERN),
  contentLength: z.number().int().nonnegative(),
  contentType: z.string().max(200),
  status: z.number().int().min(100).max(599),
});
export type ReceiptAttestation = z.infer<typeof receiptAttestationSchema>;

/**
 * The offer as the publisher declared it, carried in the payment requirements as
 * `extra.botfareOffer` (server-authored, stored on the receipt at settle). Fare Court compares
 * what was declared here with what was delivered.
 */
export const declaredOfferSchema = z.object({
  title: z.string().min(1).max(200),
  preview: z.string().max(600).default(""),
  wordCount: z.number().int().nonnegative().optional(),
});
export type DeclaredOffer = z.infer<typeof declaredOfferSchema>;

/** Requirement `extra` keys BotFare uses; all are server-authored (declared as dynamic extra fields). */
export const REQUIREMENT_EXTRA_KEYS = {
  signal: "botfareSignal",
  offer: "botfareOffer",
  /**
   * The URL the publisher's server is serving. The facilitator records it on the receipt (and
   * BotFare signs it as a payment statement's `resource`); the agent's `resource.url` is ignored.
   */
  resource: "botfareResource",
} as const;

// ---------------------------------------------------------------------------------------------
// Fare Court

export const disputeReasonSchema = z.enum([
  "not_as_described", // content does not match the declared title/preview
  "stub_or_paywall", // a teaser, "subscribe to keep reading", or a login wall after paying
  "error_page", // an error or empty page served with a success status
  "truncated", // cut off well short of what was declared
  "unrelated", // a different page, an ad, or spam
  "other",
]);
export type DisputeReason = z.infer<typeof disputeReasonSchema>;

/** Largest delivered body an agent may submit with a dispute (bytes, before base64). */
export const MAX_DISPUTE_CONTENT_BYTES = 1_000_000;

export const disputeRequestSchema = z.object({
  receiptId: z.string().startsWith(`${IdPrefix.receipt}_`),
  reason: disputeReasonSchema,
  note: z.string().max(500).optional(),
  /** The exact bytes the agent received, base64-encoded; BotFare checks them against the attested digest. */
  contentBase64: z
    .string()
    .max(Math.ceil(MAX_DISPUTE_CONTENT_BYTES / 3) * 4 + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type DisputeRequest = z.infer<typeof disputeRequestSchema>;

/** The AI judge's structured verdict (validated with zod before any money moves). */
export const disputeVerdictSchema = z.object({
  decision: z.enum(["refund", "deny", "unsure"]),
  confidence: z.number().min(0).max(1),
  category: disputeReasonSchema,
  rationale: z.string().min(1).max(1200),
  evidence: z
    .array(z.object({ declared: z.string().max(300), delivered: z.string().max(300) }))
    .max(5)
    .default([]),
});
export type DisputeVerdict = z.infer<typeof disputeVerdictSchema>;

export const disputeStatusSchema = z.enum([
  "refunded", // refunded automatically (confident AI verdict) or by the publisher
  "denied", // the AI found the content matched the offer
  "pending_publisher", // uncertain verdict: the publisher decides
  "rejected_by_publisher", // the publisher reviewed and declined the refund
  "invalid", // digest mismatch, outside the window, or not the agent's receipt
]);
export type DisputeStatus = z.infer<typeof disputeStatusSchema>;

/** Policy is code, not model output: the AI only produces a verdict. */
export const DISPUTE_POLICY = {
  /** Disputes must be filed within this many hours of the purchase. */
  windowHours: 24,
  /** A "refund" verdict at or above this confidence refunds immediately. */
  autoRefundConfidence: 0.8,
  /** A "deny" verdict at or above this confidence closes the dispute without review. */
  autoDenyConfidence: 0.8,
  /** At most this many disputes per agent key per UTC day. */
  maxDisputesPerKeyPerDay: 10,
  /** Once a key has at least `minSampleForRate` purchases in 7 days, disputing more than this share needs publisher review. */
  maxAutoRefundRate: 0.2,
  minSampleForRate: 10,
} as const;

export interface DisputeOutcome {
  disputeId: string;
  receiptId: string;
  status: DisputeStatus;
  refundedCents: number;
  verdict: DisputeVerdict | null;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// Fare Advisor signals

export const declineCategorySchema = z.enum([
  "too_expensive",
  "irrelevant",
  "low_quality_preview",
  "already_have",
  "over_budget",
  "other",
]);
export type DeclineCategory = z.infer<typeof declineCategorySchema>;

/** Optional, free note from an agent: it saw the offer and decided not to buy, and why. */
export const declineNoteSchema = z.object({
  url: z.string().url(),
  priceCents: z.number().int().min(0),
  category: declineCategorySchema.default("other"),
  reason: z.string().min(1).max(300),
});
export type DeclineNote = z.infer<typeof declineNoteSchema>;

/** Which paid reads an answer actually used ("citations are the new clicks"). */
export const citationReportSchema = z.object({
  /** Client-generated ID for the answer; reports with the same ID replace each other. */
  answerId: z.string().min(8).max(64),
  citations: z
    .array(
      z.object({
        receiptId: z.string().startsWith(`${IdPrefix.receipt}_`),
        claim: z.string().max(300).default(""),
      }),
    )
    .min(1)
    .max(20),
});
export type CitationReport = z.infer<typeof citationReportSchema>;

/** Batched "offer shown" events from the publisher middleware (no personal data). */
export const offerTelemetryBatchSchema = z.object({
  events: z
    .array(
      z.object({
        path: z.string().startsWith("/").max(500),
        method: z.string().max(10),
        priceCents: z.number().int().min(0),
        signal: detectionSignalSchema.nullable(),
        at: z.string().datetime(),
      }),
    )
    .min(1)
    .max(500),
});
export type OfferTelemetryBatch = z.infer<typeof offerTelemetryBatchSchema>;

// ---------------------------------------------------------------------------------------------
// Fare Advisor output

/** One recommendation from the AI advisor (validated with zod; applying it is a separate, explicit step). */
export const advisorRecommendationSchema = z.object({
  /** The pricing rule pattern the recommendation targets (e.g. "/articles/premium-*"). */
  pattern: z.string().startsWith("/"),
  kind: z.enum(["price", "preview", "audience", "keep"]),
  currentPriceCents: z.number().int().min(0),
  suggestedPriceCents: z.number().int().min(1).max(100_00).optional(),
  suggestedAudience: z.enum(["agents", "everyone"]).optional(),
  previewAdvice: z.string().max(400).optional(),
  headline: z.string().min(1).max(160),
  rationale: z.string().min(1).max(800),
  evidence: z.object({
    offers: z.number().int().nonnegative(),
    paid: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
    cited: z.number().int().nonnegative(),
    disputed: z.number().int().nonnegative(),
    topReasons: z
      .array(z.object({ reason: z.string().max(200), count: z.number().int().positive() }))
      .max(5),
  }),
  projectedWeeklyRevenueDeltaCents: z.number().int(),
  confidence: z.number().min(0).max(1),
});
export type AdvisorRecommendation = z.infer<typeof advisorRecommendationSchema>;
