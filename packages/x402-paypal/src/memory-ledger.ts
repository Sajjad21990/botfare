import type { JWK } from "jose";
import { ErrorReason } from "./constants";
import type {
  AgentKeyRecord,
  ChargeRequest,
  ChargeResult,
  LedgerDecision,
  PrepaidLedgerPort,
} from "./ledger-port";
import { centsToMicros } from "./money";

/** BotFare keeps 5% of every paid request; the publisher earns the rest. */
export const PLATFORM_FEE_BPS = 500;

export interface MemoryAgentKey extends AgentKeyRecord {
  walletId: string;
  perRequestMaxCents?: number;
  dailyCapCents?: number;
  allowedPayTo?: string[];
}

export interface MemoryReceipt extends ChargeRequest {
  transaction: string;
  amountMicros: number;
  feeMicros: number;
  createdAt: Date;
}

/**
 * In-memory ledger for tests and the spike. Same rules as the Postgres ledger, without
 * durability. JavaScript runs one charge at a time, so `charge` is atomic here.
 */
export class InMemoryLedger implements PrepaidLedgerPort {
  readonly balances = new Map<string, number>();
  readonly receipts: MemoryReceipt[] = [];
  private readonly keys = new Map<string, MemoryAgentKey>();
  private readonly usedNonces = new Set<string>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  addKey(key: Omit<MemoryAgentKey, "status"> & { publicJwk: JWK; status?: "active" | "revoked" }) {
    this.keys.set(key.keyId, { status: "active", ...key });
  }

  topUp(walletId: string, cents: number) {
    this.move(`wallet:${walletId}`, centsToMicros(cents));
    this.move("paypal:clearing", -centsToMicros(cents));
  }

  balanceMicros(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  async getAgentKey(keyId: string): Promise<AgentKeyRecord | null> {
    return this.keys.get(keyId) ?? null;
  }

  async check(request: ChargeRequest): Promise<LedgerDecision> {
    const key = this.keys.get(request.keyId);
    if (!key) return { ok: false, reason: ErrorReason.UnknownKey };
    if (this.usedNonces.has(nonceKey(request))) {
      return { ok: false, reason: ErrorReason.NonceUsed, message: "Payment already used" };
    }
    if (key.allowedPayTo && !key.allowedPayTo.includes(request.payTo)) {
      return {
        ok: false,
        reason: ErrorReason.SiteNotAllowed,
        message: "Key may not pay this site",
      };
    }
    if (key.perRequestMaxCents !== undefined && request.amountCents > key.perRequestMaxCents) {
      return { ok: false, reason: ErrorReason.OverPerRequestMax, message: "Over per-request max" };
    }
    if (
      key.dailyCapCents !== undefined &&
      this.spentTodayCents(key.keyId) + request.amountCents > key.dailyCapCents
    ) {
      return { ok: false, reason: ErrorReason.OverDailyCap, message: "Over daily cap" };
    }
    if (this.balanceMicros(`wallet:${key.walletId}`) < centsToMicros(request.amountCents)) {
      return {
        ok: false,
        reason: ErrorReason.InsufficientFunds,
        message: "Wallet balance too low",
      };
    }
    return { ok: true };
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const decision = await this.check(request);
    if (!decision.ok) return decision;
    const key = this.keys.get(request.keyId) as MemoryAgentKey;
    const amountMicros = centsToMicros(request.amountCents);
    const feeMicros = Math.floor((amountMicros * PLATFORM_FEE_BPS) / 10_000);

    this.usedNonces.add(nonceKey(request));
    this.move(`wallet:${key.walletId}`, -amountMicros);
    this.move(`earnings:${request.payTo}`, amountMicros - feeMicros);
    this.move("platform:fees", feeMicros);

    const transaction = `rcpt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.receipts.push({ ...request, transaction, amountMicros, feeMicros, createdAt: this.now() });
    return { ok: true, transaction };
  }

  /** Every account summed together; always zero in a correct double-entry ledger. */
  totalMicros(): number {
    let total = 0;
    for (const value of this.balances.values()) total += value;
    return total;
  }

  private spentTodayCents(keyId: string): number {
    const today = this.now().toISOString().slice(0, 10);
    return this.receipts
      .filter((r) => r.keyId === keyId && r.createdAt.toISOString().slice(0, 10) === today)
      .reduce((sum, r) => sum + r.amountCents, 0);
  }

  private move(account: string, micros: number) {
    this.balances.set(account, this.balanceMicros(account) + micros);
  }
}

function nonceKey(request: ChargeRequest): string {
  return `${request.keyId}:${request.nonce}`;
}
