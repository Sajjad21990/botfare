/**
 * JSON shapes of the publisher dashboard (GET /api/publisher/summary and the page's initial data).
 * Types only, so client components can import them without pulling in server code.
 */
import type { DetectionConfig, DetectionSignal, PricingRule } from "@botfare/contracts";

export type PayoutStatusView =
  | "pending"
  | "processing"
  | "success"
  | "failed"
  | "returned"
  | "unclaimed"
  | "reversed";

export interface PayoutView {
  id: string;
  amountCents: number;
  receiverEmail: string;
  status: PayoutStatusView;
  /** PayPal's payout_batch_id, once PayPal accepted the batch. */
  paypalBatchId: string | null;
  /** Our sender_batch_id. */
  batchKey: string;
  error: string | null;
  /** True when the amount went back to available earnings. */
  reversed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SiteView {
  id: string;
  name: string;
  /** The shared demo site seen in judge mode: its secret cannot be rotated. */
  demoLocked: boolean;
  origin: string;
  payoutEmail: string | null;
  pricing: PricingRule[];
  freePaths: string[];
  chargeKnownBots: boolean;
  /** Agent detection settings (who gets a 402), defaults filled in. */
  detection: DetectionConfig;
  version: string;
  createdAt: string;
  paidRequests: number;
  /** After BotFare's 5%, settled receipts only. */
  earningsMicros: number;
}

export interface PublisherDashboard {
  /** The whole earnings balance: available plus clearing. */
  earningsMicros: number;
  /** What Withdraw can pay now (the balance minus what is clearing). */
  availableMicros: number;
  /** Earnings from fares agents can still dispute (or with an undecided dispute). */
  clearingMicros: number;
  /** ISO time the next clearing fare becomes available; null when none waits on the window. */
  nextReleaseAt: string | null;
  /** How long a fare stays disputable (DISPUTE_POLICY.windowHours). */
  disputeWindowHours: number;
  lifetimeEarningsMicros: number;
  paidRequests: number;
  /** The user's payout email, falling back to their first site's. */
  payoutEmail: string | null;
  /** True when payoutEmail is set on the user, not inherited from a site. */
  payoutEmailOnProfile: boolean;
  minimumPayoutCents: number;
  /** False when the server has no PayPal credentials, so Withdraw now cannot work. */
  paypalConfigured?: boolean;
  /** Signed in as a shared demo persona: the payout email is fixed. */
  judgeMode: boolean;
  payouts: PayoutView[];
  /** Newest first. */
  sites: SiteView[];
}

/** POST /api/publisher/sites and POST /api/publisher/sites/[siteId]/rotate-secret. */
export interface SiteSecretResponse {
  site: SiteView;
  /** Shown once; BotFare keeps only its hash. */
  siteSecret: string;
}

/** GET /api/publisher/sites/[siteId]/detection. */
export interface DetectionResponse {
  detection: DetectionConfig;
  /** Settled revenue per detection signal on this site, largest first; null = not recorded. */
  revenueBySignal: {
    signal: DetectionSignal | null;
    paidRequests: number;
    earningsMicros: number;
  }[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
