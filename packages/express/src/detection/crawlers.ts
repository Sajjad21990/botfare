/**
 * Known AI crawlers, checked against their operators' published IP ranges (bundled snapshot in
 * crawler-ranges.json; each source records its URL and fetch date). A crawler user agent from
 * inside its ranges is the real crawler; from outside, it is an impostor. Crawlers whose operator
 * publishes no machine-readable list are "unverifiable" and identified by user agent only.
 */
import { BlockList, isIP } from "node:net";
import { KNOWN_AI_BOTS } from "@botfare/contracts";
import ranges from "./crawler-ranges.json" with { type: "json" };

export type KnownBot = (typeof KNOWN_AI_BOTS)[number];

export type CrawlerCheck =
  | { status: "none" }
  /** UA of a known crawler and the client IP is in its published ranges. */
  | { status: "verified"; bot: KnownBot; source: string }
  /** UA of a known crawler whose operator publishes no list; trusted by UA only. */
  | { status: "unverifiable"; bot: KnownBot }
  /** UA of a known crawler, but the client IP is outside its published ranges. */
  | { status: "impostor"; bot: KnownBot; ip: string | undefined };

interface RangesFile {
  sources: Record<string, { url: string; fetchedAt: string; prefixes: string[] }>;
  bots: Record<string, string | { unverifiable: string }>;
}

const data = ranges as RangesFile;

const blockLists = new Map<string, BlockList>();
for (const [name, source] of Object.entries(data.sources)) {
  const list = new BlockList();
  for (const prefix of source.prefixes) {
    const [net, bits] = prefix.split("/");
    if (!net || !bits) continue;
    const type = isIP(net) === 6 ? "ipv6" : "ipv4";
    list.addSubnet(net, Number(bits), type);
  }
  blockLists.set(name, list);
}

/** The known AI crawler named in a user agent (first match in KNOWN_AI_BOTS order). */
export function knownBotFromUserAgent(userAgent: string | undefined): KnownBot | undefined {
  const ua = userAgent?.toLowerCase() ?? "";
  if (!ua) return undefined;
  return KNOWN_AI_BOTS.find((bot) => ua.includes(bot.toLowerCase()));
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything that is not an IP → undefined. */
export function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const bare = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return isIP(bare) ? bare : undefined;
}

export function checkCrawler(userAgent: string | undefined, ip: string | undefined): CrawlerCheck {
  const bot = knownBotFromUserAgent(userAgent);
  if (!bot) return { status: "none" };
  const source = data.bots[bot];
  if (typeof source !== "string") return { status: "unverifiable", bot };
  const list = blockLists.get(source);
  if (!list) return { status: "unverifiable", bot };
  const address = normalizeIp(ip);
  if (address && list.check(address, isIP(address) === 6 ? "ipv6" : "ipv4")) {
    return { status: "verified", bot, source: data.sources[source]?.url ?? source };
  }
  return { status: "impostor", bot, ip: address };
}

/** One published address per verifiable crawler source, for tests and demos. */
export function sampleCrawlerIp(bot: KnownBot): string | undefined {
  const source = data.bots[bot];
  if (typeof source !== "string") return undefined;
  const prefix = data.sources[source]?.prefixes.find((p) => isIP(p.split("/")[0] ?? "") === 4);
  return prefix?.split("/")[0];
}
