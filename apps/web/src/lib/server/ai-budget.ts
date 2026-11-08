/**
 * Spend limits for the analytics assistant, which runs on the server's ANTHROPIC_API_KEY while
 * every judge shares the same two persona users. In memory, per server instance (botfare-web runs
 * one), which is enough to stop a script from running up the bill; the Anthropic workspace's own
 * spend limit is the backstop.
 */
import type { AgLlmResponse } from "ag-studio";

/** Input-token equivalents per hour and per day across all users. */
export const AI_HOURLY_TOKEN_BUDGET = 3_000_000;
export const AI_DAILY_TOKEN_BUDGET = 15_000_000;
/** Turns per visitor (user and IP) per window. One question can take a dozen agent turns. */
export const AI_TURN_LIMIT = 150;
export const AI_TURN_WINDOW_MS = 10 * 60 * 1000;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Usage weighted by price relative to fresh input tokens: cache reads cost a tenth, cache writes
 * 1.25x, output 5x. So the budget tracks dollars, not raw token counts.
 */
export function weightedTokens(usage: AgLlmResponse["usage"]): number {
  if (!usage) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached - written);
  return Math.ceil(fresh + written * 1.25 + cached * 0.1 + usage.outputTokens * 5);
}

/** Rough upper estimate of a request's input tokens from its size, reserved before the call. */
export function estimateTokens(bodyBytes: number): number {
  return Math.ceil(bodyBytes / 3);
}

interface Spend {
  at: number;
  tokens: number;
}

export class TokenBudget {
  private spends: Spend[] = [];

  constructor(
    private readonly limits: { windowMs: number; tokens: number }[] = [
      { windowMs: HOUR_MS, tokens: AI_HOURLY_TOKEN_BUDGET },
      { windowMs: DAY_MS, tokens: AI_DAILY_TOKEN_BUDGET },
    ],
    private readonly now: () => number = Date.now,
  ) {}

  /** Reserves `tokens` if every window has room; settle the reservation with the real usage. */
  reserve(tokens: number): Spend | null {
    const now = this.now();
    const longest = Math.max(...this.limits.map((limit) => limit.windowMs));
    this.spends = this.spends.filter((spend) => now - spend.at < longest);
    for (const limit of this.limits) {
      const used = this.spends
        .filter((spend) => now - spend.at < limit.windowMs)
        .reduce((sum, spend) => sum + spend.tokens, 0);
      if (used + tokens > limit.tokens) return null;
    }
    const spend = { at: now, tokens };
    this.spends.push(spend);
    return spend;
  }

  /** Replaces a reservation with what the call really used. */
  settle(spend: Spend, tokens: number): void {
    spend.tokens = tokens;
  }
}

/** Most keys a limiter remembers; past this, expired keys are swept and then the oldest dropped. */
export const MAX_LIMITER_KEYS = 10_000;
/** Longest key a limiter stores (longer keys are cut). */
const MAX_KEY_LENGTH = 200;

/**
 * Sliding-window turn counter per key. Memory is bounded: keys whose turns have all left the window
 * are swept once per window, and at most `maxKeys` keys are kept (least recently used go first).
 */
export class TurnLimiter {
  private log = new Map<string, number[]>();
  private lastSweep: number;

  constructor(
    private readonly limit = AI_TURN_LIMIT,
    private readonly windowMs = AI_TURN_WINDOW_MS,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = MAX_LIMITER_KEYS,
  ) {
    this.lastSweep = this.now();
  }

  allow(rawKey: string): boolean {
    const key = rawKey.slice(0, MAX_KEY_LENGTH);
    const now = this.now();
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);
    const recent = (this.log.get(key) ?? []).filter((at) => now - at < this.windowMs);
    // Re-insert so the Map's order is least recently used first.
    this.log.delete(key);
    if (recent.length >= this.limit) {
      this.log.set(key, recent);
      return false;
    }
    recent.push(now);
    if (this.log.size >= this.maxKeys) {
      this.sweep(now);
      for (const oldest of this.log.keys()) {
        if (this.log.size < this.maxKeys) break;
        this.log.delete(oldest);
      }
    }
    this.log.set(key, recent);
    return true;
  }

  /** How many keys are remembered (tests). */
  get size(): number {
    return this.log.size;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [key, times] of this.log) {
      if (times.every((at) => now - at >= this.windowMs)) this.log.delete(key);
    }
  }
}

const IP_PATTERN = /^[0-9A-Fa-f:.]{2,45}$/;

function ipOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && IP_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * The caller's IP, from headers the caller cannot choose on Render: True-Client-IP (set by the
 * Cloudflare edge in front of Render, replacing any sent by the client), else the LAST
 * X-Forwarded-For entry (the hop our own proxy appended; earlier entries are whatever the client
 * sent), else X-Real-IP. Only IP-shaped values count, so a key is never longer than 45 characters.
 */
export function clientIp(request: Request): string {
  return (
    ipOrNull(request.headers.get("true-client-ip")) ??
    ipOrNull(request.headers.get("x-forwarded-for")?.split(",").at(-1)) ??
    ipOrNull(request.headers.get("x-real-ip")) ??
    "local"
  );
}
