export { checkCrawler, knownBotFromUserAgent, normalizeIp, sampleCrawlerIp } from "./crawlers";
export {
  DEFAULT_THRESHOLDS,
  type DetectOptions,
  detectAgent,
  type EffectiveDetection,
  effectiveDetection,
} from "./detect";
export { checkEdge } from "./edge";
export { AUTOMATION_WEIGHTS, automationScore, claimsDesktopBrowser } from "./heuristics";
export { HUMAN_PASS_COOKIE, HUMAN_PASS_TTL_SECONDS, HumanPass } from "./human-pass";
export type { Detection, DetectionRequest } from "./types";
export {
  checkSignedAgent,
  jwkThumbprint,
  SignatureDirectory,
  WEB_BOT_AUTH_TAG,
} from "./web-bot-auth";
