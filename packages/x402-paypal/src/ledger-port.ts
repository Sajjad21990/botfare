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
}

export type LedgerDecision = { ok: true } | { ok: false; reason: ErrorReason; message?: string };

export type ChargeResult =
  | { ok: true; transaction: string }
  | { ok: false; reason: ErrorReason; message?: string };

/**
 * Where balances, budgets and nonces live. BotFare implements this on Postgres; tests and the
 * spike use the in-memory version. `charge` must be atomic: consume the nonce, enforce caps and
 * balance, and move the money in one step.
 */
export interface PrepaidLedgerPort {
  getAgentKey(keyId: string): Promise<AgentKeyRecord | null>;
  /** Read-only checks (verify must not commit payment state). */
  check(request: ChargeRequest): Promise<LedgerDecision>;
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
