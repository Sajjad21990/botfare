/**
 * Bot scores from a CDN in front of the publisher, read from request headers the CDN adds.
 * Each is used only when enabled in the site's detection settings, because any client can send
 * these headers straight to an origin that is not behind that CDN.
 *
 * Cloudflare (Bot Management; forward `cf.bot_management.score` and `.verified_bot` with a
 * Transform Rule): score header `1..99` (1 = bot, 99 = human). A score at or below `maxBotScore`
 * is an "edge-score" signal with automation score `100 - cfScore`. Verified-bot header `true`
 * (or `1`) makes the request a known bot.
 *
 * Akamai (Bot Manager; forward the bot result in a header with a property rule). Accepted values,
 * case-insensitive:
 *   - `verified`, `verified-bot`, `known-bot`             → known bot
 *   - `bot`, `true`, `1`, `yes`, `automated`, `unverified`,
 *     `unverified-bot`, `suspected-bot`, `bad-bot`          → edge-score, automation score 90
 *   - an integer 0..100 (Akamai bot score; 100 = bot)       → edge-score with that score
 *   - `human`, `false`, `0`, `no`, `none`, anything else    → no signal
 */
import type { DetectionConfig } from "@botfare/contracts";
import type { DetectionRequest } from "./types";

export type EdgeCheck = {
  /** Highest automation score any enabled CDN reported, or 0. */
  score: number;
  /** True when a CDN says this is a bot (Cloudflare at or below maxBotScore, or Akamai bot). */
  bot: boolean;
  /** A CDN vouches for a verified (known, good) bot. */
  verifiedBot: boolean;
  reasons: string[];
};

const AKAMAI_VERIFIED = new Set(["verified", "verified-bot", "known-bot"]);
const AKAMAI_BOT = new Set([
  "bot",
  "true",
  "1",
  "yes",
  "automated",
  "unverified",
  "unverified-bot",
  "suspected-bot",
  "bad-bot",
]);
const AKAMAI_BOT_SCORE = 90;

export function checkEdge(
  req: DetectionRequest,
  edge: DetectionConfig["edge"] | undefined,
): EdgeCheck {
  const result: EdgeCheck = { score: 0, bot: false, verifiedBot: false, reasons: [] };
  const cf = edge?.cloudflare;
  if (cf?.enabled) {
    const verified = req.get(cf.verifiedBotHeader)?.trim().toLowerCase();
    if (verified === "true" || verified === "1") {
      result.verifiedBot = true;
      result.reasons.push("Cloudflare verified bot");
    }
    const raw = req.get(cf.scoreHeader)?.trim();
    const cfScore = raw && /^\d{1,2}$/.test(raw) ? Number(raw) : undefined;
    if (cfScore !== undefined && cfScore >= 1 && cfScore <= 99 && cfScore <= cf.maxBotScore) {
      result.bot = true;
      result.score = Math.max(result.score, 100 - cfScore);
      result.reasons.push(`Cloudflare bot score ${cfScore} (≤ ${cf.maxBotScore})`);
    }
  }
  const akamai = edge?.akamai;
  if (akamai?.enabled) {
    const value = req.get(akamai.header)?.trim().toLowerCase();
    if (value) {
      if (AKAMAI_VERIFIED.has(value)) {
        result.verifiedBot = true;
        result.reasons.push("Akamai verified bot");
      } else if (AKAMAI_BOT.has(value)) {
        result.bot = true;
        result.score = Math.max(result.score, AKAMAI_BOT_SCORE);
        result.reasons.push(`Akamai bot (${value})`);
      } else if (/^\d{1,3}$/.test(value) && Number(value) <= 100 && Number(value) > 0) {
        result.bot = true;
        result.score = Math.max(result.score, Number(value));
        result.reasons.push(`Akamai bot score ${value}`);
      }
    }
  }
  return result;
}
