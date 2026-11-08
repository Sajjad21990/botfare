/**
 * Signed receipts: BotFare signs a statement when something happens to a receipt and stores it.
 *
 * - payment:  right after settlement (PostgresPrepaidLedger.charge), returned to the agent in the
 *             x402 SettleResponse `extra.botfareReceipt`
 * - delivery: when the paid site first attests the bytes it delivered (attestReceipt)
 * - refund:   when the receipt is refunded (refundReceipt, Fare Court's applyVerdict/publisherDecide)
 *
 * The first statement of a kind for a receipt is the one forever: repeats return the stored JWS,
 * history is never re-signed. Issuing never breaks the money flow that triggered it: failures are
 * logged and the statement is issued lazily when someone reads it (getReceiptStatements).
 */
import { type DetectionSignal, detectionSignalSchema } from "@botfare/contracts";
import { contentDigestSha256, type DeclaredOffer } from "@botfare/contracts/fare";
import {
  type BotFareStatement,
  botFareStatementSchema,
  RECEIPT_JWT_TYPE,
  type ReceiptStatements,
  type StatementKind,
} from "@botfare/contracts/receipts";
import { PAYPAL_SANDBOX, PREPAID_SCHEME, USD } from "@botfare/x402-paypal";
import { and, desc, eq } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { calculateJwkThumbprint, type JWK, SignJWT } from "jose";
import { z } from "zod";
import type { DbOrTx } from "../db";
import { getReceiptKeyring, type ReceiptKeyring } from "../receipt-keys";
import {
  agentKeys,
  disputes,
  ledgerTransactions,
  type Receipt,
  receiptStatements,
  receipts,
  sites,
} from "../schema";

export interface IssueStatementOptions {
  /** Signing keys; the process keyring (from the environment) by default. */
  keyring?: ReceiptKeyring;
  /** Payment requirements' network at settle (the facilitator only settles `paypal:sandbox`). */
  network?: string;
  now?: () => Date;
}

/**
 * JSON with object keys sorted at every level (no whitespace): the canonical form whose sha-256
 * Content-Digest is a payment statement's `offerDigest`. For the declared offer (strings and
 * numbers only) this is the RFC 8785 (JCS) serialization.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `offerDigest`: sha-256 Content-Digest of the declared offer's canonical JSON. */
export function declaredOfferDigest(offer: DeclaredOffer): Promise<string> {
  return contentDigestSha256(canonicalJson(offer));
}

const urlSchema = z.string().url();

/** The URL as stored (or its origin), or null when the statement schema would not accept it. */
function urlOrNull(value: string | null | undefined, originOnly = false): string | null {
  if (!value) return null;
  try {
    const result = originOnly ? new URL(value).origin : value;
    return urlSchema.safeParse(result).success ? result : null;
  } catch {
    return null;
  }
}

/** Whether a receipt has reached the event a statement of `kind` records. */
function qualifies(receipt: Receipt, kind: StatementKind): boolean {
  if (kind === "payment") return true;
  if (kind === "delivery") return receipt.contentDigest !== null && receipt.attestedAt !== null;
  return receipt.status === "refunded" && receipt.refundTransactionId !== null;
}

/** The claims of a statement, from the receipt row (and what it points at). Null if not ready. */
async function buildClaims(
  db: DbOrTx,
  receipt: Receipt,
  kind: StatementKind,
  issuer: string,
  options: IssueStatementOptions,
): Promise<BotFareStatement | null> {
  if (!qualifies(receipt, kind)) return null;
  const now = options.now?.() ?? new Date();
  const base = { iss: issuer, sub: receipt.id, iat: Math.floor(now.getTime() / 1000), v: 1 };

  if (kind === "payment") {
    const [site] = await db
      .select({ origin: sites.origin })
      .from(sites)
      .where(eq(sites.id, receipt.siteId));
    const [key] = await db
      .select({ publicJwk: agentKeys.publicJwk })
      .from(agentKeys)
      .where(eq(agentKeys.id, receipt.agentKeyId));
    let payerThumbprint: string | null = null;
    try {
      payerThumbprint = key ? await calculateJwkThumbprint(key.publicJwk as JWK, "sha256") : null;
    } catch {
      payerThumbprint = null;
    }
    const signal = detectionSignalSchema.safeParse(receipt.detectionSignal);
    return botFareStatementSchema.parse({
      ...base,
      kind: "payment",
      payment: {
        scheme: PREPAID_SCHEME,
        network: options.network ?? PAYPAL_SANDBOX,
        asset: USD.asset,
        amount: String(receipt.amountCents),
        amountMicros: receipt.amountMicros,
        publisherMicros: receipt.amountMicros - receipt.feeMicros,
        feeMicros: receipt.feeMicros,
        payTo: receipt.siteId,
        siteOrigin: urlOrNull(site?.origin, true),
        resource: urlOrNull(receipt.resourceUrl),
        payer: receipt.agentKeyId,
        payerThumbprint,
        signal: signal.success ? (signal.data as DetectionSignal) : null,
        offerDigest: receipt.declaredOffer
          ? await declaredOfferDigest(receipt.declaredOffer)
          : null,
        settledAt: receipt.createdAt.toISOString(),
      },
    });
  }

  if (kind === "delivery") {
    return botFareStatementSchema.parse({
      ...base,
      kind: "delivery",
      delivery: {
        contentDigest: receipt.contentDigest,
        contentLength: receipt.contentLength ?? 0,
        contentType: receipt.contentType ?? "",
        status: receipt.deliveredStatus ?? 200,
        attestedAt: (receipt.attestedAt as Date).toISOString(),
      },
    });
  }

  const refundTransactionId = receipt.refundTransactionId as string;
  const [refundTx] = await db
    .select({ createdAt: ledgerTransactions.createdAt })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.id, refundTransactionId));
  const [dispute] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.receiptId, receipt.id), eq(disputes.status, "refunded")))
    .orderBy(desc(disputes.decidedAt))
    .limit(1);
  return botFareStatementSchema.parse({
    ...base,
    kind: "refund",
    refund: {
      refundedMicros: receipt.amountMicros,
      via: dispute ? "dispute" : "publisher",
      disputeId: dispute?.id ?? null,
      refundedAt: (refundTx?.createdAt ?? now).toISOString(),
    },
  });
}

async function storedStatement(
  db: DbOrTx,
  receiptId: string,
  kind: StatementKind,
): Promise<string | null> {
  const [row] = await db
    .select({ jws: receiptStatements.jws })
    .from(receiptStatements)
    .where(and(eq(receiptStatements.receiptId, receiptId), eq(receiptStatements.kind, kind)));
  return row?.jws ?? null;
}

/**
 * The signed statement of `kind` for a receipt: the stored one if it was issued before, otherwise
 * signs and stores it now. Null when the receipt does not exist, has not reached the event yet, or
 * signing is disabled (production without a seed). Throws on database errors.
 */
export async function issueReceiptStatement(
  db: DbOrTx,
  receiptId: string,
  kind: StatementKind,
  options: IssueStatementOptions = {},
): Promise<string | null> {
  const existing = await storedStatement(db, receiptId, kind);
  if (existing) return existing;

  const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  if (!receipt) return null;
  const keyring = options.keyring ?? (await getReceiptKeyring());
  const key = keyring.active;
  if (!key) return null;
  const claims = await buildClaims(db, receipt, kind, keyring.issuer, options);
  if (!claims) return null;

  const jws = await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "EdDSA", typ: RECEIPT_JWT_TYPE, kid: key.kid })
    .sign(key.privateKey);
  const [inserted] = await db
    .insert(receiptStatements)
    .values({ receiptId, kind, jws, kid: key.kid })
    .onConflictDoNothing()
    .returning({ jws: receiptStatements.jws });
  // Someone else stored this kind first: theirs is the record.
  return inserted?.jws ?? (await storedStatement(db, receiptId, kind));
}

const loggedSigningDisabled = new Set<StatementKind>();

/** Like issueReceiptStatement, but never throws (logs instead): for use right after money moved. */
export async function issueReceiptStatementQuietly(
  db: DbOrTx,
  receiptId: string,
  kind: StatementKind,
  options: IssueStatementOptions = {},
): Promise<string | null> {
  try {
    const jws = await issueReceiptStatement(db, receiptId, kind, options);
    if (!jws) {
      const keyring = options.keyring ?? (await getReceiptKeyring());
      if (!keyring.active && !loggedSigningDisabled.has(kind)) {
        loggedSigningDisabled.add(kind);
        console.error(
          `[receipts] ${kind} statements are not signed: ${keyring.problem ?? "no signing key"}`,
        );
      }
    }
    return jws;
  } catch (err) {
    console.error(
      `[receipts] could not issue the ${kind} statement for ${receiptId}:`,
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Issues a statement after the caller's work committed. Inside an open transaction it does nothing:
 * the outer caller issues after commit, or the statements endpoint issues it lazily.
 */
export async function issueAfterCommit(
  db: DbOrTx,
  receiptId: string,
  kind: StatementKind,
  options: IssueStatementOptions = {},
): Promise<string | null> {
  if (db instanceof PgTransaction) return null;
  return issueReceiptStatementQuietly(db, receiptId, kind, options);
}

/**
 * Every statement for a receipt (public lookup). With `issueMissing`, statements the receipt
 * qualifies for but that were never stored (an issuing failure) are issued now. Null for an
 * unknown receipt.
 */
export async function getReceiptStatements(
  db: DbOrTx,
  receiptId: string,
  options: IssueStatementOptions & { issueMissing?: boolean } = {},
): Promise<ReceiptStatements | null> {
  const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  if (!receipt) return null;
  const rows = await db
    .select({ kind: receiptStatements.kind, jws: receiptStatements.jws })
    .from(receiptStatements)
    .where(eq(receiptStatements.receiptId, receiptId));
  const result: ReceiptStatements = { receiptId, payment: null, delivery: null, refund: null };
  for (const row of rows) result[row.kind] = row.jws;
  if (options.issueMissing) {
    for (const kind of ["payment", "delivery", "refund"] as const) {
      if (!result[kind] && qualifies(receipt, kind)) {
        result[kind] = await issueReceiptStatementQuietly(db, receiptId, kind, options);
      }
    }
  }
  return result;
}
