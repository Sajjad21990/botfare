import "server-only";
import { Buffer } from "node:buffer";
import {
  type DisputeOutcome,
  disputeRequestSchema,
  MAX_DISPUTE_CONTENT_BYTES,
} from "@botfare/contracts/fare";
import {
  applyVerdict,
  attestReceipt,
  type DisputeListRow,
  listDisputesForOwner,
  listDisputesForPublisher,
  openDispute,
  pendingDisputeCount,
  publisherDecide,
  toDisputeOutcome,
} from "@botfare/core";
import { z } from "zod";
import { authenticateAgent } from "./agent-auth";
import { authenticateSiteRequest, unauthorized } from "./auth";
import { getDb } from "./db";
import { currentJudge, explainOutcome, judgeDispute } from "./fare-court";
import { jsonError, readLimitedJson } from "./http";
import { receiptPath } from "./wallet";

/**
 * Fare Court's HTTP side: the publisher's proof of delivery, the agent's dispute, and the
 * publisher's review. Policy lives in core (openDispute, applyVerdict, publisherDecide); this module
 * authenticates, parses, runs the judge between openDispute and applyVerdict, and shapes answers.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

/** A dispute body: the base64 content plus a little JSON around it. */
const MAX_DISPUTE_BODY_BYTES = Math.ceil(MAX_DISPUTE_CONTENT_BYTES / 3) * 4 + 4_096;
const MAX_ATTESTATION_BODY_BYTES = 4_096;

// ---------------------------------------------------------------------------------------------
// POST /api/x402/receipts/:id/attest (site Basic auth)

const attestationBodySchema = z.unknown();

/**
 * The paid site's attestation of the body it delivered for a receipt. 200 on the first one and on
 * an identical repeat (`alreadyAttested`), 409 for a different digest, 404 for another site's
 * receipt. The middleware retries only 5xx, 408, 429 and network errors.
 */
export async function handleAttest(request: Request, receiptId: string): Promise<Response> {
  const site = await authenticateSiteRequest(request);
  if (!site) return unauthorized();
  const body = await readLimitedJson(request, attestationBodySchema, MAX_ATTESTATION_BODY_BYTES);
  if (!body.ok) return body.response;
  try {
    const result = await attestReceipt(getDb(), {
      siteId: site.id,
      receiptId,
      attestation: body.data,
    });
    if (!result.ok) {
      const status = result.reason === "invalid" ? 400 : result.reason === "not_found" ? 404 : 409;
      return jsonError(status, result.reason, result.message);
    }
    return Response.json(
      {
        ok: true,
        receiptId: result.receipt.id,
        contentDigest: result.receipt.contentDigest,
        alreadyAttested: result.alreadyAttested,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[fare-court] attest:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}

// ---------------------------------------------------------------------------------------------
// POST /api/disputes (agent Web Bot Auth)

const REFUSAL_STATUS: Record<string, number> = {
  invalid_request: 400,
  content_too_large: 413,
  not_found: 404,
  already_refunded: 409,
  already_open: 409,
  already_decided: 409,
  rate_limited: 429,
  not_attested: 409,
  window_closed: 422,
  digest_mismatch: 422,
};

function outcomeResponse(outcome: DisputeOutcome, status = 200): Response {
  return Response.json(outcome, { status, headers: NO_STORE });
}

/**
 * Files a dispute for the signing agent key. Answers with a DisputeOutcome whenever a dispute
 * exists (a new one, an invalid one, or the one already open or decided for the receipt), so the
 * SDK can read the outcome at any status; otherwise `{ error, message }`. A receipt without the
 * publisher's attestation yet answers `{ error: "not_attested" }`, which the SDK re-files.
 */
export async function handleDispute(request: Request): Promise<Response> {
  const db = getDb();
  const auth = await authenticateAgent(db, request);
  if (!auth.ok) return auth.response;
  const body = await readLimitedJson(request, disputeRequestSchema, MAX_DISPUTE_BODY_BYTES);
  if (!body.ok) return body.response;

  const bytes = new Uint8Array(Buffer.from(body.data.contentBase64, "base64"));
  if (bytes.length > MAX_DISPUTE_CONTENT_BYTES) {
    return jsonError(
      413,
      "content_too_large",
      `Delivered content is over ${MAX_DISPUTE_CONTENT_BYTES} bytes`,
    );
  }

  try {
    const opened = await openDispute(db, {
      agentKeyId: auth.key.id,
      request: body.data,
      contentBytes: bytes,
    });
    if (!opened.ok) {
      const status = REFUSAL_STATUS[opened.reason] ?? 400;
      console.info(
        `[fare-court] dispute refused ${auth.key.id} ${body.data.receiptId} ${opened.reason}`,
      );
      if (opened.dispute) return outcomeResponse(toDisputeOutcome(opened.dispute), status);
      return Response.json(
        { error: opened.reason, reason: opened.reason, message: opened.message },
        { status, headers: NO_STORE },
      );
    }

    const started = Date.now();
    const judged = await judgeDispute(opened.judgeInput, currentJudge());
    const decided = await applyVerdict(db, {
      disputeId: opened.dispute.id,
      verdict: judged.verdict,
      autoAllowed: opened.autoAllowed,
    });
    console.info(
      `[fare-court] dispute ${opened.dispute.id} ${body.data.receiptId} judge=${judged.source} ` +
        `decision=${judged.verdict?.decision ?? "none"} attempts=${judged.attempts} ` +
        `status=${decided.ok ? decided.outcome.status : decided.reason} ${Date.now() - started}ms`,
    );
    if (!decided.ok) {
      // The dispute was just created, so only a lost row lands here.
      return decided.outcome
        ? outcomeResponse(decided.outcome, 409)
        : jsonError(500, "internal_error", decided.message);
    }
    return outcomeResponse(explainOutcome(decided.outcome, judged));
  } catch (err) {
    console.error("[fare-court] dispute:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}

// ---------------------------------------------------------------------------------------------
// Views for the publisher's Disputes tab and the owner's wallet

/** One dispute as the dashboards show it (JSON-safe). */
export interface DisputeView {
  id: string;
  receiptId: string;
  siteId: string;
  siteName: string;
  agentKeyName: string;
  url: string | null;
  path: string;
  amountCents: number;
  reason: string;
  note: string | null;
  /** `open` (waiting for the verdict) reads as pending_publisher. */
  status: DisputeOutcome["status"];
  message: string;
  verdict: DisputeOutcome["verdict"];
  refundedCents: number;
  declaredOffer: { title: string; preview: string; wordCount?: number } | null;
  deliveredExcerpt: string | null;
  contentDigestOk: boolean;
  autoAllowed: boolean;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  purchasedAt: string;
}

export function toDisputeView(row: DisputeListRow, options: { excerpt: boolean }): DisputeView {
  return {
    id: row.id,
    receiptId: row.receiptId,
    siteId: row.siteId,
    siteName: row.siteName,
    agentKeyName: row.agentKeyName,
    url: row.resourceUrl,
    path: receiptPath(row.resourceUrl),
    amountCents: row.amountCents,
    reason: row.reason,
    note: row.note,
    status: row.status === "open" ? "pending_publisher" : row.status,
    message: row.message ?? "",
    verdict: row.verdict ?? null,
    refundedCents: row.refundedCents,
    declaredOffer: row.declaredOffer ?? null,
    deliveredExcerpt: options.excerpt ? row.deliveredExcerpt : null,
    contentDigestOk: row.contentDigestOk,
    autoAllowed: row.autoAllowed,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    purchasedAt: row.purchasedAt.toISOString(),
  };
}

export const PUBLISHER_DISPUTE_LIMIT = 100;
export const OWNER_DISPUTE_LIMIT = 25;

export interface PublisherDisputes {
  pendingCount: number;
  disputes: DisputeView[];
}

export async function getPublisherDisputes(
  publisherUserId: string,
  options: { siteId?: string } = {},
): Promise<PublisherDisputes> {
  const db = getDb();
  const [pendingCount, rows] = await Promise.all([
    pendingDisputeCount(db, publisherUserId),
    listDisputesForPublisher(db, {
      publisherUserId,
      ...(options.siteId ? { siteId: options.siteId } : {}),
      limit: PUBLISHER_DISPUTE_LIMIT,
    }),
  ]);
  return { pendingCount, disputes: rows.map((row) => toDisputeView(row, { excerpt: true })) };
}

/** The owner's agents' disputes; the delivered excerpt stays with the publisher's review. */
export async function getOwnerDisputes(ownerUserId: string): Promise<DisputeView[]> {
  const rows = await listDisputesForOwner(getDb(), { ownerUserId, limit: OWNER_DISPUTE_LIMIT });
  return rows.map((row) => toDisputeView(row, { excerpt: false }));
}

// ---------------------------------------------------------------------------------------------
// POST /api/publisher/disputes (session): accept (refund) or reject

export const publisherDecisionSchema = z.object({
  disputeId: z.string().min(1).max(100),
  decision: z.enum(["accept", "reject"]),
});

/** Applies the signed-in publisher's decision; only their own, still-pending disputes. */
export async function decideAsPublisher(
  publisherUserId: string,
  input: z.infer<typeof publisherDecisionSchema>,
): Promise<Response> {
  const db = getDb();
  try {
    const result = await publisherDecide(db, {
      disputeId: input.disputeId,
      publisherUserId,
      accept: input.decision === "accept",
    });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 409;
      return jsonError(status, result.reason, result.message, NO_STORE);
    }
    console.info(
      `[fare-court] publisher ${input.decision} ${input.disputeId} -> ${result.outcome.status}`,
    );
    return Response.json(
      {
        outcome: result.outcome,
        pendingCount: await pendingDisputeCount(db, publisherUserId),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[fare-court] publisher decision:", err);
    return jsonError(500, "internal_error", "Something went wrong");
  }
}
