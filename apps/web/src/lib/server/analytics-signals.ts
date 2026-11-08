import { declineCategorySchema } from "@botfare/contracts/fare";
import type { Db } from "@botfare/core";
import type { CitationRow, DeclineRow, SignalsData } from "../../components/analytics/types";
import { DECLINE_CATEGORY_LABEL } from "../../components/publisher/advisor/labels";
import { resourcePath } from "./analytics-receipts";

/**
 * Fare Advisor signals for the analytics dashboard: which paid reads agents' answers cited, and
 * why agents declined offers. Only the signed-in publisher's own sites; newest first.
 */

/** Most rows of each kind the dashboard loads at once. */
export const MAX_SIGNAL_ROWS = 2000;

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? MAX_SIGNAL_ROWS), 1), MAX_SIGNAL_ROWS);
}

async function ownSiteNames(db: Db, publisherUserId: string): Promise<Map<string, string>> {
  const sites = await db.query.sites.findMany({
    columns: { id: true, name: true },
    where: (site, { eq }) => eq(site.ownerUserId, publisherUserId),
  });
  return new Map(sites.map((site) => [site.id, site.name]));
}

async function keyNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const keys = await db.query.agentKeys.findMany({
    columns: { id: true, name: true },
    where: (key, { inArray }) => inArray(key.id, ids),
  });
  return new Map(keys.map((key) => [key.id, key.name]));
}

/** Citations of the publisher's receipts, as dashboard rows. */
export async function listPublisherCitationRows(
  db: Db,
  publisherUserId: string,
  options: { limit?: number; siteNames?: Map<string, string> } = {},
): Promise<CitationRow[]> {
  const siteNames = options.siteNames ?? (await ownSiteNames(db, publisherUserId));
  if (siteNames.size === 0) return [];
  const citations = await db.query.citations.findMany({
    columns: {
      id: true,
      createdAt: true,
      siteId: true,
      receiptId: true,
      agentKeyId: true,
      claim: true,
    },
    where: (citation, { inArray }) => inArray(citation.siteId, [...siteNames.keys()]),
    orderBy: (citation, { desc }) => [desc(citation.createdAt), desc(citation.id)],
    limit: clampLimit(options.limit),
  });
  if (citations.length === 0) return [];
  const receiptIds = [...new Set(citations.map((c) => c.receiptId))];
  const receipts = await db.query.receipts.findMany({
    columns: { id: true, resourceUrl: true },
    where: (receipt, { and, eq, inArray }) =>
      and(inArray(receipt.id, receiptIds), eq(receipt.publisherUserId, publisherUserId)),
  });
  const paths = new Map(receipts.map((r) => [r.id, resourcePath(r.resourceUrl)]));
  const agents = await keyNames(db, [...new Set(citations.map((c) => c.agentKeyId))]);
  return citations
    .filter((citation) => paths.has(citation.receiptId))
    .map((citation) => ({
      citationId: String(citation.id),
      createdAt: citation.createdAt.toISOString(),
      day: citation.createdAt.toISOString().slice(0, 10),
      siteName: siteNames.get(citation.siteId) ?? "(unknown site)",
      receiptId: citation.receiptId,
      path: paths.get(citation.receiptId) ?? "(unknown)",
      agentName: agents.get(citation.agentKeyId) ?? "(unknown agent)",
      claim: citation.claim,
    }));
}

/** Decline notes on the publisher's sites, as dashboard rows. */
export async function listPublisherDeclineRows(
  db: Db,
  publisherUserId: string,
  options: { limit?: number; siteNames?: Map<string, string> } = {},
): Promise<DeclineRow[]> {
  const siteNames = options.siteNames ?? (await ownSiteNames(db, publisherUserId));
  if (siteNames.size === 0) return [];
  const declines = await db.query.offerDeclines.findMany({
    columns: {
      id: true,
      createdAt: true,
      siteId: true,
      path: true,
      category: true,
      reason: true,
      priceCents: true,
    },
    where: (decline, { inArray }) => inArray(decline.siteId, [...siteNames.keys()]),
    orderBy: (decline, { desc }) => [desc(decline.createdAt), desc(decline.id)],
    limit: clampLimit(options.limit),
  });
  return declines.map((decline) => {
    const category = declineCategorySchema.safeParse(decline.category).data ?? "other";
    return {
      declineId: String(decline.id),
      createdAt: decline.createdAt.toISOString(),
      day: decline.createdAt.toISOString().slice(0, 10),
      siteName: siteNames.get(decline.siteId) ?? "(unknown site)",
      path: decline.path,
      category: DECLINE_CATEGORY_LABEL[category],
      reason: decline.reason,
      priceUsd: decline.priceCents / 100,
    };
  });
}

/** Both kinds of signal rows for the dashboard. */
export async function getPublisherSignals(
  db: Db,
  publisherUserId: string,
  options: { limit?: number } = {},
): Promise<SignalsData> {
  const siteNames = await ownSiteNames(db, publisherUserId);
  const [citations, declines] = await Promise.all([
    listPublisherCitationRows(db, publisherUserId, { ...options, siteNames }),
    listPublisherDeclineRows(db, publisherUserId, { ...options, siteNames }),
  ]);
  return { citations, declines };
}
