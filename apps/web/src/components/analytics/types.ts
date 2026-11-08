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
  /** Path of the paid resource, e.g. `/articles/grinders`. */
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
}

export interface ReceiptsResponse {
  rows: ReceiptRow[];
  /** The publisher's current earnings balance (unpaid, withdrawable). */
  earnings: { balanceUsd: number };
  /** Number of sites the publisher owns. */
  siteCount: number;
  generatedAt: string;
}
