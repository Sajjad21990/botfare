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

/** Sliding-window turn counter per key. */
export class TurnLimiter {
  private log = new Map<string, number[]>();

  constructor(
    private readonly limit = AI_TURN_LIMIT,
    private readonly windowMs = AI_TURN_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const recent = (this.log.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.log.set(key, recent);
      return false;
    }
    recent.push(now);
    this.log.set(key, recent);
    return true;
  }
}

/** The caller's IP as Render's proxy reports it (first X-Forwarded-For entry). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "local";
}
