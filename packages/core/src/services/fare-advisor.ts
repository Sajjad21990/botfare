/**
 * Fare Advisor: the signals agents leave (offers shown, declines with a reason, citations,
 * disputes) aggregated per pricing rule and per path, and the one explicit step that changes a
 * price. The AI advisor reads advisorInputs(); only applyPriceChange (a publisher click) writes.
 */
import { matchesPattern, type PricingRule, pricingRuleSchema } from "@botfare/contracts";
import {
  type CitationReport,
  citationReportSchema,
  type DeclineCategory,
  type DeclineNote,
  declineNoteSchema,
  type OfferTelemetryBatch,
  offerTelemetryBatchSchema,
} from "@botfare/contracts/fare";
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db";
import {
  agentKeys,
  citations,
  type DisputeRowStatus,
  disputes,
  offerDeclines,
  offerEvents,
  receipts,
  type Site,
  sites,
} from "../schema";
import { updateSitePricing } from "./sites";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Bounds on what agents and middleware may report. */
export const ADVISOR_LIMITS = {
  /** Telemetry events stamped further in the future than this are dropped (clock skew). */
  telemetryMaxFutureMs: 5 * MINUTE_MS,
  /** Telemetry events older than this are dropped. */
  telemetryMaxAgeMs: 2 * DAY_MS,
  /** Decline notes per agent key per UTC day. */
  maxDeclinesPerKeyPerDay: 500,
  /**
   * Decline notes stored per agent owner, site path and UTC day, across all of the owner's keys
   * (keys are free to create, so a per-key limit alone does not bound one account's voice).
   */
  maxDeclinesPerOwnerPathPerDay: 3,
  /** Offer-shown events stored per publisher (all of their sites) per UTC day of receipt. */
  maxOfferEventsPerOwnerPerDay: 20_000,
  /** Longest URL stored with a decline. */
  maxUrlLength: 2_000,
  /** Days advisorInputs may look back. */
  maxDays: 90,
} as const;

// ---------------------------------------------------------------------------------------------
// Signals in

export type RecordTelemetryResult =
  | { ok: true; accepted: number; dropped: number }
  | { ok: false; reason: "invalid" | "not_found"; message: string };

/** Control characters (NUL included, which Postgres text cannot hold) never belong in a path. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Stores a batch of "offer shown" events (402s) from a site's middleware. The batch is validated
 * (at most 500 events); events stamped in the future or too long ago, or with control characters
 * in the path or method, are dropped one by one (never the whole batch); query strings are cut
 * from paths. At most ADVISOR_LIMITS.maxOfferEventsPerOwnerPerDay events are stored per publisher
 * per UTC day; the rest are dropped (telemetry is best effort, its counts a floor).
 */
export async function recordOfferTelemetry(
  db: DbOrTx,
  siteId: string,
  batch: OfferTelemetryBatch | unknown,
  options: { now?: Date } = {},
): Promise<RecordTelemetryResult> {
  const parsed = offerTelemetryBatchSchema.safeParse(batch);
  if (!parsed.success)
    return { ok: false, reason: "invalid", message: "Telemetry batch is not valid" };
  const [site] = await db
    .select({ id: sites.id, ownerUserId: sites.ownerUserId })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!site) return { ok: false, reason: "not_found", message: "Unknown site" };

  const now = (options.now ?? new Date()).getTime();
  const valid = parsed.data.events.flatMap((event) => {
    const at = Date.parse(event.at);
    if (
      hasControlChar(event.path) ||
      hasControlChar(event.method) ||
      !Number.isFinite(at) ||
      at > now + ADVISOR_LIMITS.telemetryMaxFutureMs ||
      at < now - ADVISOR_LIMITS.telemetryMaxAgeMs
    ) {
      return [];
    }
    return [
      {
        siteId,
        path: stripQuery(event.path),
        method: event.method.toUpperCase(),
        priceCents: event.priceCents,
        signal: event.signal,
        at: new Date(at),
        receivedAt: new Date(now),
      },
    ];
  });
  let rows = valid;
  if (rows.length) {
    // Rows received today have `at` no earlier than a day start minus the telemetry age limit,
    // so the (site, at) index bounds this count.
    const dayStart = utcDayStart(new Date(now)).getTime();
    const [today] = await db
      .select({ n: count() })
      .from(offerEvents)
      .innerJoin(sites, eq(sites.id, offerEvents.siteId))
      .where(
        and(
          eq(sites.ownerUserId, site.ownerUserId),
          gte(offerEvents.at, new Date(dayStart - ADVISOR_LIMITS.telemetryMaxAgeMs)),
          gte(offerEvents.receivedAt, new Date(dayStart)),
        ),
      );
    const room = Math.max(0, ADVISOR_LIMITS.maxOfferEventsPerOwnerPerDay - (today?.n ?? 0));
    rows = rows.slice(0, room);
  }
  if (rows.length) await db.insert(offerEvents).values(rows);
  return { ok: true, accepted: rows.length, dropped: parsed.data.events.length - rows.length };
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function stripQuery(path: string): string {
  return path.split(/[?#]/)[0] || "/";
}

export type RecordDeclineResult =
  | { ok: true; recorded: boolean; siteId: string; path: string }
  | {
      ok: false;
      reason: "invalid" | "unknown_key" | "unknown_site" | "rate_limited";
      message: string;
    };

/**
 * Stores an agent's note on why it did not buy an offer. The URL must be on a registered site
 * (matched by origin; the oldest site wins if several share one), and the note's price must be
 * what one of the site's pricing rules for that path charges now (an offer that exists). One note
 * per key, path (the query string is dropped) and UTC day, and at most
 * ADVISOR_LIMITS.maxDeclinesPerOwnerPathPerDay per agent owner, path and day across all of the
 * owner's keys: a note past either is accepted but not stored (`recorded: false`).
 */
export async function recordDecline(
  db: DbOrTx,
  input: { agentKeyId: string; note: DeclineNote | unknown; now?: Date },
): Promise<RecordDeclineResult> {
  const parsed = declineNoteSchema.safeParse(input.note);
  if (!parsed.success)
    return { ok: false, reason: "invalid", message: "Decline note is not valid" };
  const note = parsed.data;
  let url: URL;
  try {
    url = new URL(note.url);
  } catch {
    return { ok: false, reason: "invalid", message: "Decline URL is not valid" };
  }
  const now = input.now ?? new Date();

  const [key] = await db
    .select({ id: agentKeys.id, ownerUserId: agentKeys.ownerUserId })
    .from(agentKeys)
    .where(eq(agentKeys.id, input.agentKeyId));
  if (!key) return { ok: false, reason: "unknown_key", message: "Unknown agent key" };

  const [site] = await db
    .select({ id: sites.id, pricing: sites.pricing })
    .from(sites)
    .where(eq(sites.origin, url.origin))
    .orderBy(asc(sites.createdAt), asc(sites.id))
    .limit(1);
  if (!site) return { ok: false, reason: "unknown_site", message: "No BotFare site at this URL" };
  const path = url.pathname;
  const offered = site.pricing.some(
    (rule) => rule.priceCents === note.priceCents && matchesPattern(rule.pattern, path),
  );
  if (!offered) {
    return {
      ok: false,
      reason: "invalid",
      message: "This site has no offer at that price for this URL",
    };
  }

  const day = now.toISOString().slice(0, 10);
  const [today] = await db
    .select({ n: count() })
    .from(offerDeclines)
    .where(and(eq(offerDeclines.agentKeyId, key.id), eq(offerDeclines.day, day)));
  if ((today?.n ?? 0) >= ADVISOR_LIMITS.maxDeclinesPerKeyPerDay) {
    return {
      ok: false,
      reason: "rate_limited",
      message: `At most ${ADVISOR_LIMITS.maxDeclinesPerKeyPerDay} decline notes per agent key per day`,
    };
  }

  const [ownerToday] = await db
    .select({ n: count() })
    .from(offerDeclines)
    .innerJoin(agentKeys, eq(agentKeys.id, offerDeclines.agentKeyId))
    .where(
      and(
        eq(offerDeclines.siteId, site.id),
        eq(offerDeclines.path, path),
        eq(offerDeclines.day, day),
        eq(agentKeys.ownerUserId, key.ownerUserId),
      ),
    );
  if ((ownerToday?.n ?? 0) >= ADVISOR_LIMITS.maxDeclinesPerOwnerPathPerDay) {
    return { ok: true, recorded: false, siteId: site.id, path };
  }

  const inserted = await db
    .insert(offerDeclines)
    .values({
      agentKeyId: key.id,
      siteId: site.id,
      // Without the query string, so `?x=1`, `?x=2`, ... are one page (one note per key and day).
      url: `${url.origin}${url.pathname}`.slice(0, ADVISOR_LIMITS.maxUrlLength),
      path,
      priceCents: note.priceCents,
      category: note.category,
      reason: note.reason.trim(),
      day,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: offerDeclines.id });
  return { ok: true, recorded: inserted.length > 0, siteId: site.id, path };
}

export type RecordCitationsResult =
  | { ok: true; recorded: number; rejected: string[] }
  | { ok: false; reason: "invalid" | "unknown_key"; message: string };

/**
 * Stores which paid reads an answer cited. Only receipts paid by the reporting key's owner count
 * (others are returned in `rejected`). A new report with the same answer ID replaces that owner's
 * earlier one.
 */
export async function recordCitations(
  db: Db,
  input: { agentKeyId: string; report: CitationReport | unknown; now?: Date },
): Promise<RecordCitationsResult> {
  const parsed = citationReportSchema.safeParse(input.report);
  if (!parsed.success)
    return { ok: false, reason: "invalid", message: "Citation report is not valid" };
  const report = parsed.data;
  const [key] = await db
    .select({ id: agentKeys.id, ownerUserId: agentKeys.ownerUserId })
    .from(agentKeys)
    .where(eq(agentKeys.id, input.agentKeyId));
  if (!key) return { ok: false, reason: "unknown_key", message: "Unknown agent key" };

  const claims = new Map<string, string>();
  for (const citation of report.citations) {
    if (!claims.has(citation.receiptId)) claims.set(citation.receiptId, citation.claim.trim());
  }
  const owned = await db
    .select({ id: receipts.id, siteId: receipts.siteId })
    .from(receipts)
    .where(
      and(inArray(receipts.id, [...claims.keys()]), eq(receipts.ownerUserId, key.ownerUserId)),
    );
  const ownedIds = new Set(owned.map((r) => r.id));
  const rejected = [...claims.keys()].filter((id) => !ownedIds.has(id));
  if (owned.length === 0) return { ok: true, recorded: 0, rejected };

  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    await tx
      .delete(citations)
      .where(
        and(eq(citations.answerId, report.answerId), eq(citations.ownerUserId, key.ownerUserId)),
      );
    await tx.insert(citations).values(
      owned.map((receipt) => ({
        answerId: report.answerId,
        agentKeyId: key.id,
        ownerUserId: key.ownerUserId,
        receiptId: receipt.id,
        siteId: receipt.siteId,
        claim: claims.get(receipt.id) ?? "",
        createdAt: now,
      })),
    );
  });
  return { ok: true, recorded: owned.length, rejected };
}

// ---------------------------------------------------------------------------------------------
// What the advisor reads

export interface AdvisorCounters {
  /** Offers shown (402s reported by the middleware). */
  offers: number;
  /** Purchases (receipts, refunded ones included). */
  paid: number;
  /** Decline notes from agents. */
  declined: number;
  /** Citations of this page's receipts in agents' answers. */
  cited: number;
  /** Disputes, not counting invalid ones. */
  disputed: number;
  /** Gross cents of settled (not refunded) purchases. */
  revenueCents: number;
  /** Gross cents of refunded purchases, whatever refunded them (Fare Court or the publisher). */
  refundedCents: number;
  /** Cents refunded through Fare Court disputes only (the Disputes page's total). */
  disputeRefundedCents: number;
}

export interface AdvisorReason {
  reason: string;
  count: number;
}

export interface AdvisorStats extends AdvisorCounters {
  declinedByCategory: Partial<Record<DeclineCategory, number>>;
  /** Most frequent decline reasons (at most 5), case-insensitively grouped. */
  topReasons: AdvisorReason[];
  disputesByStatus: Partial<Record<DisputeRowStatus, number>>;
}

export interface AdvisorPathStats extends AdvisorStats {
  path: string;
}

/** Signals a rule's pages got while the rule had another price. */
export interface AdvisorEarlierSignals {
  /** The other prices, lowest first. */
  priceCents: number[];
  offers: number;
  paid: number;
  declined: number;
}

export interface AdvisorRuleStats extends AdvisorStats {
  pattern: string;
  method: string;
  /**
   * The rule's current price and audience. Every count of the rule and its paths is for this
   * price only: offers, declines and purchases at other prices are in `earlier`.
   */
  priceCents: number;
  audience: PricingRule["audience"];
  description: string | null;
  /** Busiest paths first. */
  paths: AdvisorPathStats[];
  /** Signals at earlier prices (after a price change), left out of the counts; null if none. */
  earlier: AdvisorEarlierSignals | null;
}

export interface AdvisorInputs {
  site: { id: string; name: string; origin: string; version: string };
  days: number;
  from: Date;
  to: Date;
  /** One entry per pricing rule, in rule order (first match wins). */
  rules: AdvisorRuleStats[];
  /** Paths with signals that match no current rule (or receipts without a URL, as "(unknown)"). */
  unpriced: AdvisorPathStats[];
  /** Every signal on the site in the window, at any price. */
  totals: AdvisorCounters;
}

const UNKNOWN_PATH = "(unknown)";

interface PathAccumulator {
  counters: AdvisorCounters;
  categories: Map<DeclineCategory, number>;
  reasons: Map<string, AdvisorReason>;
  disputeStatuses: Map<DisputeRowStatus, number>;
}

function emptyCounters(): AdvisorCounters {
  return {
    offers: 0,
    paid: 0,
    declined: 0,
    cited: 0,
    disputed: 0,
    revenueCents: 0,
    refundedCents: 0,
    disputeRefundedCents: 0,
  };
}

/**
 * Signals for one of the publisher's sites over the last `days` (default 14), per pricing rule and
 * per path. A rule counts only signals at its current price (the price stored with each offer,
 * decline and purchase), so after a price change it starts afresh; the rest is in its `earlier`.
 * Null when the site is not the publisher's.
 */
export async function advisorInputs(
  db: DbOrTx,
  input: { publisherUserId: string; siteId: string; days?: number; now?: Date },
): Promise<AdvisorInputs | null> {
  const [site] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.id, input.siteId), eq(sites.ownerUserId, input.publisherUserId)));
  if (!site) return null;
  const days = Math.min(Math.max(Math.trunc(input.days ?? 14), 1), ADVISOR_LIMITS.maxDays);
  const to = input.now ?? new Date();
  const from = new Date(to.getTime() - days * DAY_MS);

  const [offerRows, receiptRows, declineRows, citationRows, disputeRows] = await Promise.all([
    db
      .select({
        path: offerEvents.path,
        method: offerEvents.method,
        price: offerEvents.priceCents,
        n: count(),
      })
      .from(offerEvents)
      .where(and(eq(offerEvents.siteId, site.id), gte(offerEvents.at, from)))
      .groupBy(offerEvents.path, offerEvents.method, offerEvents.priceCents),
    db
      .select({
        url: receipts.resourceUrl,
        status: receipts.status,
        price: receipts.amountCents,
        n: count(),
      })
      .from(receipts)
      .where(and(eq(receipts.siteId, site.id), gte(receipts.createdAt, from)))
      .groupBy(receipts.resourceUrl, receipts.status, receipts.amountCents),
    db
      .select({
        path: offerDeclines.path,
        price: offerDeclines.priceCents,
        category: offerDeclines.category,
        reason: offerDeclines.reason,
        n: count(),
      })
      .from(offerDeclines)
      .where(and(eq(offerDeclines.siteId, site.id), gte(offerDeclines.createdAt, from)))
      .groupBy(
        offerDeclines.path,
        offerDeclines.priceCents,
        offerDeclines.category,
        offerDeclines.reason,
      )
      // Most frequent spelling first: it names the case-insensitive group.
      .orderBy(desc(count()), asc(offerDeclines.reason)),
    db
      .select({ url: receipts.resourceUrl, price: receipts.amountCents, n: count() })
      .from(citations)
      .innerJoin(receipts, eq(receipts.id, citations.receiptId))
      .where(and(eq(citations.siteId, site.id), gte(citations.createdAt, from)))
      .groupBy(receipts.resourceUrl, receipts.amountCents),
    db
      .select({
        url: receipts.resourceUrl,
        price: receipts.amountCents,
        status: disputes.status,
        n: count(),
        refunded: sql<string>`coalesce(sum(${disputes.refundedCents}), 0)`,
      })
      .from(disputes)
      .innerJoin(receipts, eq(receipts.id, disputes.receiptId))
      .where(and(eq(disputes.siteId, site.id), gte(disputes.createdAt, from)))
      .groupBy(receipts.resourceUrl, receipts.amountCents, disputes.status),
  ]);

  // Per (rule index or -1, path, current price or not), so a path offered under two methods lands
  // under each rule, and signals from before a price change stay apart from the rule's counts.
  interface Bucket {
    path: string;
    rule: number;
    /** Price of these signals when they are not the rule's current price; null otherwise. */
    earlierPrice: number | null;
    acc: PathAccumulator;
  }
  const buckets = new Map<string, Bucket>();
  const bucket = (path: string, priceCents: number, method?: string) => {
    const rule = path === UNKNOWN_PATH ? -1 : ruleIndex(site.pricing, path, method);
    const current = rule < 0 || site.pricing[rule]?.priceCents === priceCents;
    const earlierPrice = current ? null : priceCents;
    const id = `${rule}\u0000${path}\u0000${earlierPrice ?? ""}`;
    let entry = buckets.get(id);
    if (!entry) {
      entry = {
        path,
        rule,
        earlierPrice,
        acc: {
          counters: emptyCounters(),
          categories: new Map(),
          reasons: new Map(),
          disputeStatuses: new Map(),
        },
      };
      buckets.set(id, entry);
    }
    return entry.acc;
  };

  for (const row of offerRows) bucket(row.path, row.price, row.method).counters.offers += row.n;
  for (const row of receiptRows) {
    const acc = bucket(pathOf(row.url), row.price).counters;
    acc.paid += row.n;
    if (row.status === "settled") acc.revenueCents += row.n * row.price;
    else acc.refundedCents += row.n * row.price;
  }
  for (const row of declineRows) {
    const acc = bucket(row.path, row.price);
    acc.counters.declined += row.n;
    addReason(acc, row.category, row.reason, row.n);
  }
  for (const row of citationRows) bucket(pathOf(row.url), row.price).counters.cited += row.n;
  for (const row of disputeRows) {
    const acc = bucket(pathOf(row.url), row.price);
    if (row.status !== "invalid") acc.counters.disputed += row.n;
    if (row.status === "refunded") acc.counters.disputeRefundedCents += Number(row.refunded);
    acc.disputeStatuses.set(row.status, (acc.disputeStatuses.get(row.status) ?? 0) + row.n);
  }

  const rules: AdvisorRuleStats[] = site.pricing.map((rule, index) => {
    const mine = [...buckets.values()].filter((b) => b.rule === index);
    const entries = mine.filter((b) => b.earlierPrice === null);
    const paths = entries.map((b) => pathStats(b.path, b.acc)).sort(byActivity);
    const stale = mine.filter((b) => b.earlierPrice !== null);
    const staleCounts = merge(stale.map((b) => b.acc)).counters;
    return {
      pattern: rule.pattern,
      method: rule.method,
      priceCents: rule.priceCents,
      audience: rule.audience,
      description: rule.description ?? null,
      ...stats(merge(entries.map((b) => b.acc))),
      paths,
      earlier:
        stale.length === 0
          ? null
          : {
              priceCents: [...new Set(stale.map((b) => b.earlierPrice as number))].sort(
                (a, b) => a - b,
              ),
              offers: staleCounts.offers,
              paid: staleCounts.paid,
              declined: staleCounts.declined,
            },
    };
  });
  const unpricedEntries = [...buckets.values()].filter((b) => b.rule === -1);
  return {
    site: { id: site.id, name: site.name, origin: site.origin, version: site.version },
    days,
    from,
    to,
    rules,
    unpriced: unpricedEntries.map((b) => pathStats(b.path, b.acc)).sort(byActivity),
    totals: merge([...buckets.values()].map((b) => b.acc)).counters,
  };
}

/** First rule for the path (same method when known), as the middleware matches; -1 for none. */
function ruleIndex(pricing: PricingRule[], path: string, method?: string): number {
  const upper = method?.toUpperCase();
  return pricing.findIndex(
    (rule) => (!upper || rule.method === upper) && matchesPattern(rule.pattern, path),
  );
}

function pathOf(url: string | null): string {
  if (!url) return UNKNOWN_PATH;
  try {
    return new URL(url).pathname;
  } catch {
    return UNKNOWN_PATH;
  }
}

function addReason(acc: PathAccumulator, category: DeclineCategory, reason: string, n: number) {
  acc.categories.set(category, (acc.categories.get(category) ?? 0) + n);
  const key = reason.trim().toLowerCase();
  const existing = acc.reasons.get(key);
  if (existing) existing.count += n;
  else acc.reasons.set(key, { reason: reason.trim(), count: n });
}

function merge(accs: PathAccumulator[]): PathAccumulator {
  const out: PathAccumulator = {
    counters: emptyCounters(),
    categories: new Map(),
    reasons: new Map(),
    disputeStatuses: new Map(),
  };
  for (const acc of accs) {
    for (const key of Object.keys(out.counters) as (keyof AdvisorCounters)[]) {
      out.counters[key] += acc.counters[key];
    }
    for (const [category, n] of acc.categories) {
      out.categories.set(category, (out.categories.get(category) ?? 0) + n);
    }
    for (const [key, reason] of acc.reasons) {
      const existing = out.reasons.get(key);
      if (existing) existing.count += reason.count;
      else out.reasons.set(key, { ...reason });
    }
    for (const [status, n] of acc.disputeStatuses) {
      out.disputeStatuses.set(status, (out.disputeStatuses.get(status) ?? 0) + n);
    }
  }
  return out;
}

function stats(acc: PathAccumulator): AdvisorStats {
  return {
    ...acc.counters,
    declinedByCategory: Object.fromEntries(acc.categories),
    topReasons: [...acc.reasons.values()]
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 5),
    disputesByStatus: Object.fromEntries(acc.disputeStatuses),
  };
}

function pathStats(path: string, acc: PathAccumulator): AdvisorPathStats {
  return { path, ...stats(acc) };
}

function byActivity(a: AdvisorPathStats, b: AdvisorPathStats): number {
  return (
    b.offers + b.paid + b.declined - (a.offers + a.paid + a.declined) ||
    a.path.localeCompare(b.path)
  );
}

// ---------------------------------------------------------------------------------------------
// The one write: a publisher applies a recommendation

export type ApplyPriceChangeResult =
  | {
      ok: true;
      site: Site;
      /** The matching rules before and after (one per method with this pattern). */
      before: PricingRule[];
      after: PricingRule[];
      /** False when the rules already had these values (the config version is unchanged). */
      changed: boolean;
    }
  | {
      ok: false;
      reason: "not_found" | "unknown_pattern" | "nothing_to_change" | "invalid";
      message: string;
    };

/**
 * Sets the price and/or audience of the publisher's pricing rule(s) with exactly this pattern (and
 * method, when given), and bumps the site's config version so the middleware picks it up. Unknown
 * patterns are refused. On the shared demo site the persona may change prices like anyone; the
 * next persona sign-in restores them (resetDemoPublisher).
 */
export async function applyPriceChange(
  db: Db,
  input: {
    siteId: string;
    ownerUserId: string;
    pattern: string;
    method?: string;
    priceCents?: number;
    audience?: PricingRule["audience"];
  },
): Promise<ApplyPriceChangeResult> {
  if (input.priceCents === undefined && input.audience === undefined) {
    return { ok: false, reason: "nothing_to_change", message: "Give a price or an audience" };
  }
  const priceCheck = pricingRuleSchema.shape.priceCents.safeParse(input.priceCents ?? 1);
  const audienceCheck = pricingRuleSchema.shape.audience.safeParse(input.audience ?? "agents");
  if (!priceCheck.success || !audienceCheck.success) {
    return {
      ok: false,
      reason: "invalid",
      message: "Price must be whole cents from 1 to 10000; audience agents or everyone",
    };
  }
  const method = input.method?.toUpperCase();

  return db.transaction(async (tx): Promise<ApplyPriceChangeResult> => {
    const [site] = await tx
      .select()
      .from(sites)
      .where(and(eq(sites.id, input.siteId), eq(sites.ownerUserId, input.ownerUserId)))
      .for("update");
    if (!site) return { ok: false, reason: "not_found", message: "No such site" };

    const matches = (rule: PricingRule) =>
      rule.pattern === input.pattern && (!method || rule.method === method);
    const before = site.pricing.filter(matches);
    if (before.length === 0) {
      return {
        ok: false,
        reason: "unknown_pattern",
        message: `No pricing rule with pattern ${input.pattern}`,
      };
    }
    const pricing = site.pricing.map((rule) =>
      matches(rule)
        ? {
            ...rule,
            ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
            ...(input.audience !== undefined ? { audience: input.audience } : {}),
          }
        : rule,
    );
    const after = pricing.filter(matches);
    const changed = before.some(
      (rule, i) => rule.priceCents !== after[i]?.priceCents || rule.audience !== after[i]?.audience,
    );
    if (!changed) return { ok: true, site, before, after, changed: false };

    const updated = await updateSitePricing(tx, {
      siteId: site.id,
      ownerUserId: input.ownerUserId,
      pricing,
    });
    if (!updated) throw new Error(`Site ${site.id} vanished while changing its price`);
    return {
      ok: true,
      site: updated,
      before,
      after: updated.pricing.filter(matches),
      changed: true,
    };
  });
}
