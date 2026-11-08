/**
 * Signed receipts, agent side: read the payment statement BotFare put in a PAYMENT-RESPONSE, fetch
 * the statements BotFare signed later (delivery, refund), and verify any of them offline against
 * BotFare's published receipt keys (a JWKS at RECEIPT_KEYS_PATH). Runs in Node and in the browser.
 */
import {
  RECEIPT_KEYS_PATH,
  type ReceiptStatements,
  receiptStatementsPath,
  SETTLE_EXTRA_RECEIPT_KEY,
  type VerifyStatementOptions,
  type VerifyStatementResult,
  verifyStatement,
} from "@botfare/contracts/receipts";
import { MAX_CONTROL_PLANE_RESPONSE_BYTES, readLimitedText } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import type { JSONWebKeySet } from "jose";
import { z } from "zod";
import { BotFareApiError } from "./errors";

/** What verifying a receipt statement found. Never thrown: failures are values. */
export type ReceiptVerification =
  | VerifyStatementResult
  | {
      ok: false;
      /** BotFare's receipt keys could not be fetched (or no BotFare URL is configured). */
      error: "keys_unavailable";
      message: string;
    };

export interface VerifyReceiptOptions {
  /** The statement must be of this kind (payment, delivery or refund). */
  kind?: VerifyStatementOptions["kind"];
  /** The statement must be about this receipt (`sub`). */
  receiptId?: string;
}

export interface ReceiptVerifierOptions {
  /** BotFare's URL: where the keys and statements are fetched, and the issuer statements must name. */
  botfareUrl: string;
  /** Fetch for BotFare's public endpoints; default the global fetch. */
  fetch?: typeof fetch;
  /** How long fetched keys are reused before being fetched again; default 10 minutes. */
  keysTtlMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

export interface ReceiptVerifier {
  /** The issuer statements are checked against (BotFare's origin). */
  readonly issuer: string;
  /** Verifies a compact JWS statement. Never throws. */
  verify(token: string, options?: VerifyReceiptOptions): Promise<ReceiptVerification>;
  /**
   * The latest signed statements BotFare holds for a receipt (public, no credentials); null when
   * BotFare does not know the receipt. Throws BotFareApiError when BotFare cannot be read.
   * The tokens are returned as received: verify them before trusting them.
   */
  fetchStatements(receiptId: string): Promise<ReceiptStatements | null>;
  /** BotFare's receipt public keys (fetched and cached). Throws BotFareApiError on failure. */
  keys(): Promise<JSONWebKeySet>;
}

const DEFAULT_KEYS_TTL_MS = 10 * 60_000;
/** An unknown `kid` refetches the keys (a rotation), but at most this often. */
const MIN_REFETCH_MS = 30_000;

const jwksSchema = z.object({
  keys: z.array(z.looseObject({ kty: z.string() })).max(50),
});

const statementsSchema = z.object({
  receiptId: z.string(),
  payment: z.string().nullable(),
  delivery: z.string().nullable(),
  refund: z.string().nullable(),
});

/** The signed payment statement in a decoded PAYMENT-RESPONSE (`extra.botfareReceipt`); null if absent. */
export function readReceiptStatement(receipt: SettleResponse | null | undefined): string | null {
  const value = receipt?.extra?.[SETTLE_EXTRA_RECEIPT_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function originOf(botfareUrl: string): string {
  try {
    return new URL(botfareUrl).origin;
  } catch {
    throw new TypeError(`botfareUrl must be an absolute URL, got ${JSON.stringify(botfareUrl)}`);
  }
}

/** A verifier bound to one BotFare: keys are fetched once and cached, statements on demand. */
export function createReceiptVerifier(options: ReceiptVerifierOptions): ReceiptVerifier {
  const issuer = originOf(options.botfareUrl);
  const baseFetch = options.fetch ?? globalThis.fetch;
  const ttl = options.keysTtlMs ?? DEFAULT_KEYS_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { keys: JSONWebKeySet; at: number } | null = null;
  let inflight: Promise<JSONWebKeySet> | null = null;

  async function getJson(path: string, what: string): Promise<{ status: number; body: unknown }> {
    const url = new URL(path, issuer);
    let response: Response;
    try {
      response = await baseFetch(url, { headers: { accept: "application/json" } });
    } catch (err) {
      throw new BotFareApiError(
        0,
        `Could not reach BotFare at ${issuer} (${(err as Error).message})`,
      );
    }
    let text = "";
    try {
      text = await readLimitedText(response, MAX_CONTROL_PLANE_RESPONSE_BYTES);
    } catch {
      throw new BotFareApiError(502, `BotFare sent ${what} that is too large`);
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body };
  }

  async function load(): Promise<JSONWebKeySet> {
    const { status, body } = await getJson(RECEIPT_KEYS_PATH, "receipt keys");
    if (status !== 200) {
      throw new BotFareApiError(status, `BotFare's receipt keys answered HTTP ${status}`);
    }
    const parsed = jwksSchema.safeParse(body);
    if (!parsed.success)
      throw new BotFareApiError(502, "BotFare sent receipt keys that are not a JWKS");
    const keys = parsed.data as JSONWebKeySet;
    cached = { keys, at: now() };
    return keys;
  }

  async function keys(force = false): Promise<JSONWebKeySet> {
    if (cached && !force && now() - cached.at < ttl) return cached.keys;
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function verify(
    token: string,
    verifyOptions: VerifyReceiptOptions = {},
  ): Promise<ReceiptVerification> {
    if (typeof token !== "string" || token.length === 0) {
      return { ok: false, error: "malformed", message: "No statement given" };
    }
    const check = async (jwks: JSONWebKeySet) =>
      verifyStatement(token, jwks, {
        issuer,
        ...(verifyOptions.kind ? { kind: verifyOptions.kind } : {}),
      });
    let jwks: JSONWebKeySet;
    try {
      jwks = await keys();
    } catch (err) {
      return { ok: false, error: "keys_unavailable", message: (err as Error).message };
    }
    let result = await check(jwks);
    // A key published after the cache was filled (a rotation): fetch the keys again, once.
    if (
      !result.ok &&
      result.error === "unknown_key" &&
      cached &&
      now() - cached.at >= MIN_REFETCH_MS
    ) {
      try {
        result = await check(await keys(true));
      } catch {
        // keep the unknown_key result
      }
    }
    if (result.ok && verifyOptions.receiptId && result.statement.sub !== verifyOptions.receiptId) {
      return {
        ok: false,
        error: "invalid_claims",
        message: `Signed for receipt ${result.statement.sub}, not ${verifyOptions.receiptId}`,
      };
    }
    return result;
  }

  async function fetchStatements(receiptId: string): Promise<ReceiptStatements | null> {
    const { status, body } = await getJson(receiptStatementsPath(receiptId), "statements");
    if (status === 404) return null;
    if (status !== 200) {
      const message =
        body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : `HTTP ${status}`;
      throw new BotFareApiError(
        status,
        `BotFare refused the statements for ${receiptId}: ${message}`,
      );
    }
    const parsed = statementsSchema.safeParse(body);
    if (!parsed.success || parsed.data.receiptId !== receiptId) {
      throw new BotFareApiError(502, `BotFare sent unexpected statements for ${receiptId}`);
    }
    return parsed.data;
  }

  return { issuer, verify, fetchStatements, keys: () => keys() };
}

/**
 * Verifies one BotFare statement (payment, delivery or refund) against the receipt keys published
 * at `botfareUrl`, with `botfareUrl`'s origin as the required issuer. Never throws. Fetches the keys
 * on every call; for many checks, use `createReceiptVerifier` or `agent.verifyReceipt` (cached).
 */
export function verifyReceipt(
  token: string,
  options: { botfareUrl: string; fetch?: typeof fetch } & VerifyReceiptOptions,
): Promise<ReceiptVerification> {
  let verifier: ReceiptVerifier;
  try {
    verifier = createReceiptVerifier({
      botfareUrl: options.botfareUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (err) {
    return Promise.resolve({
      ok: false,
      error: "keys_unavailable",
      message: (err as Error).message,
    });
  }
  return verifier.verify(token, {
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.receiptId ? { receiptId: options.receiptId } : {}),
  });
}
