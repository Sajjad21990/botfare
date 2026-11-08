/**
 * The research agent's Server-Sent Events, shared by POST /api/research and the /agent page.
 * Types only (plus a few limits), so the browser can import them without pulling in server code.
 */

/** Default and highest budget for one run, in US cents. */
export const DEFAULT_BUDGET_CENTS = 25;
export const MAX_BUDGET_CENTS = 100;
export const MIN_BUDGET_CENTS = 5;
/** The demo agent's per-request cap (the SDK's `maxPerRequestUsd`), in cents. */
export const MAX_PER_REQUEST_CENTS = 10;
/** Hard limit on tool calls in one run, `finish` included. */
export const MAX_TOOL_CALLS = 12;
export const MAX_QUESTION_CHARS = 500;

export type DecisionAction = "buy" | "skip";
/** Who stopped a purchase: the SDK's per-request cap, the run's budget, or the publisher/facilitator. */
export type RefusalBy = "spend-limit" | "budget" | "publisher";

/** One step of the x402 handshake, decoded for the wire inspector. */
export type WireStage =
  | {
      stage: "payment-required";
      /** The raw base64 header, shortened for display. */
      header: string;
      headerLength: number;
      decoded: unknown;
    }
  | {
      stage: "payment-signature";
      header: string;
      headerLength: number;
      decoded: unknown;
      /** Protected header of the Ed25519 JWS (alg, typ, kid). */
      jwsHeader: Record<string, unknown> | null;
      /** Claims of the JWS: scheme, network, asset, amount, payTo, nonce, iat, exp. */
      claims: Record<string, unknown>;
    }
  | {
      stage: "payment-response";
      header: string;
      headerLength: number;
      decoded: unknown;
    };

export interface SourceSummary {
  siteId: string;
  siteName: string;
  origin: string;
  available: boolean;
  articleCount: number;
  error?: string;
}

export interface ResearchCitation {
  /** 1-based, as the answer refers to it: [1], [2], ... */
  n: number;
  url: string;
  title: string | null;
  claim: string;
  receiptId: string;
  amountCents: number;
  siteId: string;
  siteName: string;
}

export type ResearchEvent =
  | {
      type: "run-started";
      runId: string;
      question: string;
      budgetCents: number;
      maxPerRequestCents: number;
      maxToolCalls: number;
      model: string;
      agentKeyId: string;
    }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool-call"; toolCallId: string; name: string; input: unknown; callsUsed: number }
  | { type: "sources"; toolCallId: string; sources: SourceSummary[] }
  | {
      type: "offer";
      toolCallId: string;
      url: string;
      free: boolean;
      priceCents: number;
      title: string | null;
      excerpt: string | null;
      wordCount: number | null;
      siteId: string | null;
      siteName: string | null;
    }
  | {
      type: "decision";
      toolCallId: string;
      action: DecisionAction;
      url: string;
      title: string | null;
      priceCents: number | null;
      reason: string;
    }
  | {
      type: "refusal";
      toolCallId: string;
      url: string;
      by: RefusalBy;
      priceCents: number | null;
      message: string;
    }
  | { type: "wire"; toolCallId: string | null; url: string; step: WireStage }
  | {
      type: "payment";
      toolCallId: string;
      url: string;
      title: string | null;
      receiptId: string;
      amountCents: number;
      siteId: string;
      siteName: string;
      spentCents: number;
      remainingCents: number;
    }
  | { type: "tool-error"; toolCallId: string; name: string; message: string }
  | {
      type: "answer";
      answer: string;
      citations: ResearchCitation[];
      spentCents: number;
      budgetCents: number;
    }
  | { type: "error"; code: string; message: string }
  | {
      type: "done";
      status: "finished" | "stopped" | "failed";
      spentCents: number;
      remainingCents: number;
      toolCalls: number;
      receipts: number;
    };

export type ResearchEventType = ResearchEvent["type"];

/** GET /api/research: whether the demo agent can run here. */
export interface ResearchAvailability {
  available: boolean;
  model?: string;
  /** Environment variables that are not set (names only). */
  missing?: string[];
  message?: string;
}
