import "server-only";
import {
  DEMO_PERSONAS,
  DEMO_SITE_FREE_PATHS,
  DEMO_SITE_NAME,
  DEMO_SITE_PRICING,
  findPricingRule,
  LEGACY_DEMO_PUBLISHER_EMAILS,
  LEGACY_DEMO_SITE_NAMES,
} from "@botfare/contracts";
import { type DbHandle, getReceiptKeyring, receiptJwks } from "@botfare/core";
import { getDbHandle } from "./db";

/**
 * The sample receipt /verify puts in its input when the link names none, so a visitor can verify a
 * real receipt without hunting for an ID. Nothing is checked until they press Verify.
 *
 * It comes from Saffron & Salt, the seeded demo site: the publisher persona's oldest site named
 * DEMO_SITE_NAME, or, on a database seeded before the rename, its oldest site under a name in
 * LEGACY_DEMO_SITE_NAMES (the persona's email may still be one of LEGACY_DEMO_PUBLISHER_EMAILS).
 * Its receipts are real ledger charges, signed as they settled: agents paying apps/demo (only the
 * demo server holds the site's secret) and seed:traffic's demo traffic. The receipt must be:
 *
 * - settled, never refunded, with no refund statement and no dispute of any status;
 * - signed: its payment statement by a key in today's public JWKS, so it verifies in the browser;
 * - for a URL with no query string or fragment (the buyer picks those, and every visitor sees the
 *   sample), and not the Fare Court stub recipe (paying agents get a subscribe stub there);
 * - for a path the demo still prices today, so the page link works (receipts from an earlier demo
 *   site, such as Crema Notes' /articles/*, are skipped).
 *
 * Two tiers, newest first in each. A fully attested receipt (a delivery statement signed by a
 * published key too) always wins. Only when there is none does a receipt with a payment statement
 * and no delivery statement at all qualify: seed:traffic purchases look like that (it attests only
 * its Fare Court stub purchases, which never qualify). Within a tier a page (a recipe, technique,
 * meal plan or cookbook chapter) is preferred over the nutrition API.
 *
 * Statements are public already (GET /api/receipts/:id/statements); this returns only an ID. The
 * lookup is cached in memory for EXAMPLE_CACHE_MS and gives up after LOOKUP_TIMEOUT_MS, so /verify
 * stays one cheap render. Any failure means no sample: the page then renders as it always did.
 */

/** apps/demo's FARE_COURT_STUB_PATH: paying agents are served a subscribe stub there. */
export const FARE_COURT_STUB_PATH = "/recipes/sourdough-starter";

/** Paths under this prefix are the demo's paid APIs; any other path is a page. */
const API_PREFIX = "/api/";

export const EXAMPLE_CACHE_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;
/**
 * Newest qualifying receipts read per tier; the path filters run on these. Generous, so a backlog
 * of an earlier demo site's receipts cannot hide the current ones.
 */
const CANDIDATES = 500;

type Sql = DbHandle["sql"];

export interface ExampleQuery {
  /** kids of the public JWKS: every statement the sample has must be signed by one of these keys. */
  kids: readonly string[];
  /** Owner of the demo site (the publisher persona by default; tests use their own user). */
  publisherEmail?: string;
  /** The owner's earlier emails (LEGACY_DEMO_PUBLISHER_EMAILS by default; tests use their own). */
  legacyEmails?: readonly string[];
}

/**
 * The URL's path, or null when it does not parse or carries a query or fragment. Whoever buys
 * chooses the query string, and the sample is shown to every visitor, so only plain paths qualify.
 */
function plainPathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.search || parsed.hash) return null;
    return parsed.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

/**
 * The demo site's ID: a site named DEMO_SITE_NAME before one under a legacy name, the persona's
 * current email before a legacy one, then the oldest. Null when there is none.
 */
async function findDemoSiteId(
  sql: Sql,
  email: string,
  legacyEmails: readonly string[],
): Promise<string | null> {
  const [site] = await sql<{ id: string }[]>`
    select s.id
    from sites s
    join users u on u.id = s.owner_user_id
    where u.email in ${sql([...new Set([email, ...legacyEmails])])}
      and s.name in ${sql([DEMO_SITE_NAME, ...LEGACY_DEMO_SITE_NAMES])}
    order by (s.name = ${DEMO_SITE_NAME}) desc, (u.email = ${email}) desc, s.created_at, s.id
    limit 1
  `;
  return site?.id ?? null;
}

/**
 * The best receipt of one tier: attested (payment and delivery statements, both signed by a
 * published key) or paid (a payment statement signed by a published key and no delivery statement,
 * so nothing on the page fails to verify).
 */
async function findInTier(
  sql: Sql,
  siteId: string,
  kids: readonly string[],
  tier: "attested" | "paid",
): Promise<string | null> {
  const delivery =
    tier === "attested"
      ? sql`exists (
          select 1 from receipt_statements d
          where d.receipt_id = r.id and d.kind = 'delivery' and d.kid in ${sql(kids)}
        )`
      : sql`not exists (
          select 1 from receipt_statements d where d.receipt_id = r.id and d.kind = 'delivery'
        )`;
  const rows = await sql<{ id: string; resource_url: string }[]>`
    select r.id, r.resource_url
    from receipts r
    where r.site_id = ${siteId}
      and r.status = 'settled'
      and r.refund_transaction_id is null
      and r.resource_url is not null
      and exists (
        select 1 from receipt_statements p
        where p.receipt_id = r.id and p.kind = 'payment' and p.kid in ${sql(kids)}
      )
      and ${delivery}
      and not exists (
        select 1 from receipt_statements x where x.receipt_id = r.id and x.kind = 'refund'
      )
      and not exists (select 1 from disputes dp where dp.receipt_id = r.id)
    order by r.created_at desc, r.id desc
    limit ${CANDIDATES}
  `;

  const demo = { pricing: DEMO_SITE_PRICING, freePaths: DEMO_SITE_FREE_PATHS };
  const candidates = rows.flatMap((row) => {
    const path = plainPathOf(row.resource_url);
    return path !== null &&
      path !== FARE_COURT_STUB_PATH &&
      findPricingRule(demo, "GET", path) !== undefined
      ? [{ id: row.id, path }]
      : [];
  });
  const page = candidates.find((candidate) => !candidate.path.startsWith(API_PREFIX));
  return (page ?? candidates[0])?.id ?? null;
}

/**
 * The sample receipt's ID: the best attested purchase on the demo site, else the best purchase
 * with only a payment statement. Null when the demo site has neither.
 */
export async function findExampleReceiptId(sql: Sql, query: ExampleQuery): Promise<string | null> {
  const kids = [...new Set(query.kids)];
  if (kids.length === 0) return null;
  const siteId = await findDemoSiteId(
    sql,
    query.publisherEmail ?? DEMO_PERSONAS.publisher.email,
    query.legacyEmails ?? LEGACY_DEMO_PUBLISHER_EMAILS,
  );
  if (!siteId) return null;
  return (
    (await findInTier(sql, siteId, kids, "attested")) ??
    (await findInTier(sql, siteId, kids, "paid"))
  );
}

interface CachedExample {
  key: string;
  value: string | null;
  expiresAt: number;
}

const globalForExample = globalThis as typeof globalThis & {
  __botfareVerifyExample?: CachedExample;
};

/** Forgets the cached sample (tests). */
export function resetExampleReceiptCache(): void {
  globalForExample.__botfareVerifyExample = undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The sample receipt for /verify (cached for EXAMPLE_CACHE_MS). Null when there is none or the
 * lookup failed; a failure is logged and not cached.
 */
export async function exampleReceiptId(
  options: { publisherEmail?: string; now?: () => number } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const key = options.publisherEmail ?? DEMO_PERSONAS.publisher.email;
  const cached = globalForExample.__botfareVerifyExample;
  if (cached && cached.key === key && cached.expiresAt > now()) return cached.value;

  try {
    const value = await withTimeout(
      (async () => {
        const kids = receiptJwks(await getReceiptKeyring()).keys.flatMap((jwk) =>
          typeof jwk.kid === "string" ? [jwk.kid] : [],
        );
        return findExampleReceiptId(getDbHandle().sql, { kids, publisherEmail: key });
      })(),
      LOOKUP_TIMEOUT_MS,
    );
    globalForExample.__botfareVerifyExample = {
      key,
      value,
      expiresAt: now() + EXAMPLE_CACHE_MS,
    };
    return value;
  } catch (err) {
    console.error("[verify] example receipt lookup failed:", (err as Error).message);
    return null;
  }
}
