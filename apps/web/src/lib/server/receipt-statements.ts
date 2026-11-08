import { IdPrefix } from "@botfare/contracts";
import { getReceiptKeyring, getReceiptStatements, receiptJwks } from "@botfare/core";
import { clientIp, TurnLimiter } from "./ai-budget";
import { getDb } from "./db";
import { jsonError } from "./http";

/**
 * Signed receipts, public side (decision 18):
 *
 * - GET RECEIPT_KEYS_PATH: the JWKS of BotFare's receipt-signing public keys (the active key and
 *   retired ones), so anyone can verify a statement offline.
 * - GET receiptStatementsPath(id): the signed payment, delivery and refund statements of a receipt.
 *   Missing statements the receipt qualifies for (an issuing failure) are issued on read.
 *
 * Both are public and CORS-open; statements carry only pseudonymous IDs (site, agent key, receipt).
 */

/** Verifiers may cache the key set this long; rotation keeps the old key published anyway. */
export const RECEIPT_KEYS_MAX_AGE_SECONDS = 300;

/** Statement lookups per minute per client IP (a 20-source answer needs 20). */
export const STATEMENT_LOOKUPS_PER_MINUTE = 120;

const CORS = { "access-control-allow-origin": "*" } as const;

const globalForLimits = globalThis as typeof globalThis & {
  __botfareStatementLimiter?: TurnLimiter;
};

function limiter(): TurnLimiter {
  globalForLimits.__botfareStatementLimiter ??= new TurnLimiter(
    STATEMENT_LOOKUPS_PER_MINUTE,
    60_000,
  );
  return globalForLimits.__botfareStatementLimiter;
}

/** Forgets the per-minute counts (tests). */
export function resetStatementLimits(): void {
  globalForLimits.__botfareStatementLimiter = undefined;
}

/** GET /.well-known/botfare-receipt-keys.json */
export async function handleReceiptKeys(): Promise<Response> {
  const jwks = receiptJwks(await getReceiptKeyring());
  return new Response(JSON.stringify(jwks), {
    headers: {
      "content-type": "application/jwk-set+json",
      "cache-control": `public, max-age=${jwks.keys.length > 0 ? RECEIPT_KEYS_MAX_AGE_SECONDS : 30}`,
      ...CORS,
    },
  });
}

const RECEIPT_ID = new RegExp(`^${IdPrefix.receipt}_[A-Za-z0-9_-]{1,64}$`);

/** GET /api/receipts/:receiptId/statements */
export async function handleReceiptStatements(
  request: Request,
  receiptId: string,
): Promise<Response> {
  const noStore = { "cache-control": "no-store", ...CORS };
  if (!limiter().allow(clientIp(request))) {
    return jsonError(
      429,
      "rate_limited",
      `At most ${STATEMENT_LOOKUPS_PER_MINUTE} receipt lookups per minute`,
      { ...noStore, "retry-after": "60" },
    );
  }
  if (!RECEIPT_ID.test(receiptId)) {
    return jsonError(404, "not_found", "No such receipt", noStore);
  }
  try {
    const statements = await getReceiptStatements(getDb(), receiptId, { issueMissing: true });
    if (!statements) return jsonError(404, "not_found", "No such receipt", noStore);
    return Response.json(statements, { headers: noStore });
  } catch (err) {
    console.error(`[receipts] statements lookup failed for ${receiptId}:`, (err as Error).message);
    return jsonError(503, "unavailable", "Receipt statements are temporarily unavailable", noStore);
  }
}
