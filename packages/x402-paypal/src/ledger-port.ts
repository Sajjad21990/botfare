import type { JWK } from "jose";
import type { ErrorReason } from "./constants";

/** What the facilitator needs to know about an agent key. */
export interface AgentKeyRecord {
  keyId: string;
  publicJwk: JWK;
  status: "active" | "revoked";
}

/** One payment the facilitator wants checked or charged. */
export interface ChargeRequest {
  keyId: string;
  nonce: string;
  amountCents: number;
  /** BotFare site ID being paid. */
  payTo: string;
  network: string;
  resourceUrl?: string;
  /** Unix seconds after which the authorization (and its nonce) is dead. */
  expiresAt: number;
  /**
   * The publisher's `extra` from the payment requirements, as the resource server sent them to
   * verify/settle (BotFare's middleware puts `botfareSignal` here: why it asked for payment).
   */
  extra?: Record<string, unknown>;
}

/** A refusal. For a reused nonce, `originalTransaction` names the receipt it was charged under. */
export interface LedgerRefusal {
  ok: false;
  reason: ErrorReason;
  message?: string;
  originalTransaction?: string;
}

export type LedgerDecision = { ok: true } | LedgerRefusal;

export type ChargeResult = { ok: true; transaction: string } | LedgerRefusal;

/**
 * Where balances, budgets and nonces live. BotFare implements this on Postgres; tests and the
 * spike use the in-memory version.
 *
 * `charge` must be atomic: consume the nonce, enforce caps and balance, move the money and write
 * the receipt in one database transaction, serialized per agent key and wallet (e.g. `SELECT ...
 * FOR UPDATE` on both rows) so concurrent charges cannot both pass the balance or daily-cap check.
 * Nonces are single-use per key and must be kept at least until `expiresAt` plus clock skew.
 * A reused nonce is refused with `invalid_prepaid_nonce_used` and the original receipt's ID, so
 * replays never deliver content twice but a lost settle response can still be reconciled.
 */
export interface PrepaidLedgerPort {
  getAgentKey(keyId: string): Promise<AgentKeyRecord | null>;
  /** Read-only checks (verify must not commit payment state). */
  check(request: ChargeRequest): Promise<LedgerDecision>;
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
