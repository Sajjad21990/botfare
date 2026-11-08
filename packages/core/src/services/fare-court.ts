/**
 * Fare Court: proof of delivery and micro-disputes. The AI judge only produces a verdict; this
 * module decides what happens to the money, with the thresholds in DISPUTE_POLICY, and moves it
 * only through refundReceipt (one refund per receipt, ever).
 */
import { Buffer } from "node:buffer";
import { IdPrefix, matchesPattern, newId } from "@botfare/contracts";
import {
  contentDigestSha256,
  type DeclaredOffer,
  DISPUTE_POLICY,
  type DisputeOutcome,
  type DisputeReason,
  type DisputeRequest,
  type DisputeVerdict,
  disputeRequestSchema,
  disputeVerdictSchema,
  MAX_DISPUTE_CONTENT_BYTES,
  type ReceiptAttestation,
  receiptAttestationSchema,
} from "@botfare/contracts/fare";
import { and, count, desc, eq, gte, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { PG_UNIQUE_VIOLATION, pgError } from "../accounts";
import type { Db, DbOrTx } from "../db";
import { refundReceipt } from "../postgres-ledger";
import {
  agentKeys,
  type Dispute,
  type DisputeRowStatus,
  disputes,
  type Receipt,
  receipts,
  sites,
} from "../schema";

/** Characters of delivered text stored on the dispute for the publisher's review. */
export const DISPUTE_EXCERPT_CHARS = 4_000;
/** Characters of delivered text handed to the AI judge. */
export const DISPUTE_JUDGE_TEXT_CHARS = 12_000;

const HOUR_MS = 3_600_000;
const OPEN_STATUSES: DisputeRowStatus[] = ["open", "pending_publisher"];
const DECIDED_STATUSES: DisputeRowStatus[] = ["refunded", "denied", "rejected_by_publisher"];

// ---------------------------------------------------------------------------------------------
// Proof of delivery

export type AttestReceiptResult =
  | { ok: true; receipt: Receipt; alreadyAttested: boolean }
  | { ok: false; reason: "invalid" | "not_found" | "conflict"; message: string };

/**
 * Records the paid site's attestation of what it delivered for a receipt. Only the site that was
 * paid may attest, and the first attestation wins: repeating it is a no-op, a different digest is
 * a conflict.
 */
export async function attestReceipt(
  db: DbOrTx,
  input: { siteId: string; receiptId: string; attestation: ReceiptAttestation | unknown },
): Promise<AttestReceiptResult> {
  const parsed = receiptAttestationSchema.safeParse(input.attestation);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", message: "Attestation is not valid" };
  }
  const attestation = parsed.data;
  const ownReceipt = and(eq(receipts.id, input.receiptId), eq(receipts.siteId, input.siteId));
  const [updated] = await db
    .update(receipts)
    .set({
      contentDigest: attestation.contentDigest,
      contentLength: attestation.contentLength,
      contentType: attestation.contentType,
      deliveredStatus: attestation.status,
      attestedAt: new Date(),
    })
    .where(and(ownReceipt, isNull(receipts.contentDigest)))
    .returning();
  if (updated) return { ok: true, receipt: updated, alreadyAttested: false };

  const [existing] = await db.select().from(receipts).where(ownReceipt);
  if (!existing)
    return { ok: false, reason: "not_found", message: "No such receipt for this site" };
  if (existing.contentDigest === attestation.contentDigest) {
    return { ok: true, receipt: existing, alreadyAttested: true };
  }
  return {
    ok: false,
    reason: "conflict",
    message: "This receipt was already attested with a different digest",
  };
}

// ---------------------------------------------------------------------------------------------
// Delivered text

/**
 * Readable text of a delivered body for the judge and the review UI: HTML is reduced to its text
 * (scripts, styles and tags removed), other text is whitespace-collapsed, and binary types are
 * described rather than decoded.
 */
export function deliveredTextFromBytes(bytes: Uint8Array, contentType: string | null): string {
  const type = (contentType ?? "").toLowerCase();
  if (type && !/^text\/|json|xml|javascript|html/.test(type)) {
    return `[${type.split(";")[0]?.trim() || "binary"} content, ${bytes.length} bytes]`;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const isHtml = type.includes("html") || (!type && /^\s*</.test(text));
  return isHtml ? htmlToText(text) : text.replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(
      /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Disputes

/** What the AI judge reads: the declared offer against what was delivered. */
export interface DisputeJudgeInput {
  disputeId: string;
  receiptId: string;
  siteName: string;
  resourceUrl: string | null;
  path: string | null;
  priceCents: number;
  /** Declared at settle (`extra.botfareOffer`); null for receipts without one. */
  declaredOffer: DeclaredOffer | null;
  /** Description of the pricing rule the path matches today, if any (context when no offer was declared). */
  pricingRuleDescription: string | null;
  reason: DisputeReason;
  note: string | null;
  delivered: {
    status: number | null;
    contentType: string | null;
    contentLength: number;
    /** At most DISPUTE_JUDGE_TEXT_CHARS characters. */
    text: string;
    truncated: boolean;
  };
}

export type OpenDisputeRefusal =
  | "invalid_request"
  | "content_too_large"
  | "not_found"
  | "already_refunded"
  | "already_open"
  | "already_decided"
  | "rate_limited"
  | "not_attested"
  /** Stored as an `invalid` dispute (returned in `dispute`). */
  | "window_closed"
  /** Stored as an `invalid` dispute (returned in `dispute`). */
  | "digest_mismatch";

export type OpenDisputeResult =
  | {
      ok: true;
      /** Status `open`: call applyVerdict next (with the judge's verdict, or null without one). */
      dispute: Dispute;
      /** False when the key disputes too often: AI verdicts cannot refund, the publisher decides. */
      autoAllowed: boolean;
      judgeInput: DisputeJudgeInput;
    }
  | { ok: false; reason: OpenDisputeRefusal; message: string; dispute?: Dispute };

/**
 * Files an agent's dispute on one of its receipts. Checks, in order: the request, the receipt
 * belongs to the key and is still settled, no other open or decided dispute, the key's daily
 * dispute limit, the filing window, a publisher attestation, and that the submitted bytes hash to
 * the attested digest. A late or mismatching dispute is stored as `invalid` (it still counts
 * toward the daily limit). Also decides whether AI verdicts may refund automatically: not once
 * the key has disputed more than DISPUTE_POLICY.maxAutoRefundRate of a big enough sample of its
 * purchases in the last 7 days.
 */
export async function openDispute(
  db: Db,
  input: {
    agentKeyId: string;
    request: DisputeRequest;
    /** The delivered bytes; decoded from `request.contentBase64` when left out. */
    contentBytes?: Uint8Array;
    now?: Date;
  },
): Promise<OpenDisputeResult> {
  const parsed = disputeRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_request", message: "Dispute request is not valid" };
  }
  const request = parsed.data;
  const bytes = input.contentBytes ?? new Uint8Array(Buffer.from(request.contentBase64, "base64"));
  if (bytes.length > MAX_DISPUTE_CONTENT_BYTES) {
    return {
      ok: false,
      reason: "content_too_large",
      message: `Delivered content is over ${MAX_DISPUTE_CONTENT_BYTES} bytes`,
    };
  }
  const now = input.now ?? new Date();
  const digest = await contentDigestSha256(bytes);

  try {
    return await db.transaction(async (tx): Promise<OpenDisputeResult> => {
      // One dispute at a time per key, so the daily limit and the rate rule cannot be raced.
      const [key] = await tx
        .select({ id: agentKeys.id })
        .from(agentKeys)
        .where(eq(agentKeys.id, input.agentKeyId))
        .for("update");
      const [receipt] = key
        ? await tx
            .select()
            .from(receipts)
            .where(
              and(eq(receipts.id, request.receiptId), eq(receipts.agentKeyId, input.agentKeyId)),
            )
        : [];
      if (!receipt) {
        return { ok: false, reason: "not_found", message: "No such receipt for this agent key" };
      }
      if (receipt.status !== "settled") {
        return {
          ok: false,
          reason: "already_refunded",
          message: "This receipt was already refunded",
        };
      }

      const earlier = await tx
        .select()
        .from(disputes)
        .where(and(eq(disputes.receiptId, receipt.id), ne(disputes.status, "invalid")))
        .orderBy(desc(disputes.createdAt));
      const open = earlier.find((d) => OPEN_STATUSES.includes(d.status));
      if (open) {
        return {
          ok: false,
          reason: "already_open",
          message: "A dispute on this receipt is already open",
          dispute: open,
        };
      }
      const decided = earlier.find((d) => DECIDED_STATUSES.includes(d.status));
      if (decided) {
        return {
          ok: false,
          reason: "already_decided",
          message: `A dispute on this receipt was already decided (${decided.status})`,
          dispute: decided,
        };
      }

      const [today] = await tx
        .select({ n: count() })
        .from(disputes)
        .where(
          and(eq(disputes.agentKeyId, input.agentKeyId), gte(disputes.createdAt, utcDayStart(now))),
        );
      if ((today?.n ?? 0) >= DISPUTE_POLICY.maxDisputesPerKeyPerDay) {
        return {
          ok: false,
          reason: "rate_limited",
          message: `At most ${DISPUTE_POLICY.maxDisputesPerKeyPerDay} disputes per agent key per day`,
        };
      }

      const base = {
        receiptId: receipt.id,
        agentKeyId: receipt.agentKeyId,
        ownerUserId: receipt.ownerUserId,
        siteId: receipt.siteId,
        publisherUserId: receipt.publisherUserId,
        reason: request.reason,
        note: request.note?.trim() || null,
        createdAt: now,
      };
      const text = deliveredTextFromBytes(bytes, receipt.contentType);
      const excerpt = text.slice(0, DISPUTE_EXCERPT_CHARS);

      const storeInvalid = async (reason: "window_closed" | "digest_mismatch", message: string) => {
        const [row] = await tx
          .insert(disputes)
          .values({
            ...base,
            id: newId(IdPrefix.dispute),
            contentDigestOk: receipt.contentDigest === digest,
            deliveredExcerpt: excerpt,
            status: "invalid",
            autoAllowed: false,
            message,
            decidedAt: now,
            decidedBy: "system",
          })
          .returning();
        return { ok: false as const, reason, message, dispute: row };
      };

      if (now.getTime() - receipt.createdAt.getTime() > DISPUTE_POLICY.windowHours * HOUR_MS) {
        return storeInvalid(
          "window_closed",
          `Disputes must be filed within ${DISPUTE_POLICY.windowHours} hours of the purchase`,
        );
      }
      if (!receipt.contentDigest) {
        return {
          ok: false,
          reason: "not_attested",
          message: "The publisher has not attested what it delivered for this receipt",
        };
      }
      if (receipt.contentDigest !== digest) {
        return storeInvalid(
          "digest_mismatch",
          "The submitted content does not match the digest the publisher attested",
        );
      }

      const rate = await disputeRate(tx, input.agentKeyId, now);
      const autoAllowed =
        rate.purchases < DISPUTE_POLICY.minSampleForRate ||
        (rate.disputes + 1) / rate.purchases <= DISPUTE_POLICY.maxAutoRefundRate;

      const [dispute] = await tx
        .insert(disputes)
        .values({
          ...base,
          id: newId(IdPrefix.dispute),
          contentDigestOk: true,
          deliveredExcerpt: excerpt,
          status: "open",
          autoAllowed,
          message: autoAllowed
            ? "Waiting for the AI verdict"
            : "This agent key disputes often, so the publisher reviews any refund",
        })
        .returning();
      if (!dispute) throw new Error("Failed to store the dispute");

      const [site] = await tx
        .select({ name: sites.name, pricing: sites.pricing })
        .from(sites)
        .where(eq(sites.id, receipt.siteId));
      const path = pathOf(receipt.resourceUrl);
      const rule = path ? site?.pricing.find((r) => matchesPattern(r.pattern, path)) : undefined;
      return {
        ok: true,
        dispute,
        autoAllowed,
        judgeInput: {
          disputeId: dispute.id,
          receiptId: receipt.id,
          siteName: site?.name ?? "",
          resourceUrl: receipt.resourceUrl,
          path,
          priceCents: receipt.amountCents,
          declaredOffer: receipt.declaredOffer ?? null,
          pricingRuleDescription: rule?.description ?? null,
          reason: request.reason,
          note: base.note,
          delivered: {
            status: receipt.deliveredStatus,
            contentType: receipt.contentType,
            contentLength: bytes.length,
            text: text.slice(0, DISPUTE_JUDGE_TEXT_CHARS),
            truncated: text.length > DISPUTE_JUDGE_TEXT_CHARS,
          },
        },
      };
    });
  } catch (err) {
    // Two disputes on one receipt at once: the partial unique index lets only one stay open.
    if (pgError(err)?.code !== PG_UNIQUE_VIOLATION) throw err;
    const [open] = await db
      .select()
      .from(disputes)
      .where(
        and(eq(disputes.receiptId, request.receiptId), inArray(disputes.status, OPEN_STATUSES)),
      );
    return {
      ok: false,
      reason: "already_open",
      message: "A dispute on this receipt is already open",
      ...(open ? { dispute: open } : {}),
    };
  }
}

/** The key's purchases and (valid) disputes in the 7 days before `now`. */
async function disputeRate(
  executor: DbOrTx,
  agentKeyId: string,
  now: Date,
): Promise<{ purchases: number; disputes: number }> {
  const since = new Date(now.getTime() - 7 * 24 * HOUR_MS);
  const [[purchases], [disputed]] = await Promise.all([
    executor
      .select({ n: count() })
      .from(receipts)
      .where(and(eq(receipts.agentKeyId, agentKeyId), gte(receipts.createdAt, since))),
    executor
      .select({ n: count() })
      .from(disputes)
      .where(
        and(
          eq(disputes.agentKeyId, agentKeyId),
          ne(disputes.status, "invalid"),
          gte(disputes.createdAt, since),
        ),
      ),
  ]);
  return { purchases: purchases?.n ?? 0, disputes: disputed?.n ?? 0 };
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type DisputeDecisionResult =
  | {
      ok: true;
      dispute: Dispute;
      outcome: DisputeOutcome;
      /** False when the dispute was already past this step (a retry, or another decider won). */
      changed: boolean;
    }
  | {
      ok: false;
      reason: "not_found" | "already_decided" | "insufficient_earnings";
      message: string;
      dispute?: Dispute;
      outcome?: DisputeOutcome;
    };

/**
 * Applies the AI judge's verdict to an open dispute. Policy in code:
 * - `refund` at or above DISPUTE_POLICY.autoRefundConfidence, with auto decisions allowed (both
 *   the dispute's own rate check and `autoAllowed`), refunds through refundReceipt;
 * - `deny` at or above DISPUTE_POLICY.autoDenyConfidence closes the dispute;
 * - anything else, a missing or invalid verdict, or a refund the publisher's (already paid out)
 *   earnings cannot cover, goes to the publisher (`pending_publisher`).
 * Only an `open` dispute changes; a second call returns the current state with `changed: false`.
 */
export async function applyVerdict(
  db: Db,
  input: {
    disputeId: string;
    /** The judge's output (validated here with disputeVerdictSchema); null when no judge ran. */
    verdict: DisputeVerdict | unknown | null;
    autoAllowed?: boolean;
    now?: Date;
  },
): Promise<DisputeDecisionResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<DisputeDecisionResult> => {
    const [dispute] = await tx
      .select()
      .from(disputes)
      .where(eq(disputes.id, input.disputeId))
      .for("update");
    if (!dispute) return { ok: false, reason: "not_found", message: "No such dispute" };
    if (dispute.status !== "open") {
      return { ok: true, dispute, outcome: toDisputeOutcome(dispute), changed: false };
    }

    const parsed = input.verdict == null ? null : disputeVerdictSchema.safeParse(input.verdict);
    const verdict = parsed?.success ? parsed.data : null;
    const toPublisher = (message: string) =>
      save(tx, dispute.id, { status: "pending_publisher", verdict, message });

    if (!verdict) {
      return toPublisher(
        parsed
          ? "The AI verdict was not valid, so the publisher decides"
          : "No AI verdict was available, so the publisher decides",
      );
    }
    const confidence = `${Math.round(verdict.confidence * 100)}%`;

    if (
      verdict.decision === "refund" &&
      verdict.confidence >= DISPUTE_POLICY.autoRefundConfidence
    ) {
      if (!dispute.autoAllowed || input.autoAllowed === false) {
        return toPublisher(
          `The AI found the purchase ${label(verdict.category)} (${confidence} sure), but this agent key disputes often, so the publisher decides`,
        );
      }
      const refund = await refundReceipt(tx, {
        receiptId: dispute.receiptId,
        siteId: dispute.siteId,
        memo: `Fare Court refund (dispute ${dispute.id})`,
      });
      if (!refund.ok) {
        if (refund.reason === "insufficient_earnings") {
          return toPublisher(
            `The AI found the purchase ${label(verdict.category)} (${confidence} sure), but the publisher's earnings were already paid out, so the publisher decides`,
          );
        }
        throw new Error(`Receipt ${dispute.receiptId} of dispute ${dispute.id} is missing`);
      }
      return save(tx, dispute.id, {
        status: "refunded",
        verdict,
        message: refund.alreadyRefunded
          ? "The receipt had already been refunded"
          : `Refunded automatically: ${label(verdict.category)} (${confidence} sure)`,
        refundedCents: refund.receipt.amountCents,
        refundTransactionId: refund.refundTransactionId,
        decidedAt: now,
        decidedBy: "ai",
      });
    }

    if (verdict.decision === "deny" && verdict.confidence >= DISPUTE_POLICY.autoDenyConfidence) {
      return save(tx, dispute.id, {
        status: "denied",
        verdict,
        message: `The AI found the content matched the offer (${confidence} sure)`,
        decidedAt: now,
        decidedBy: "ai",
      });
    }

    return toPublisher(
      `The AI was not sure (${verdict.decision}, ${confidence}), so the publisher decides`,
    );
  });
}

/**
 * The publisher's decision on a dispute waiting for them (or still waiting for a verdict): accept
 * refunds through refundReceipt, reject closes it. Only the receipt's publisher may decide. If
 * their earnings were already paid out the refund fails with `insufficient_earnings` and the
 * dispute stays with them.
 */
export async function publisherDecide(
  db: Db,
  input: { disputeId: string; publisherUserId: string; accept: boolean; now?: Date },
): Promise<DisputeDecisionResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<DisputeDecisionResult> => {
    const [dispute] = await tx
      .select()
      .from(disputes)
      .where(
        and(eq(disputes.id, input.disputeId), eq(disputes.publisherUserId, input.publisherUserId)),
      )
      .for("update");
    if (!dispute) return { ok: false, reason: "not_found", message: "No such dispute" };
    if (!OPEN_STATUSES.includes(dispute.status)) {
      return {
        ok: false,
        reason: "already_decided",
        message: `This dispute was already decided (${dispute.status})`,
        dispute,
        outcome: toDisputeOutcome(dispute),
      };
    }

    if (!input.accept) {
      return save(tx, dispute.id, {
        status: "rejected_by_publisher",
        message: "The publisher reviewed the dispute and declined the refund",
        decidedAt: now,
        decidedBy: "publisher",
      });
    }

    const refund = await refundReceipt(tx, {
      receiptId: dispute.receiptId,
      siteId: dispute.siteId,
      memo: `Fare Court refund by the publisher (dispute ${dispute.id})`,
    });
    if (!refund.ok) {
      if (refund.reason !== "insufficient_earnings") {
        throw new Error(`Receipt ${dispute.receiptId} of dispute ${dispute.id} is missing`);
      }
      const message =
        "Your earnings were already paid out, so this refund cannot be made yet; it can be accepted once new earnings come in";
      const saved = await save(tx, dispute.id, { status: "pending_publisher", message });
      return {
        ok: false,
        reason: "insufficient_earnings",
        message,
        dispute: saved.dispute,
        outcome: saved.outcome,
      };
    }
    return save(tx, dispute.id, {
      status: "refunded",
      message: refund.alreadyRefunded
        ? "The receipt had already been refunded"
        : "Refunded by the publisher",
      refundedCents: refund.receipt.amountCents,
      refundTransactionId: refund.refundTransactionId,
      decidedAt: now,
      decidedBy: "publisher",
    });
  });
}

async function save(
  tx: DbOrTx,
  disputeId: string,
  changes: Partial<Omit<Dispute, "id">>,
): Promise<{ ok: true; dispute: Dispute; outcome: DisputeOutcome; changed: true }> {
  const [dispute] = await tx
    .update(disputes)
    .set(changes)
    .where(eq(disputes.id, disputeId))
    .returning();
  if (!dispute) throw new Error(`Dispute ${disputeId} vanished`);
  return { ok: true, dispute, outcome: toDisputeOutcome(dispute), changed: true };
}

function label(category: DisputeReason): string {
  const labels: Record<DisputeReason, string> = {
    not_as_described: "not as described",
    stub_or_paywall: "a stub or paywall",
    error_page: "an error page",
    truncated: "truncated",
    unrelated: "unrelated to the offer",
    other: "not as promised",
  };
  return labels[category];
}

/** The agent-facing outcome (an `open` dispute reads as `pending_publisher` until decided). */
export function toDisputeOutcome(dispute: Dispute): DisputeOutcome {
  return {
    disputeId: dispute.id,
    receiptId: dispute.receiptId,
    status: dispute.status === "open" ? "pending_publisher" : dispute.status,
    refundedCents: dispute.refundedCents,
    verdict: dispute.verdict ?? null,
    message: dispute.message ?? "",
  };
}

export async function getDispute(db: DbOrTx, disputeId: string): Promise<Dispute | null> {
  const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  return dispute ?? null;
}

/** A dispute with what its list views show next to it. */
export type DisputeListRow = Dispute & {
  siteName: string;
  agentKeyName: string;
  resourceUrl: string | null;
  amountCents: number;
  declaredOffer: DeclaredOffer | null;
  purchasedAt: Date;
};

function listDisputes(db: DbOrTx, filters: SQL[], limit = 50): Promise<DisputeListRow[]> {
  return db
    .select({
      id: disputes.id,
      receiptId: disputes.receiptId,
      agentKeyId: disputes.agentKeyId,
      ownerUserId: disputes.ownerUserId,
      siteId: disputes.siteId,
      publisherUserId: disputes.publisherUserId,
      reason: disputes.reason,
      note: disputes.note,
      contentDigestOk: disputes.contentDigestOk,
      deliveredExcerpt: disputes.deliveredExcerpt,
      verdict: disputes.verdict,
      status: disputes.status,
      autoAllowed: disputes.autoAllowed,
      message: disputes.message,
      refundedCents: disputes.refundedCents,
      refundTransactionId: disputes.refundTransactionId,
      createdAt: disputes.createdAt,
      decidedAt: disputes.decidedAt,
      decidedBy: disputes.decidedBy,
      siteName: sites.name,
      agentKeyName: agentKeys.name,
      resourceUrl: receipts.resourceUrl,
      amountCents: receipts.amountCents,
      declaredOffer: receipts.declaredOffer,
      purchasedAt: receipts.createdAt,
    })
    .from(disputes)
    .innerJoin(receipts, eq(receipts.id, disputes.receiptId))
    .innerJoin(sites, eq(sites.id, disputes.siteId))
    .innerJoin(agentKeys, eq(agentKeys.id, disputes.agentKeyId))
    .where(and(...filters))
    .orderBy(desc(disputes.createdAt), desc(disputes.id))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 500));
}

/** Disputes on a publisher's sites, newest first (the Disputes tab). */
export function listDisputesForPublisher(
  db: DbOrTx,
  input: { publisherUserId: string; siteId?: string; status?: DisputeRowStatus[]; limit?: number },
): Promise<DisputeListRow[]> {
  const filters = [eq(disputes.publisherUserId, input.publisherUserId)];
  if (input.siteId) filters.push(eq(disputes.siteId, input.siteId));
  if (input.status?.length) filters.push(inArray(disputes.status, input.status));
  return listDisputes(db, filters, input.limit);
}

/** Disputes filed by an agent owner's keys, newest first. */
export function listDisputesForOwner(
  db: DbOrTx,
  input: { ownerUserId: string; agentKeyId?: string; limit?: number },
): Promise<DisputeListRow[]> {
  const filters = [eq(disputes.ownerUserId, input.ownerUserId)];
  if (input.agentKeyId) filters.push(eq(disputes.agentKeyId, input.agentKeyId));
  return listDisputes(db, filters, input.limit);
}

/** Disputes waiting for the publisher (for a badge on the Disputes tab). */
export async function pendingDisputeCount(db: DbOrTx, publisherUserId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(disputes)
    .where(
      and(eq(disputes.publisherUserId, publisherUserId), inArray(disputes.status, OPEN_STATUSES)),
    );
  return row?.n ?? 0;
}
