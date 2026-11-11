import "server-only";
import { DEMO_PERSONAS, DEMO_SITE_NAME } from "@botfare/contracts";
import { type DbHandle, getReceiptKeyring, receiptJwks } from "@botfare/core";
import { getDbHandle } from "./db";

/**
 * The receipt /verify opens with when the link names none, so a visitor sees a real verified
 * receipt without hunting for an ID.
 *
 * It is the latest clean purchase on Crema Notes, the seeded demo site (the oldest site named
 * DEMO_SITE_NAME owned by the publisher persona, as core's judge-mode reset finds it; only the demo
 * server holds its secret, so every receipt on it is a real purchase from apps/demo):
 *
 * - settled, never refunded, no refund statement and no dispute of any status;
 * - a payment and a delivery statement stored, both signed by a key in today's public JWKS, so the
 *   example verifies in the browser;
 * - a resource URL with no query string or fragment (the buyer picks those, and every visitor sees
 *   the example), and not the Fare Court stub article (paying agents get a subscribe stub there);
 *   an article is preferred over the brew-ratio API.
 *
 * Statements are public already (GET /api/receipts/:id/statements); this returns only an ID. The
 * lookup is cached in memory for EXAMPLE_CACHE_MS and gives up after LOOKUP_TIMEOUT_MS, so /verify
 * stays one cheap render. Any failure means no example: the page then renders as it always did.
 */

/** apps/demo's FARE_COURT_STUB_SLUG as a path: paying agents are served a subscribe stub there. */
export const FARE_COURT_STUB_PATH = "/articles/grinder-maintenance";

export const EXAMPLE_CACHE_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 2_000;
/** Newest qualifying receipts read per lookup; the stub filter runs on these. */
const CANDIDATES = 25;

type Sql = DbHandle["sql"];

export interface ExampleQuery {
  /** kids of the public JWKS: both statements must be signed by one of these keys. */
  kids: readonly string[];
  /** Owner of the demo site (the publisher persona by default; tests use their own user). */
  publisherEmail?: string;
}

/**
 * The URL's path, or null when it does not parse or carries a query or fragment. Whoever buys
 * chooses the query string, and the example is shown to every visitor, so only plain paths qualify.
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

/** The example receipt's ID, or null when the demo site has no clean, attested purchase. */
export async function findExampleReceiptId(sql: Sql, query: ExampleQuery): Promise<string | null> {
  const kids = [...new Set(query.kids)];
  if (kids.length === 0) return null;
  const email = query.publisherEmail ?? DEMO_PERSONAS.publisher.email;

  const rows = await sql<{ id: string; resource_url: string }[]>`
    with demo_site as (
      select s.id
      from sites s
      join users u on u.id = s.owner_user_id
      where u.email = ${email} and s.name = ${DEMO_SITE_NAME}
      order by s.created_at, s.id
      limit 1
    )
    select r.id, r.resource_url
    from receipts r
    where r.site_id = (select id from demo_site)
      and r.status = 'settled'
      and r.refund_transaction_id is null
      and r.resource_url is not null
      and exists (
        select 1 from receipt_statements p
        where p.receipt_id = r.id and p.kind = 'payment' and p.kid in ${sql(kids)}
      )
      and exists (
        select 1 from receipt_statements d
        where d.receipt_id = r.id and d.kind = 'delivery' and d.kid in ${sql(kids)}
      )
      and not exists (
        select 1 from receipt_statements x where x.receipt_id = r.id and x.kind = 'refund'
      )
      and not exists (select 1 from disputes dp where dp.receipt_id = r.id)
    order by r.created_at desc, r.id desc
    limit ${CANDIDATES}
  `;

  const candidates = rows.filter((row) => {
    const path = plainPathOf(row.resource_url);
    return path !== null && path !== FARE_COURT_STUB_PATH;
  });
  const article = candidates.find((row) => plainPathOf(row.resource_url)?.startsWith("/articles/"));
  return (article ?? candidates[0])?.id ?? null;
}

interface CachedExample {
  key: string;
  value: string | null;
  expiresAt: number;
}

const globalForExample = globalThis as typeof globalThis & {
  __botfareVerifyExample?: CachedExample;
};

/** Forgets the cached example (tests). */
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
 * The example receipt for /verify (cached for EXAMPLE_CACHE_MS). Null when there is none or the
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
