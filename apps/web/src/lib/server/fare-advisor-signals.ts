import { recordCitations, recordDecline, recordOfferTelemetry } from "@botfare/core";
import { z } from "zod";
import { authenticateAgent } from "./agent-auth";
import { TurnLimiter } from "./ai-budget";
import { authenticateSiteRequest, unauthorized } from "./auth";
import { getDb } from "./db";
import { jsonError, readLimitedJson } from "./http";

/**
 * Fare Advisor's three ingestion endpoints: what publisher middleware and agents report.
 *
 * - POST /api/x402/telemetry (site Basic auth): batched "offer shown" events (402s).
 * - POST /api/offers/decline (agent Web Bot Auth): a free note on why an offer was not bought.
 * - POST /api/citations (agent Web Bot Auth): which paid reads an answer actually cited.
 *
 * Bodies are read with a hard byte cap, shapes are validated by core (contracts' zod schemas), and
 * each site or key has a per-minute limit in memory (one web instance; core's per-day limits and
 * the batch caps are the durable backstop).
 */

const MINUTE_MS = 60_000;

/** Byte caps on request bodies. A 500-event telemetry batch is about 75 KB. */
export const SIGNAL_BODY_LIMITS = {
  telemetry: 256_000,
  decline: 8_000,
  citations: 32_000,
} as const;

/** Requests per minute per site (telemetry) or agent key (declines, citations). */
export const SIGNAL_RATE_LIMITS = {
  /** The middleware flushes every 15 s or at 200 events, so 60 a minute is a busy site. */
  telemetryPerSite: 60,
  declinesPerKey: 60,
  citationsPerKey: 30,
} as const;

interface Limiters {
  telemetry: TurnLimiter;
  declines: TurnLimiter;
  citations: TurnLimiter;
}

const globalForLimits = globalThis as typeof globalThis & { __botfareSignalLimits?: Limiters };

function limiters(): Limiters {
  globalForLimits.__botfareSignalLimits ??= {
    telemetry: new TurnLimiter(SIGNAL_RATE_LIMITS.telemetryPerSite, MINUTE_MS),
    declines: new TurnLimiter(SIGNAL_RATE_LIMITS.declinesPerKey, MINUTE_MS),
    citations: new TurnLimiter(SIGNAL_RATE_LIMITS.citationsPerKey, MINUTE_MS),
  };
  return globalForLimits.__botfareSignalLimits;
}

/** Forgets every per-minute count (tests). */
export function resetSignalLimits(): void {
  globalForLimits.__botfareSignalLimits = undefined;
}

function rateLimited(message: string): Response {
  return jsonError(429, "rate_limited", message, { "retry-after": "60" });
}

const NO_STORE = { "cache-control": "no-store" } as const;

/** Any JSON; core validates the shape and says what is wrong. */
const anyJson = z.unknown();

/** POST /api/x402/telemetry: a batch of offer-shown events from the site's middleware. */
export async function handleOfferTelemetry(request: Request): Promise<Response> {
  const site = await authenticateSiteRequest(request);
  if (!site) return unauthorized();
  if (!limiters().telemetry.allow(site.id)) {
    return rateLimited(
      `At most ${SIGNAL_RATE_LIMITS.telemetryPerSite} telemetry batches per minute per site`,
    );
  }
  const body = await readLimitedJson(request, anyJson, SIGNAL_BODY_LIMITS.telemetry);
  if (!body.ok) return body.response;
  try {
    const result = await recordOfferTelemetry(getDb(), site.id, body.data);
    if (!result.ok) {
      return result.reason === "not_found"
        ? jsonError(404, "not_found", result.message)
        : jsonError(400, "invalid_request", result.message);
    }
    return Response.json(
      { ok: true, accepted: result.accepted, dropped: result.dropped },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[advisor] telemetry:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}

/** POST /api/offers/decline: an agent's note on why it did not buy an offer. */
export async function handleDeclineNote(request: Request): Promise<Response> {
  const db = getDb();
  const auth = await authenticateAgent(db, request);
  if (!auth.ok) return auth.response;
  const { key } = auth;
  if (!limiters().declines.allow(key.id)) {
    return rateLimited(
      `At most ${SIGNAL_RATE_LIMITS.declinesPerKey} decline notes per minute per agent key`,
    );
  }
  const body = await readLimitedJson(request, anyJson, SIGNAL_BODY_LIMITS.decline);
  if (!body.ok) return body.response;
  try {
    const result = await recordDecline(db, { agentKeyId: key.id, note: body.data });
    if (!result.ok) {
      switch (result.reason) {
        case "invalid":
          return jsonError(400, "invalid_request", result.message);
        case "unknown_site":
          return jsonError(422, "unknown_site", result.message);
        case "rate_limited":
          return rateLimited(result.message);
        default:
          return jsonError(401, "unauthorized", result.message);
      }
    }
    return Response.json(
      { ok: true, recorded: result.recorded, path: result.path },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[advisor] decline:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}

/** POST /api/citations: which of the key owner's paid reads an answer cited. */
export async function handleCitationReport(request: Request): Promise<Response> {
  const db = getDb();
  const auth = await authenticateAgent(db, request);
  if (!auth.ok) return auth.response;
  const { key } = auth;
  if (!limiters().citations.allow(key.id)) {
    return rateLimited(
      `At most ${SIGNAL_RATE_LIMITS.citationsPerKey} citation reports per minute per agent key`,
    );
  }
  const body = await readLimitedJson(request, anyJson, SIGNAL_BODY_LIMITS.citations);
  if (!body.ok) return body.response;
  try {
    const result = await recordCitations(db, { agentKeyId: key.id, report: body.data });
    if (!result.ok) {
      return result.reason === "invalid"
        ? jsonError(400, "invalid_request", result.message)
        : jsonError(401, "unauthorized", result.message);
    }
    return Response.json(
      { ok: true, recorded: result.recorded, rejected: result.rejected },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[advisor] citations:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}
