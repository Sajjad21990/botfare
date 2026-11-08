/**
 * The detection engine: decides whether a request on a priced path pays, and records why.
 * Score-based, never a hard block: a request is either served free or offered an x402 price, and
 * a suspected human (charged only on a score) can pass the human check and read free.
 *
 * Signals, strongest first. The first one that charges at the site's level becomes the receipt's
 * signal; every one seen feeds the automation score and the reasons.
 *
 * | Signal              | Seen when                                              | Charges at        |
 * | ------------------- | ------------------------------------------------------ | ----------------- |
 * | `signed-agent`      | valid Web Bot Auth signature from a BotFare agent key   | every level       |
 * | `agent-header`      | `X-BotFare-Agent` header                               | every level       |
 * | `known-bot`         | AI crawler UA from its published IPs (or unverifiable   | known-bots and up |
 * |                     | crawler by UA, or a CDN-verified bot)                   |                   |
 * | `bot-impostor`      | AI crawler UA from outside its published IPs (score 90) | known-bots and up |
 * | `edge-score`        | CDN bot score (Cloudflare, Akamai), when enabled        | standard, strict* |
 * | `automation`        | header heuristics (heuristics.ts)                       | standard, strict* |
 * | `payment-signature` | an x402 payment and nothing above                       | every level       |
 *
 * (*) when the score reaches the threshold (standard 60, strict 40, or the site's own) and no
 * valid human pass is presented. A payment is checked last so a paid retry records the same
 * signal as the 402 that asked for it. On an "everyone" path every request pays; the signal is
 * the strongest one seen, or "everyone".
 */
import type { DetectionLevel, DetectionSignal, SiteConfig } from "@botfare/contracts";
import { AGENT_HEADER } from "@botfare/contracts";
import { checkCrawler } from "./crawlers";
import { checkEdge } from "./edge";
import { automationScore } from "./heuristics";
import type { HumanPass } from "./human-pass";
import type { Detection, DetectionRequest } from "./types";
import { checkSignedAgent, hasSignatureHeaders, type SignatureDirectory } from "./web-bot-auth";

export interface DetectOptions {
  /** BotFare's signing-key directory; without it signatures are ignored. */
  directory?: SignatureDirectory;
  /** Verifies the human-pass cookie; without it no cookie is honoured. */
  humanPass?: HumanPass;
  /** Audience of the matched pricing rule. Default "agents". */
  audience?: "agents" | "everyone";
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
}

const LEVEL_RANK: Record<DetectionLevel, number> = {
  off: 0,
  "known-bots": 1,
  standard: 2,
  strict: 3,
};

export const DEFAULT_THRESHOLDS = { standard: 60, strict: 40 } as const;

export interface EffectiveDetection {
  level: DetectionLevel;
  /** Score at or above which edge/automation charge; undefined below "standard". */
  threshold: number | undefined;
  edge: SiteConfig["detection"]["edge"] | undefined;
  turnstileSiteKey: string | null;
}

/**
 * The site's detection settings, with the legacy switch folded in: `chargeKnownBots: true` raises
 * the level to at least "known-bots". A config without `detection` (older BotFare) behaves as
 * before: "known-bots" if `chargeKnownBots`, else "off".
 */
export function effectiveDetection(
  config: Pick<SiteConfig, "chargeKnownBots"> & { detection?: SiteConfig["detection"] },
): EffectiveDetection {
  const configured = config.detection?.level ?? "off";
  const level =
    config.chargeKnownBots && LEVEL_RANK[configured] < LEVEL_RANK["known-bots"]
      ? "known-bots"
      : configured;
  const threshold =
    level === "standard" || level === "strict"
      ? (config.detection?.threshold ?? DEFAULT_THRESHOLDS[level])
      : undefined;
  return {
    level,
    threshold,
    edge: config.detection?.edge,
    turnstileSiteKey: config.detection?.turnstileSiteKey ?? null,
  };
}

interface Candidate {
  signal: DetectionSignal;
  score: number;
  charges: boolean;
}

export async function detectAgent(
  req: DetectionRequest,
  config: Pick<SiteConfig, "chargeKnownBots"> & { detection?: SiteConfig["detection"] },
  options: DetectOptions = {},
): Promise<Detection> {
  const nowMs = (options.now ?? Date.now)();
  const nowSeconds = Math.floor(nowMs / 1000);
  const { level, threshold, edge: edgeConfig } = effectiveDetection(config);
  const rank = LEVEL_RANK[level];
  const reasons: string[] = [];
  const candidates: Candidate[] = [];

  // Signed agents. A bad signature is ignored, never held against the request.
  if (hasSignatureHeaders(req)) {
    const signed = await checkSignedAgent(req, options.directory, nowSeconds);
    if (signed.status === "valid") {
      candidates.push({ signal: "signed-agent", score: 100, charges: true });
      reasons.push(`signed agent ${signed.agentKeyId ?? signed.keyid}`);
    } else if (signed.status === "invalid") {
      reasons.push(`signature ignored: ${signed.reason}`);
    }
  }

  if (req.get(AGENT_HEADER) !== undefined) {
    candidates.push({ signal: "agent-header", score: 100, charges: true });
    reasons.push(`${AGENT_HEADER} header`);
  }

  // Known AI crawlers, checked against their published IP ranges; CDN verification wins ties.
  const edge = checkEdge(req, edgeConfig);
  const crawler = checkCrawler(req.get("user-agent"), req.ip);
  const knownBots = rank >= LEVEL_RANK["known-bots"];
  if (crawler.status === "verified") {
    candidates.push({ signal: "known-bot", score: 100, charges: knownBots });
    reasons.push(`${crawler.bot} from its published IP ranges`);
  } else if (crawler.status === "unverifiable") {
    candidates.push({ signal: "known-bot", score: 100, charges: knownBots });
    reasons.push(`${crawler.bot} by user agent (no published IP list)`);
  } else if (crawler.status === "impostor" && !edge.verifiedBot) {
    candidates.push({ signal: "bot-impostor", score: 90, charges: knownBots });
    reasons.push(`claims ${crawler.bot} from ${crawler.ip ?? "an unknown IP"}, outside its ranges`);
  }
  if (edge.verifiedBot) candidates.push({ signal: "known-bot", score: 100, charges: knownBots });
  reasons.push(...edge.reasons);

  // Scores. A human pass (Turnstile) switches these off for 24 h.
  const humanPass = options.humanPass?.fromCookieHeader(req.get("cookie"), nowSeconds) ?? false;
  const scored = threshold !== undefined && !humanPass;
  if (edge.bot) {
    candidates.push({
      signal: "edge-score",
      score: edge.score,
      charges: scored && edge.score >= (threshold ?? 101),
    });
  }
  const automation = automationScore(req);
  reasons.push(...automation.reasons);
  if (automation.score > 0) {
    candidates.push({
      signal: "automation",
      score: automation.score,
      charges: scored && automation.score >= (threshold ?? 101),
    });
  }
  if (humanPass) reasons.push("human pass cookie");

  const score = Math.max(0, ...candidates.map((c) => c.score));
  const winner = candidates.find((c) => c.charges);
  const paid = Boolean(req.get("payment-signature"));

  let signal: DetectionSignal | null;
  if (options.audience === "everyone") {
    signal = winner?.signal ?? "everyone";
  } else if (winner) {
    signal = winner.signal;
  } else if (paid) {
    signal = "payment-signature";
    reasons.push("arrived with an x402 payment");
  } else {
    signal = null;
  }
  const humanCheckable =
    options.audience !== "everyone" && (signal === "edge-score" || signal === "automation");

  return { charge: signal !== null, signal, score, reasons, humanCheckable, humanPass };
}
