import { isDemoPersonaEmail, isLockedDemoSite } from "@botfare/contracts";
import {
  type Db,
  DEFAULT_PAYOUT_MINIMUM_CENTS,
  getUserById,
  listSites,
  MoneyFlowError,
  type Payout,
  publisherSummary,
  type Site,
  siteDetection,
} from "@botfare/core";
import { z } from "zod";
import type { PayoutView, PublisherDashboard, SiteView } from "../../components/publisher/types";
import { jsonError } from "./http";

/** "Withdraw now" starts at $1.00. */
export const MINIMUM_PAYOUT_CENTS = DEFAULT_PAYOUT_MINIMUM_CENTS;

export function toPayoutView(payout: Payout): PayoutView {
  return {
    id: payout.id,
    amountCents: payout.amountCents,
    receiverEmail: payout.receiverEmail,
    status: payout.status,
    paypalBatchId: payout.paypalBatchId,
    batchKey: payout.batchKey,
    error: payout.error,
    reversed: payout.reversalTransactionId !== null,
    createdAt: payout.createdAt.toISOString(),
    updatedAt: payout.updatedAt.toISOString(),
  };
}

export function toSiteView(
  site: Site,
  stats: { paidRequests: number; earningsMicros: number } = { paidRequests: 0, earningsMicros: 0 },
  viewerEmail?: string,
): SiteView {
  return {
    id: site.id,
    name: site.name,
    demoLocked: isLockedDemoSite(viewerEmail, site.name),
    origin: site.origin,
    payoutEmail: site.payoutEmail,
    pricing: site.pricing,
    freePaths: site.freePaths,
    chargeKnownBots: site.chargeKnownBots,
    detection: siteDetection(site),
    version: site.version,
    createdAt: site.createdAt.toISOString(),
    paidRequests: stats.paidRequests,
    earningsMicros: stats.earningsMicros,
  };
}

/** Everything the /publisher page shows, for the signed-in user only. */
export async function getPublisherDashboard(db: Db, userId: string): Promise<PublisherDashboard> {
  const [summary, sites, user] = await Promise.all([
    publisherSummary(db, userId),
    listSites(db, userId),
    getUserById(db, userId),
  ]);
  const stats = new Map(summary.sites.map((site) => [site.id, site]));
  return {
    earningsMicros: summary.earningsMicros,
    lifetimeEarningsMicros: summary.lifetimeEarningsMicros,
    paidRequests: summary.paidRequests,
    payoutEmail: summary.payoutEmail,
    payoutEmailOnProfile: Boolean(user?.payoutEmail),
    minimumPayoutCents: MINIMUM_PAYOUT_CENTS,
    judgeMode: isDemoPersonaEmail(user?.email),
    payouts: summary.payouts.map(toPayoutView),
    sites: sites.map((site) => toSiteView(site, stats.get(site.id), user?.email)),
  };
}

const MONEY_ERROR_STATUS: Record<MoneyFlowError["code"], number> = {
  not_found: 404,
  invalid_amount: 400,
  amount_mismatch: 409,
  not_approved: 409,
  no_payout_email: 422,
  below_minimum: 422,
};

/**
 * Maps the errors core throws to JSON: MoneyFlowError by code, a ZodError (core re-validates
 * every input) to 400. Anything else is rethrown.
 */
export function moneyErrorResponse(err: unknown): Response {
  if (err instanceof MoneyFlowError) {
    return jsonError(MONEY_ERROR_STATUS[err.code] ?? 400, err.code, err.message);
  }
  if (err instanceof z.ZodError || (err instanceof Error && err.name === "ZodError")) {
    const issue = (err as z.ZodError).issues?.[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return jsonError(400, "invalid_request", `${where}${issue?.message ?? "Invalid input"}`);
  }
  throw err;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;
