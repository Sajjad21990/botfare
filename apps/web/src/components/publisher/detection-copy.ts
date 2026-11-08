/**
 * Plain-language names for agent detection, shared by the publisher's "Bot detection" panel and the
 * analytics dashboard. Plain data (no React), so server code can import it too.
 */
import type { DetectionLevel, DetectionSignal } from "@botfare/contracts";

/** Shown for receipts settled before signals were recorded, or by older middleware. */
export const UNRECORDED_SIGNAL_LABEL = "Not recorded";

export const SIGNAL_LABELS: Record<DetectionSignal, string> = {
  "agent-header": "Agent header",
  "payment-signature": "Paid upfront (x402)",
  "signed-agent": "Signed agent",
  "known-bot": "Known AI crawler",
  "bot-impostor": "Crawler impostor",
  "edge-score": "CDN bot score",
  automation: "Automation signals",
  everyone: "Paid API (everyone)",
};

export const SIGNAL_DESCRIPTIONS: Record<DetectionSignal, string> = {
  "agent-header": "The agent said who it is with the BotFare agent header.",
  "payment-signature": "The request arrived with an x402 payment already attached.",
  "signed-agent": "A valid HTTP message signature from a BotFare agent key.",
  "known-bot": "A known AI crawler, from its published IP ranges.",
  "bot-impostor": "Claimed to be a known crawler but came from somewhere else.",
  "edge-score": "Your CDN (Cloudflare or Akamai) scored the request as a bot.",
  automation: "HTTP client libraries, headless browsers or missing browser headers.",
  everyone: "The path charges every caller, people included (APIs).",
};

export function signalLabel(signal: DetectionSignal | null | undefined): string {
  return signal ? SIGNAL_LABELS[signal] : UNRECORDED_SIGNAL_LABEL;
}

export interface LevelCopy {
  value: DetectionLevel;
  label: string;
  summary: string;
  /** Default score threshold when the publisher sets none (score-based levels only). */
  defaultThreshold?: number;
}

export const DETECTION_LEVELS: LevelCopy[] = [
  {
    value: "off",
    label: "Off",
    summary: "Only agents that say they are agents pay. Everyone else reads free.",
  },
  {
    value: "known-bots",
    label: "Known AI bots",
    summary: "Also charge AI crawlers that identify themselves, such as GPTBot or ClaudeBot.",
  },
  {
    value: "standard",
    label: "Standard",
    summary:
      "Also charge traffic that looks automated: CDN bot scores, crawler impostors, scripts and headless browsers.",
    defaultThreshold: 60,
  },
  {
    value: "strict",
    label: "Strict",
    summary:
      "Like Standard, but a lower score is enough. More bots pay; more people see the check.",
    defaultThreshold: 40,
  },
];
