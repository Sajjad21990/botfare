/**
 * Browser-side helpers for checking BotFare's signed statements. Everything here runs in the
 * viewer's browser: it fetches the public statements and the public JWKS from this origin, then
 * verifies the Ed25519 signatures locally with `@botfare/contracts/receipts`.
 */
import { IdPrefix } from "@botfare/contracts";
import {
  type BotFareStatement,
  decodeStatement,
  RECEIPT_KEYS_PATH,
  type ReceiptStatements,
  receiptStatementsPath,
  type StatementKind,
  type VerifyStatementResult,
  verifyStatement,
} from "@botfare/contracts/receipts";
import { decodeProtectedHeader, type JSONWebKeySet } from "jose";

const RECEIPT_ID = new RegExp(`^${IdPrefix.receipt}_[A-Za-z0-9]{4,64}$`);
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isReceiptId(value: string): boolean {
  return RECEIPT_ID.test(value);
}

/** Where a receipt can be checked by anyone. */
export function verifyHref(receiptId: string): string {
  return `/verify?receipt=${encodeURIComponent(receiptId)}`;
}

export type VerifyInput =
  | { kind: "receipt"; receiptId: string }
  | { kind: "statements"; tokens: { token: string; slot: StatementKind | null }[] }
  | { kind: "invalid"; message: string };

/**
 * What the viewer typed: a receipt ID (or a link with ?receipt=), one or more compact JWS
 * statements, or the JSON the statements endpoint returns.
 */
export function parseVerifyInput(raw: string): VerifyInput {
  const text = raw.trim();
  if (!text) return { kind: "invalid", message: "Enter a receipt ID or paste a statement." };

  if (isReceiptId(text)) return { kind: "receipt", receiptId: text };

  if (/^https?:\/\//i.test(text)) {
    try {
      const fromLink = new URL(text).searchParams.get("receipt");
      if (fromLink && isReceiptId(fromLink)) return { kind: "receipt", receiptId: fromLink };
    } catch {
      // Fall through to the error below.
    }
    return { kind: "invalid", message: "That link has no receipt ID in it." };
  }

  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: "invalid", message: "That looks like JSON but does not parse." };
    }
    const tokens: { token: string; slot: StatementKind | null }[] = [];
    if (json && typeof json === "object") {
      for (const slot of ["payment", "delivery", "refund"] as const) {
        const value = (json as Record<string, unknown>)[slot];
        if (typeof value === "string" && COMPACT_JWS.test(value.trim())) {
          tokens.push({ token: value.trim(), slot });
        }
      }
    }
    return tokens.length > 0
      ? { kind: "statements", tokens }
      : { kind: "invalid", message: "No payment, delivery or refund statement in that JSON." };
  }

  const parts = text
    .split(/[\s,]+/)
    .map((part) => part.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const tokens = [...new Set(parts.filter((part) => COMPACT_JWS.test(part)))];
  if (tokens.length === 0) {
    return {
      kind: "invalid",
      message:
        "Not a receipt ID (rcpt_…) or a signed statement (a JWS: three base64url parts joined by dots).",
    };
  }
  if (tokens.length > 10) return { kind: "invalid", message: "Paste at most 10 statements." };
  return { kind: "statements", tokens: tokens.map((token) => ({ token, slot: null })) };
}

export class VerifyFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

let keysPromise: Promise<JSONWebKeySet> | null = null;

/** BotFare's public receipt keys from this origin (fetched once per page load). */
export function fetchReceiptKeys(): Promise<JSONWebKeySet> {
  if (!keysPromise) {
    keysPromise = (async () => {
      let response: Response;
      try {
        response = await fetch(RECEIPT_KEYS_PATH, { cache: "no-store" });
      } catch {
        throw new VerifyFetchError("Could not reach BotFare to fetch its public keys.", null);
      }
      if (!response.ok) {
        throw new VerifyFetchError(
          response.status === 404
            ? "BotFare's receipt keys are not published on this server yet."
            : `Fetching BotFare's public keys failed (HTTP ${response.status}).`,
          response.status,
        );
      }
      const body = (await response.json().catch(() => null)) as JSONWebKeySet | null;
      if (!body || !Array.isArray(body.keys)) {
        throw new VerifyFetchError("BotFare's key directory is not a JWKS.", response.status);
      }
      return body;
    })();
    // A failed fetch can be retried.
    keysPromise.catch(() => {
      keysPromise = null;
    });
  }
  return keysPromise;
}

/** The latest signed statements for a receipt, or null when BotFare has no such receipt. */
export async function fetchReceiptStatements(receiptId: string): Promise<ReceiptStatements | null> {
  let response: Response;
  try {
    response = await fetch(receiptStatementsPath(receiptId), { cache: "no-store" });
  } catch {
    throw new VerifyFetchError("Could not reach BotFare to look up the receipt.", null);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new VerifyFetchError(
      `Looking up the receipt failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as ReceiptStatements | null;
  if (!body || typeof body !== "object") {
    throw new VerifyFetchError(
      "The receipt lookup returned something unexpected.",
      response.status,
    );
  }
  return body;
}

export interface CheckedStatement {
  token: string;
  /** Which slot of the receipt lookup it came from, if any. */
  slot: StatementKind | null;
  result: VerifyStatementResult;
  /** Claims decoded without verification, so a failed statement can still be read. */
  decoded: BotFareStatement | null;
  header: Record<string, unknown> | null;
}

export async function checkStatement(
  token: string,
  slot: StatementKind | null,
  keys: JSONWebKeySet,
): Promise<CheckedStatement> {
  const result = await verifyStatement(token, keys, slot ? { kind: slot } : {});
  let header: Record<string, unknown> | null = null;
  try {
    header = decodeProtectedHeader(token) as Record<string, unknown>;
  } catch {
    header = null;
  }
  return { token, slot, result, decoded: decodeStatement(token), header };
}

/** Decodes the payload segment of a JWS for display (no verification). */
export function decodePayloadJson(token: string): unknown {
  try {
    const segment = token.split(".")[1] ?? "";
    const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
