import type { DisputeOutcome, DisputeReason, DisputeStatus } from "@botfare/contracts/fare";

/** One Fare Court dispute as the dashboards show it (JSON from the server). */
export interface DisputeView {
  id: string;
  receiptId: string;
  siteId: string;
  siteName: string;
  agentKeyName: string;
  url: string | null;
  path: string;
  amountCents: number;
  reason: DisputeReason;
  note: string | null;
  /** A dispute still waiting for its verdict reads as pending_publisher. */
  status: DisputeStatus;
  message: string;
  verdict: DisputeOutcome["verdict"];
  refundedCents: number;
  declaredOffer: { title: string; preview: string; wordCount?: number } | null;
  /** The start of the delivered text; only the publisher's view carries it. */
  deliveredExcerpt: string | null;
  contentDigestOk: boolean;
  autoAllowed: boolean;
  decidedBy: "ai" | "publisher" | "system" | null;
  createdAt: string;
  decidedAt: string | null;
  purchasedAt: string;
}

export interface PublisherDisputes {
  pendingCount: number;
  disputes: DisputeView[];
}

export interface PublisherDecisionResult {
  outcome: DisputeOutcome;
  pendingCount: number;
}
