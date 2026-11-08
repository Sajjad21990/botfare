/**
 * JSON shapes of Fare Advisor (GET /api/publisher/advisor, POST /api/publisher/advisor/apply).
 * Types only, so client components can import them without pulling in server code.
 */
import type { PricingRule } from "@botfare/contracts";
import type { AdvisorRecommendation, DeclineCategory } from "@botfare/contracts/fare";
import type { SiteView } from "../types";

/** One page or pricing rule's funnel over the window. */
export interface FunnelCounts {
  /** Offers shown: 402s the middleware reported. */
  offers: number;
  /** Purchases (refunded ones included). */
  paid: number;
  /** Decline notes from agents. */
  declined: number;
  /** Paid reads that an agent's answer cited. */
  cited: number;
  /** Disputes (invalid ones excluded). */
  disputed: number;
  /** Settled revenue, gross cents. */
  revenueCents: number;
  /** Refunded purchases, gross cents, whatever refunded them. */
  refundedCents: number;
  /** Refunds through Fare Court disputes only (what the Disputes page totals). */
  disputeRefundedCents: number;
}

export interface FunnelReason {
  reason: string;
  count: number;
}

export interface FunnelDetail extends FunnelCounts {
  declinedByCategory: Partial<Record<DeclineCategory, number>>;
  /** Most frequent decline reasons (at most 5). Written by agents: untrusted text. */
  topReasons: FunnelReason[];
}

export interface PathFunnel extends FunnelDetail {
  path: string;
}

export interface RuleFunnel extends FunnelDetail {
  pattern: string;
  method: string;
  priceCents: number;
  audience: PricingRule["audience"];
  description: string | null;
  /** Busiest paths first (at most 8). */
  paths: PathFunnel[];
  /**
   * Signals from before the rule's last price change, left out of its counts (which are for
   * `priceCents` only); null when every signal was at the current price.
   */
  earlier: { priceCents: number[]; offers: number; paid: number; declined: number } | null;
  /** True when the price changed and no agent has seen the new price yet: no AI advice for it. */
  awaitingSignals: boolean;
}

export interface AdvisorSummary {
  siteId: string;
  siteName: string;
  /** The site config version the summary was computed for. */
  siteVersion: string;
  days: number;
  from: string;
  to: string;
  totals: FunnelCounts;
  /** Site-wide decline categories and reasons. */
  declinedByCategory: Partial<Record<DeclineCategory, number>>;
  topReasons: FunnelReason[];
  /** One entry per pricing rule, in rule order. */
  rules: RuleFunnel[];
  /** Paths with signals that match no current rule. */
  unpriced: PathFunnel[];
}

/** A recommendation that passed BotFare's checks, with BotFare's own revenue projection. */
export interface AdvisorRecommendationView extends AdvisorRecommendation {
  id: string;
  /** The rule's method (a pattern may have rules for several methods). */
  method: string;
  /** Weekly revenue now and after the change, from BotFare's funnel model (not the model's guess). */
  projection: { currentWeeklyCents: number; projectedWeeklyCents: number };
}

export type AdvisorAiStatus =
  /** Recommendations are ready (possibly an empty list). */
  | "ready"
  /** Not generated yet; ask again with `ai=1`. */
  | "pending"
  /** No ANTHROPIC_API_KEY on the server. */
  | "unavailable"
  /** Too few signals to recommend anything. */
  | "insufficient_data"
  /** The model call failed or was refused; `aiMessage` says why. */
  | "error";

export interface AdvisorResponse {
  siteId: string;
  recommendations: AdvisorRecommendationView[];
  inputsSummary: AdvisorSummary;
  /** When the recommendations were generated (null until they are). */
  generatedAt: string | null;
  aiAvailable: boolean;
  aiStatus: AdvisorAiStatus;
  aiMessage: string | null;
  /** Recommendations the model returned that BotFare's checks discarded. */
  dropped: number;
}

/** POST /api/publisher/advisor/apply. */
export interface AdvisorApplyResponse {
  site: SiteView;
  before: PricingRule[];
  after: PricingRule[];
  changed: boolean;
}
