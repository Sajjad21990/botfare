/** Read models for the wallet and publisher dashboards. All amounts in micro-dollars. */
import { type DetectionSignal, detectionSignalSchema } from "@botfare/contracts";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { earningsBalanceMicros, walletBalanceMicros } from "../ledger";
import { agentKeys, type Payout, receipts, sites, type TopUp, topups } from "../schema";
import { getPayoutEmail, listPayouts } from "./payouts";

export interface WalletSummary {
  balanceMicros: number;
  /** Completed top-ups, newest first (at most 20). */
  topups: TopUp[];
  /** Settled spend by all the user's agent keys since 00:00 UTC. */
  spendTodayMicros: number;
}

export async function walletSummary(db: DbOrTx, userId: string): Promise<WalletSummary> {
  const [balanceMicros, recentTopups, spend] = await Promise.all([
    walletBalanceMicros(db, userId),
    db
      .select()
      .from(topups)
      .where(eq(topups.ownerUserId, userId))
      .orderBy(desc(topups.createdAt), desc(topups.id))
      .limit(20),
    db
      .select({ total: sql<string>`coalesce(sum(${receipts.amountMicros}), 0)` })
      .from(receipts)
      .where(
        and(
          eq(receipts.ownerUserId, userId),
          eq(receipts.status, "settled"),
          gte(receipts.createdAt, startOfUtcDay()),
        ),
      ),
  ]);
  return {
    balanceMicros,
    topups: recentTopups,
    spendTodayMicros: Number(spend[0]?.total ?? 0),
  };
}

export interface PublisherSiteSummary {
  id: string;
  name: string;
  origin: string;
  payoutEmail: string | null;
  paidRequests: number;
  /** What the site earned after BotFare's 5% (settled receipts only). */
  earningsMicros: number;
}

export interface PublisherSummary {
  /** Earnings available to pay out now. */
  earningsMicros: number;
  /** Everything earned after BotFare's fee, from settled receipts. */
  lifetimeEarningsMicros: number;
  paidRequests: number;
  /** Where payouts go (user's payout email, or their first site's), or null. */
  payoutEmail: string | null;
  /** Newest first (at most 20). */
  payouts: Payout[];
  sites: PublisherSiteSummary[];
}

export async function publisherSummary(db: DbOrTx, userId: string): Promise<PublisherSummary> {
  const net = sql<string>`coalesce(sum(${receipts.amountMicros} - ${receipts.feeMicros}), 0)`;
  const [earningsMicros, payoutEmail, recentPayouts, siteRows, perSite] = await Promise.all([
    earningsBalanceMicros(db, userId),
    getPayoutEmail(db, userId),
    listPayouts(db, userId, { limit: 20 }),
    db
      .select({
        id: sites.id,
        name: sites.name,
        origin: sites.origin,
        payoutEmail: sites.payoutEmail,
      })
      .from(sites)
      .where(eq(sites.ownerUserId, userId))
      .orderBy(asc(sites.createdAt), asc(sites.id)),
    db
      .select({ siteId: receipts.siteId, paidRequests: count(), earnings: net })
      .from(receipts)
      .where(and(eq(receipts.publisherUserId, userId), eq(receipts.status, "settled")))
      .groupBy(receipts.siteId),
  ]);
  const bySite = new Map(perSite.map((row) => [row.siteId, row]));
  const siteSummaries = siteRows.map((site) => ({
    ...site,
    paidRequests: Number(bySite.get(site.id)?.paidRequests ?? 0),
    earningsMicros: Number(bySite.get(site.id)?.earnings ?? 0),
  }));
  return {
    earningsMicros,
    lifetimeEarningsMicros: perSite.reduce((sum, row) => sum + Number(row.earnings), 0),
    paidRequests: perSite.reduce((sum, row) => sum + Number(row.paidRequests), 0),
    payoutEmail,
    payouts: recentPayouts,
    sites: siteSummaries,
  };
}

export interface PublisherReceiptRow {
  id: string;
  createdAt: Date;
  siteId: string;
  siteName: string;
  agentKeyId: string;
  agentKeyName: string;
  resourceUrl: string | null;
  status: "settled" | "refunded";
  amountCents: number;
  amountMicros: number;
  /** BotFare's 5%. */
  feeMicros: number;
  /** What the publisher earned: amount minus fee. */
  netMicros: number;
  /** Why the request was treated as an agent; null for receipts without a recorded signal. */
  detectionSignal: DetectionSignal | null;
}

/** Receipts on the publisher's sites, newest first, for analytics. `limit` defaults to 500, max 5000. */
export async function receiptsForPublisher(
  db: DbOrTx,
  userId: string,
  options: { since?: Date; limit?: number } = {},
): Promise<PublisherReceiptRow[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 5000);
  const rows = await db
    .select({
      id: receipts.id,
      createdAt: receipts.createdAt,
      siteId: receipts.siteId,
      siteName: sites.name,
      agentKeyId: receipts.agentKeyId,
      agentKeyName: agentKeys.name,
      resourceUrl: receipts.resourceUrl,
      status: receipts.status,
      amountCents: receipts.amountCents,
      amountMicros: receipts.amountMicros,
      feeMicros: receipts.feeMicros,
      detectionSignal: receipts.detectionSignal,
    })
    .from(receipts)
    .innerJoin(sites, eq(sites.id, receipts.siteId))
    .innerJoin(agentKeys, eq(agentKeys.id, receipts.agentKeyId))
    .where(
      and(
        eq(receipts.publisherUserId, userId),
        options.since ? gte(receipts.createdAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(receipts.createdAt), desc(receipts.id))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    netMicros: row.amountMicros - row.feeMicros,
    detectionSignal: toDetectionSignal(row.detectionSignal),
  }));
}

export interface SignalRevenue {
  /** null groups receipts with no recorded signal (older receipts, older middleware). */
  signal: DetectionSignal | null;
  paidRequests: number;
  /** After BotFare's 5%, settled receipts only. */
  earningsMicros: number;
}

/**
 * "Revenue recovered" per detection signal on the publisher's sites: settled receipts only,
 * largest earnings first. Pass `siteId` for one site, `since` for a time window.
 */
export async function revenueBySignal(
  db: DbOrTx,
  publisherUserId: string,
  options: { siteId?: string; since?: Date } = {},
): Promise<SignalRevenue[]> {
  const net = sql<string>`coalesce(sum(${receipts.amountMicros} - ${receipts.feeMicros}), 0)`;
  const rows = await db
    .select({ signal: receipts.detectionSignal, paidRequests: count(), earnings: net })
    .from(receipts)
    .where(
      and(
        eq(receipts.publisherUserId, publisherUserId),
        eq(receipts.status, "settled"),
        options.siteId ? eq(receipts.siteId, options.siteId) : undefined,
        options.since ? gte(receipts.createdAt, options.since) : undefined,
      ),
    )
    .groupBy(receipts.detectionSignal);
  // Values the contract no longer knows fold into "no signal".
  const merged = new Map<DetectionSignal | null, SignalRevenue>();
  for (const row of rows) {
    const signal = toDetectionSignal(row.signal);
    const entry = merged.get(signal) ?? { signal, paidRequests: 0, earningsMicros: 0 };
    entry.paidRequests += Number(row.paidRequests);
    entry.earningsMicros += Number(row.earnings);
    merged.set(signal, entry);
  }
  return [...merged.values()].sort(
    (a, b) => b.earningsMicros - a.earningsMicros || b.paidRequests - a.paidRequests,
  );
}

function toDetectionSignal(value: string | null): DetectionSignal | null {
  const parsed = detectionSignalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
