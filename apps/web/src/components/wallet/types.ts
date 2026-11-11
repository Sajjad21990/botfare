/** Wallet page data as it crosses the server/browser boundary (GET /api/wallet/summary). */

export interface WalletSite {
  id: string;
  name: string;
  origin: string;
}

export interface WalletAgentKey {
  id: string;
  name: string;
  /** A seeded demo key seen in judge mode: it cannot be revoked. */
  demoLocked: boolean;
  status: "active" | "revoked";
  /** null = no per-request limit. */
  perRequestMaxCents: number | null;
  /** null = no daily limit. */
  dailyCapCents: number | null;
  /** null = any site. */
  allowedSiteIds: string[] | null;
  /** Settled spend since 00:00 UTC (the day the daily cap counts). */
  spentTodayMicros: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface WalletReceipt {
  id: string;
  createdAt: string;
  siteId: string;
  siteName: string;
  /** Path of the paid resource, e.g. `/recipes/crispy-oven-potatoes`. */
  path: string;
  agentKeyId: string;
  agentKeyName: string;
  amountMicros: number;
  status: "settled" | "refunded";
}

export interface WalletTopUp {
  id: string;
  createdAt: string;
  captureId: string;
  grossCents: number;
  feeCents: number;
}

export interface WalletView {
  balanceMicros: number;
  spendTodayMicros: number;
  topups: WalletTopUp[];
  keys: WalletAgentKey[];
  receipts: WalletReceipt[];
  sites: WalletSite[];
}

/** POST /api/wallet/topups/[orderId]/capture */
export interface CaptureResponse {
  status: "captured" | "pending" | "failed";
  walletMicros: number;
  captureId?: string;
  grossCents?: number;
  feeCents?: number;
}

/** The choices the wallet offers (mirrors TOP_UP_AMOUNTS_CENTS in @botfare/core). */
export const TOP_UP_CHOICES_CENTS = [500, 1000, 2000] as const;
export type TopUpCents = (typeof TOP_UP_CHOICES_CENTS)[number];
