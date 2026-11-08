import {
  type AgentKey,
  type Db,
  listAgentKeys,
  listReceipts,
  MoneyFlowError,
  schema,
  walletSummary,
} from "@botfare/core";
import { PayPalApiError, PayPalInputError } from "@botfare/paypal";
import { ZodError } from "zod";
import type {
  WalletAgentKey,
  WalletReceipt,
  WalletSite,
  WalletView,
} from "../../components/wallet/types";
import { jsonError } from "./http";

/** How many recent receipts the wallet page shows. */
export const WALLET_RECEIPT_LIMIT = 50;

/** Every publisher site by name, for the allowed-sites picker and receipt labels. */
export async function listSiteDirectory(db: Db): Promise<WalletSite[]> {
  return db
    .select({ id: schema.sites.id, name: schema.sites.name, origin: schema.sites.origin })
    .from(schema.sites)
    .orderBy(schema.sites.createdAt, schema.sites.id);
}

export function toWalletAgentKey(key: AgentKey, spentTodayMicros = 0): WalletAgentKey {
  return {
    id: key.id,
    name: key.name,
    status: key.status,
    perRequestMaxCents: key.perRequestMaxCents,
    dailyCapCents: key.dailyCapCents,
    allowedSiteIds: key.allowedSiteIds,
    spentTodayMicros,
    createdAt: key.createdAt.toISOString(),
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

/** The path of a paid resource URL, or a readable placeholder. */
export function receiptPath(resourceUrl: string | null): string {
  if (!resourceUrl) return "(unknown)";
  try {
    return new URL(resourceUrl).pathname || "/";
  } catch {
    return resourceUrl.startsWith("/") ? resourceUrl : "(unknown)";
  }
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Everything the wallet page shows, for the signed-in agent owner only. */
export async function getWalletView(db: Db, userId: string): Promise<WalletView> {
  const [summary, keys, receipts, sites, todays] = await Promise.all([
    walletSummary(db, userId),
    listAgentKeys(db, userId),
    listReceipts(db, { ownerUserId: userId, limit: WALLET_RECEIPT_LIMIT }),
    listSiteDirectory(db),
    // Per-key spend today, the way the facilitator counts the daily cap (settled, UTC day).
    listReceipts(db, { ownerUserId: userId, limit: 500 }),
  ]);
  const dayStart = startOfUtcDay().getTime();
  const spentToday = new Map<string, number>();
  for (const receipt of todays) {
    if (receipt.status !== "settled" || receipt.createdAt.getTime() < dayStart) continue;
    spentToday.set(
      receipt.agentKeyId,
      (spentToday.get(receipt.agentKeyId) ?? 0) + receipt.amountMicros,
    );
  }
  const siteNames = new Map(sites.map((site) => [site.id, site.name]));
  const keyNames = new Map(keys.map((key) => [key.id, key.name]));
  return {
    balanceMicros: summary.balanceMicros,
    spendTodayMicros: summary.spendTodayMicros,
    topups: summary.topups.map((topup) => ({
      id: topup.id,
      createdAt: topup.createdAt.toISOString(),
      captureId: topup.captureId,
      grossCents: topup.grossCents,
      feeCents: topup.feeCents,
    })),
    keys: keys.map((key) => toWalletAgentKey(key, spentToday.get(key.id) ?? 0)),
    receipts: receipts.map(
      (receipt): WalletReceipt => ({
        id: receipt.id,
        createdAt: receipt.createdAt.toISOString(),
        siteId: receipt.siteId,
        siteName: siteNames.get(receipt.siteId) ?? receipt.siteId,
        path: receiptPath(receipt.resourceUrl),
        agentKeyId: receipt.agentKeyId,
        agentKeyName: keyNames.get(receipt.agentKeyId) ?? receipt.agentKeyId,
        amountMicros: receipt.amountMicros,
        status: receipt.status,
      }),
    ),
    sites,
  };
}

const MONEY_ERROR_STATUS: Record<MoneyFlowError["code"], number> = {
  not_found: 404,
  invalid_amount: 400,
  amount_mismatch: 409,
  not_approved: 409,
  no_payout_email: 409,
  below_minimum: 409,
};

/**
 * Maps errors from the money services and PayPal to a JSON response. Unknown errors are logged
 * and answered with a generic 500 (never the raw message, which may carry internals).
 */
export function walletErrorResponse(err: unknown, context: string): Response {
  if (err instanceof MoneyFlowError) {
    return jsonError(MONEY_ERROR_STATUS[err.code], err.code, err.message);
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return jsonError(400, "invalid_request", issue?.message ?? "Invalid request");
  }
  if (err instanceof PayPalApiError) {
    console.warn(`[wallet] ${context}: PayPal ${err.status} ${err.name} (debug ${err.debugId})`);
    return jsonError(502, "paypal_error", "PayPal could not complete the request. Try again.");
  }
  if (err instanceof PayPalInputError) {
    console.warn(`[wallet] ${context}: ${err.message}`);
    return jsonError(400, "invalid_request", err.message);
  }
  if (err instanceof Error && /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/.test(err.message)) {
    return jsonError(503, "paypal_not_configured", "PayPal is not configured on this server");
  }
  console.error(`[wallet] ${context}:`, err);
  return jsonError(500, "internal_error", "Something went wrong");
}
