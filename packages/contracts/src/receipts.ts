/**
 * Signed receipts: statements BotFare signs (Ed25519 JWS) so anyone can verify a payment, a delivery
 * or a refund without asking BotFare's database. Works in Node and in the browser (jose + WebCrypto).
 *
 * - payment:  issued at settlement; travels in the x402 PAYMENT-RESPONSE as extra.botfareReceipt
 * - delivery: issued when the publisher attests the bytes it delivered (RFC 9530 content digest)
 * - refund:   issued when a receipt is refunded (Fare Court or the publisher)
 */
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { z } from "zod";
import { contentDigestSha256, type DeclaredOffer, isContentDigest } from "./fare";
import { detectionSignalSchema, IdPrefix } from "./index";

/** JWS `typ` of every BotFare statement. */
export const RECEIPT_JWT_TYPE = "botfare-receipt+jwt";

/** BotFare's receipt-signing public keys, as a JWKS (each key has a `kid`). */
export const RECEIPT_KEYS_PATH = "/.well-known/botfare-receipt-keys.json";

/** Key in the x402 SettleResponse `extra` that carries the signed payment statement. */
export const SETTLE_EXTRA_RECEIPT_KEY = "botfareReceipt";

/** Public receipt lookup: the latest signed statements for a receipt (no personal data). */
export function receiptStatementsPath(receiptId: string): string {
  return `/api/receipts/${encodeURIComponent(receiptId)}/statements`;
}

const receiptId = z.string().startsWith(`${IdPrefix.receipt}_`);
const digest = z.string().refine(isContentDigest, "must be a sha-256 Content-Digest");
const micros = z.number().int().nonnegative();

const baseClaims = {
  /** BotFare origin that issued the statement. */
  iss: z.string().url(),
  /** The receipt this statement is about. */
  sub: receiptId,
  iat: z.number().int(),
  /** Statement format version. */
  v: z.literal(1),
};

export const paymentStatementSchema = z.object({
  ...baseClaims,
  kind: z.literal("payment"),
  payment: z.object({
    scheme: z.string(),
    network: z.string(),
    asset: z.string(),
    /** Atomic amount as in the x402 requirements (integer cents for USD). */
    amount: z.string().regex(/^[1-9]\d*$/),
    amountMicros: micros,
    publisherMicros: micros,
    feeMicros: micros,
    /** The BotFare site that was paid (x402 payTo). */
    payTo: z.string().startsWith(`${IdPrefix.site}_`),
    siteOrigin: z.string().url().nullable(),
    resource: z.string().url().nullable(),
    /** The paying agent key and the RFC 7638 thumbprint of its public key. */
    payer: z.string().startsWith(`${IdPrefix.agentKey}_`),
    payerThumbprint: z.string().nullable(),
    /** Why this request was charged (agent detection). */
    signal: detectionSignalSchema.nullable(),
    /** sha-256 Content-Digest of the declared offer JSON (title + preview), if one was declared. */
    offerDigest: digest.nullable(),
    settledAt: z.string().datetime(),
  }),
});
export type PaymentStatement = z.infer<typeof paymentStatementSchema>;

export const deliveryStatementSchema = z.object({
  ...baseClaims,
  kind: z.literal("delivery"),
  delivery: z.object({
    contentDigest: digest,
    contentLength: z.number().int().nonnegative(),
    contentType: z.string(),
    status: z.number().int(),
    attestedAt: z.string().datetime(),
  }),
});
export type DeliveryStatement = z.infer<typeof deliveryStatementSchema>;

export const refundStatementSchema = z.object({
  ...baseClaims,
  kind: z.literal("refund"),
  refund: z.object({
    refundedMicros: micros,
    /** "dispute" (Fare Court or the publisher deciding one) or "publisher" (a direct refund). */
    via: z.enum(["dispute", "publisher"]),
    disputeId: z.string().nullable(),
    refundedAt: z.string().datetime(),
  }),
});
export type RefundStatement = z.infer<typeof refundStatementSchema>;

export const botFareStatementSchema = z.discriminatedUnion("kind", [
  paymentStatementSchema,
  deliveryStatementSchema,
  refundStatementSchema,
]);
export type BotFareStatement = z.infer<typeof botFareStatementSchema>;
export type StatementKind = BotFareStatement["kind"];

/** What the public statements endpoint returns for a receipt. */
export interface ReceiptStatements {
  receiptId: string;
  payment: string | null;
  delivery: string | null;
  refund: string | null;
}

// ---------------------------------------------------------------------------------------------
// Verification

export type VerifyStatementResult =
  | { ok: true; kid: string; statement: BotFareStatement }
  | {
      ok: false;
      error: "malformed" | "unknown_key" | "bad_signature" | "wrong_issuer" | "invalid_claims";
      message: string;
    };

export interface VerifyStatementOptions {
  /** If set, the statement's `iss` must equal this origin. */
  issuer?: string;
  /** If set, the statement must be of this kind. */
  kind?: StatementKind;
}

/**
 * Verifies a BotFare statement against a JWKS (object) or a jose key resolver. Never throws.
 * Statements do not expire: they are records of what happened, signed when it happened.
 */
export async function verifyStatement(
  token: string,
  keys: JSONWebKeySet | JWTVerifyGetKey,
  options: VerifyStatementOptions = {},
): Promise<VerifyStatementResult> {
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    kid = typeof header.kid === "string" ? header.kid : undefined;
    if (header.typ !== RECEIPT_JWT_TYPE || !kid) {
      return {
        ok: false,
        error: "malformed",
        message: "Not a BotFare statement (typ or kid missing)",
      };
    }
  } catch {
    return { ok: false, error: "malformed", message: "Not a compact JWS" };
  }
  const resolver = typeof keys === "function" ? keys : createLocalJWKSet(keys);
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, resolver, {
      algorithms: ["EdDSA", "Ed25519"],
      typ: RECEIPT_JWT_TYPE,
    }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWKS_NO_MATCHING_KEY") {
      return { ok: false, error: "unknown_key", message: `No published key with kid ${kid}` };
    }
    return { ok: false, error: "bad_signature", message: "Signature does not verify" };
  }
  const parsed = botFareStatementSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_claims",
      message: parsed.error.issues[0]?.message ?? "Invalid claims",
    };
  }
  const statement = parsed.data;
  if (options.issuer && statement.iss !== new URL(options.issuer).origin) {
    return {
      ok: false,
      error: "wrong_issuer",
      message: `Issued by ${statement.iss}, expected ${options.issuer}`,
    };
  }
  if (options.kind && statement.kind !== options.kind) {
    return { ok: false, error: "invalid_claims", message: `Expected a ${options.kind} statement` };
  }
  return { ok: true, kid, statement };
}

/** Reads a statement's claims without verifying it (for display only). */
export function decodeStatement(token: string): BotFareStatement | null {
  try {
    const parsed = botFareStatementSchema.safeParse(decodeJwt(token));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Only the public parts of a JWK (never publish `d`). */
export function publicJwk(jwk: JWK): JWK {
  const { kty, crv, x, kid, alg, use } = jwk;
  return Object.fromEntries(
    Object.entries({ kty, crv, x, kid, alg, use }).filter(([, value]) => value !== undefined),
  ) as JWK;
}

// ---------------------------------------------------------------------------------------------
// Sources manifest ("this answer paid for its sources")

export const answerSourceSchema = z.object({
  url: z.string().url(),
  receiptId,
  claim: z.string().max(300).default(""),
  /** Signed payment statement for the receipt. */
  payment: z.string(),
  /** Signed delivery statement, once the publisher has attested. */
  delivery: z.string().nullable(),
  /** sha-256 Content-Digest of the bytes the agent actually read. */
  readDigest: digest.nullable(),
});
export type AnswerSource = z.infer<typeof answerSourceSchema>;

export const answerManifestSchema = z.object({
  answerId: z.string().min(8).max(64),
  createdAt: z.string().datetime(),
  sources: z.array(answerSourceSchema).max(20),
});
export type AnswerManifest = z.infer<typeof answerManifestSchema>;

export interface SourceCheck {
  receiptId: string;
  url: string;
  paid: { ok: boolean; message: string; amountMicros?: number };
  delivered: { ok: boolean; message: string };
  bytesMatch: { ok: boolean; message: string };
}

/**
 * Checks one cited source: the payment is signed by BotFare for this receipt and URL, the delivery is
 * signed for the same receipt, and the bytes the agent read match the attested digest.
 */
export async function checkAnswerSource(
  source: AnswerSource,
  keys: JSONWebKeySet | JWTVerifyGetKey,
  options: { issuer?: string } = {},
): Promise<SourceCheck> {
  const check: SourceCheck = {
    receiptId: source.receiptId,
    url: source.url,
    paid: { ok: false, message: "Not checked" },
    delivered: { ok: false, message: "No delivery statement yet" },
    bytesMatch: { ok: false, message: "No digest of the read bytes" },
  };

  const payment = await verifyStatement(source.payment, keys, { ...options, kind: "payment" });
  if (!payment.ok) {
    check.paid = { ok: false, message: payment.message };
  } else if (payment.statement.sub !== source.receiptId) {
    check.paid = { ok: false, message: "Signed for a different receipt" };
  } else if (
    payment.statement.kind === "payment" &&
    payment.statement.payment.resource !== null &&
    payment.statement.payment.resource !== source.url
  ) {
    check.paid = { ok: false, message: "Signed for a different URL" };
  } else if (payment.statement.kind === "payment") {
    check.paid = {
      ok: true,
      message: "Payment signed by BotFare",
      amountMicros: payment.statement.payment.amountMicros,
    };
  }

  let attested: string | null = null;
  if (source.delivery) {
    const delivery = await verifyStatement(source.delivery, keys, { ...options, kind: "delivery" });
    if (!delivery.ok) {
      check.delivered = { ok: false, message: delivery.message };
    } else if (delivery.statement.sub !== source.receiptId) {
      check.delivered = { ok: false, message: "Signed for a different receipt" };
    } else if (delivery.statement.kind === "delivery") {
      attested = delivery.statement.delivery.contentDigest;
      check.delivered = { ok: true, message: "Delivery attested and signed" };
    }
  }

  if (attested && source.readDigest) {
    check.bytesMatch =
      attested === source.readDigest
        ? { ok: true, message: "The bytes read match the delivered digest" }
        : { ok: false, message: "The bytes read differ from what was attested" };
  }
  return check;
}

// ---------------------------------------------------------------------------------------------
// Offer digest (a payment statement's `offerDigest`)

/**
 * JSON with object keys sorted at every level and no whitespace. For the declared offer (strings and
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

/**
 * A payment statement's `offerDigest`: the sha-256 Content-Digest of the declared offer's canonical
 * JSON (the offer as declared in the 402's `extra.botfareOffer`). Lets anyone holding the 402 check
 * which title and preview the agent paid for.
 */
export function declaredOfferDigest(offer: DeclaredOffer): Promise<string> {
  return contentDigestSha256(canonicalJson(offer));
}
