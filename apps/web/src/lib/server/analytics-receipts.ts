import { detectionSignalSchema } from "@botfare/contracts";
import { type Db, earningsBalanceMicros } from "@botfare/core";
import type { ReceiptRow, ReceiptsResponse } from "../../components/analytics/types";
import { signalLabel } from "../../components/publisher/detection-copy";

/** Most rows the dashboard loads at once; the newest ones win. */
export const MAX_RECEIPT_ROWS = 5000;

const MICROS_PER_USD = 1_000_000;

/** The path of a paid resource URL, or a readable placeholder when there is none. */
export function resourcePath(resourceUrl: string | null): string {
  if (!resourceUrl) return "(unknown)";
  try {
    return new URL(resourceUrl).pathname || "/";
  } catch {
    return resourceUrl.startsWith("/") ? resourceUrl : "(unknown)";
  }
}

/**
 * The publisher's receipts, newest first, as dashboard rows. Only receipts earned by this user on
 * a site this user owns are returned, so another publisher's traffic never appears.
 */
export async function listPublisherReceiptRows(
  db: Db,
  publisherUserId: string,
  options: { limit?: number } = {},
): Promise<ReceiptRow[]> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? MAX_RECEIPT_ROWS), 1),
    MAX_RECEIPT_ROWS,
  );
  const ownSites = await db.query.sites.findMany({
    columns: { id: true, name: true },
    where: (site, { eq }) => eq(site.ownerUserId, publisherUserId),
  });
  if (ownSites.length === 0) return [];
  const siteNames = new Map(ownSites.map((site) => [site.id, site.name]));

  const receipts = await db.query.receipts.findMany({
    columns: {
      id: true,
      createdAt: true,
      siteId: true,
      resourceUrl: true,
      agentKeyId: true,
      amountMicros: true,
      feeMicros: true,
      status: true,
      detectionSignal: true,
    },
    where: (receipt, { and, eq, inArray }) =>
      and(
        eq(receipt.publisherUserId, publisherUserId),
        inArray(receipt.siteId, [...siteNames.keys()]),
      ),
    orderBy: (receipt, { desc }) => [desc(receipt.createdAt), desc(receipt.id)],
    limit,
  });
  if (receipts.length === 0) return [];

  const keyIds = [...new Set(receipts.map((receipt) => receipt.agentKeyId))];
  const keys = await db.query.agentKeys.findMany({
    columns: { id: true, name: true },
    where: (key, { inArray }) => inArray(key.id, keyIds),
  });
  const keyNames = new Map(keys.map((key) => [key.id, key.name]));

  return receipts.map((receipt) => {
    const refunded = receipt.status === "refunded";
    return {
      receiptId: receipt.id,
      createdAt: receipt.createdAt.toISOString(),
      day: receipt.createdAt.toISOString().slice(0, 10),
      siteName: siteNames.get(receipt.siteId) ?? "(unknown site)",
      path: resourcePath(receipt.resourceUrl),
      agentKeyId: receipt.agentKeyId,
      agentName: keyNames.get(receipt.agentKeyId) ?? "(unknown agent)",
      amountUsd: receipt.amountMicros / MICROS_PER_USD,
      feeUsd: receipt.feeMicros / MICROS_PER_USD,
      earningsUsd: refunded ? 0 : (receipt.amountMicros - receipt.feeMicros) / MICROS_PER_USD,
      status: refunded ? "refunded" : "settled",
      detectionSignal: signalLabel(detectionSignalSchema.safeParse(receipt.detectionSignal).data),
    };
  });
}

/** Everything the analytics dashboard loads for one publisher. */
export async function getPublisherAnalytics(
  db: Db,
  publisherUserId: string,
  options: { limit?: number } = {},
): Promise<ReceiptsResponse> {
  const [rows, earningsMicros, siteCount] = await Promise.all([
    listPublisherReceiptRows(db, publisherUserId, options),
    earningsBalanceMicros(db, publisherUserId),
    db.query.sites
      .findMany({
        columns: { id: true },
        where: (site, { eq }) => eq(site.ownerUserId, publisherUserId),
      })
      .then((sites) => sites.length),
  ]);
  return {
    rows,
    earnings: { balanceUsd: earningsMicros / MICROS_PER_USD },
    siteCount,
    generatedAt: new Date().toISOString(),
  };
}
