/**
 * Shapes shared by the analytics API (server) and the AG Studio dashboard (browser).
 * Money is USD as a decimal number here: the dashboard aggregates it, so it is not cents.
 */

/** One paid request (x402 receipt) as the publisher sees it. */
export interface ReceiptRow {
  receiptId: string;
  /** ISO 8601 timestamp of settlement. */
  createdAt: string;
  /** UTC calendar day of `createdAt` (YYYY-MM-DD); the browser re-derives it in local time. */
  day: string;
  siteName: string;
  /** Path of the paid resource, e.g. `/recipes/crispy-oven-potatoes`. */
  path: string;
  agentKeyId: string;
  agentName: string;
  /** What the agent paid. */
  amountUsd: number;
  /** BotFare's 5% fee on the payment. */
  feeUsd: number;
  /** What the publisher keeps: amount minus fee, or 0 once refunded. */
  earningsUsd: number;
  status: "settled" | "refunded";
  /**
   * Why BotFare asked this request to pay, in words (e.g. "Agent header", "CDN bot score");
   * "Not recorded" for receipts settled before signals were recorded.
   */
  detectionSignal: string;
}

export interface ReceiptsResponse extends SignalsData {
  rows: ReceiptRow[];
  /** The publisher's current earnings balance (unpaid, withdrawable). */
  earnings: { balanceUsd: number };
  /** Number of sites the publisher owns. */
  siteCount: number;
  generatedAt: string;
}

/**
 * One citation: an agent's answer used one of the publisher's paid reads ("citations are the new
 * clicks"). Joins the receipts table on `receiptId`.
 */
export interface CitationRow {
  citationId: string;
  /** ISO 8601 timestamp of the citation report. */
  createdAt: string;
  /** UTC calendar day of `createdAt`; the browser re-derives it in local time. */
  day: string;
  siteName: string;
  /** The cited receipt. */
  receiptId: string;
  /** Path of the cited page. */
  path: string;
  agentName: string;
  /** What the answer used the page for (agent-written, may be empty). */
  claim: string;
}

/** One decline note: an agent saw an offer and said why it did not buy. */
export interface DeclineRow {
  declineId: string;
  createdAt: string;
  day: string;
  siteName: string;
  path: string;
  /** The reason category in words, e.g. "Too expensive". */
  category: string;
  /** The agent's own words (untrusted text). */
  reason: string;
  /** The price the agent declined. */
  priceUsd: number;
}

/** Fare Advisor signals the analytics dashboard loads next to the receipts. */
export interface SignalsData {
  citations: CitationRow[];
  declines: DeclineRow[];
}
