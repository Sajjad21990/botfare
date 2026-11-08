/**
 * Automation heuristics: cheap request-header signs of a script rather than a person.
 *
 * Weights (summed, capped at 100; "standard" charges at 60, "strict" at 40):
 *
 * | Sign                                                         | Weight |
 * | ------------------------------------------------------------ | ------ |
 * | HTTP client library user agent (curl, python-requests, …)    | 80     |
 * | Headless / automation browser (HeadlessChrome, Puppeteer, …)  | 80     |
 * | Empty or missing user agent                                  | 70     |
 * | Any other user agent that is not a browser (no `Mozilla/`)   | 70     |
 * | Desktop-browser user agent without a real Accept-Language    | 30     |
 * | Desktop-browser user agent without Sec-Fetch-Site and -Dest  | 30     |
 *
 * A real desktop browser always sends a language list in Accept-Language, and Chrome, Edge,
 * Firefox and Safari 16.4+ send Sec-Fetch-Site, -Mode and -Dest together to HTTPS and localhost
 * origins, so a person in a normal browser scores 0 (30 at most over plain HTTP to a LAN address,
 * below every default threshold). A script that fakes a browser user agent scores 60: Node's
 * fetch, for one, sends `Accept-Language: *` and only `Sec-Fetch-Mode: cors`, which count as
 * missing. No IP reputation lists are used.
 *
 * Not a browser: every browser in use (desktop, mobile, in-app web views) sends a user agent with
 * a `Mozilla/` token, so a user agent without one ("research-bot/1.0", "MyScraper", a native app's
 * HTTP stack) is a program, not a person reading a page, and scores 70: charged at standard and
 * strict. No human check is offered (botfare() shows Turnstile only to browsers). Not counted:
 * - known AI crawlers, which have their own signals (`known-bot`, `bot-impostor`);
 * - link-preview fetchers of chat and social apps (Slack, Discord, Telegram, WhatsApp, iMessage,
 *   which sends facebookexternalhit/Twitterbot, LinkedIn, Teams/Skype, Mastodon). They fetch a link
 *   once, on behalf of a person who just shared it, to render a preview card from the page's
 *   <head>; charging them would break link sharing for the publisher's own readers. Their user
 *   agent is not scored at all, even when it names an HTTP library (LinkedIn's names
 *   Apache-HttpClient). A scraper can claim to be one of them, which is the same
 *   trade-off as copying a browser's headers.
 * Search crawlers that send no `Mozilla/` token (e.g. Googlebot-Image) score 70 too; most search
 * crawlers send one and are unaffected.
 */
import { knownBotFromUserAgent } from "./crawlers";
import type { DetectionRequest } from "./types";

export const AUTOMATION_WEIGHTS = {
  httpClient: 80,
  headless: 80,
  emptyUserAgent: 70,
  noAcceptLanguage: 30,
  noSecFetch: 30,
  nonBrowser: 70,
} as const;

/** Link-preview fetchers of chat and social apps, acting for a person who shared a link. */
const LINK_PREVIEW: [RegExp, string][] = [
  [/\bslackbot\b|slack-imgproxy/i, "Slack"],
  [/\bdiscordbot\b/i, "Discord"],
  [/\btelegrambot\b/i, "Telegram"],
  [/\bwhatsapp\//i, "WhatsApp"],
  [/\bfacebookexternalhit\b|\bfacebot\b/i, "Facebook/iMessage"],
  [/\btwitterbot\b/i, "X/iMessage"],
  [/\blinkedinbot\b/i, "LinkedIn"],
  [/\bskypeuripreview\b|\bmicrosoftpreview\b/i, "Teams/Skype"],
  [/\bmastodon\//i, "Mastodon"],
];

/** The chat or social app whose link-preview fetcher this user agent is, if any. */
export function linkPreviewApp(userAgent: string): string | undefined {
  return LINK_PREVIEW.find(([pattern]) => pattern.test(userAgent))?.[1];
}

/** A browser user agent of any kind: every browser in use sends a `Mozilla/` token. */
export function claimsBrowser(userAgent: string): boolean {
  return /\bMozilla\/\d/.test(userAgent);
}

const HTTP_CLIENTS: [RegExp, string][] = [
  [/\bcurl\//i, "curl"],
  [/\bwget\//i, "Wget"],
  [/python-requests/i, "python-requests"],
  [/python-urllib/i, "Python-urllib"],
  [/\bpython-httpx\b|\bhttpx\//i, "httpx"],
  [/\baiohttp\b/i, "aiohttp"],
  [/go-http-client/i, "Go-http-client"],
  [/node-fetch/i, "node-fetch"],
  [/\bundici\b/i, "undici"],
  [/^node$/i, "Node.js fetch"],
  [/\baxios\//i, "axios"],
  [/\bokhttp\b/i, "okhttp"],
  [/^java\/|\bjava-http-client\b|apache-httpclient/i, "Java"],
  [/\bscrapy\b/i, "Scrapy"],
  [/libwww-perl|\blwp::/i, "libwww"],
  [/\bhttpie\//i, "HTTPie"],
  [/^deno\/|^bun\//i, "Deno/Bun"],
];

const HEADLESS: [RegExp, string][] = [
  [/headlesschrome/i, "HeadlessChrome"],
  [/phantomjs/i, "PhantomJS"],
  [/playwright/i, "Playwright"],
  [/puppeteer/i, "Puppeteer"],
  [/\bselenium\b|webdriver/i, "Selenium"],
];

/** A desktop browser user agent: Mozilla/5.0 with a browser engine token and no mobile marker. */
export function claimsDesktopBrowser(userAgent: string): boolean {
  return (
    /^Mozilla\/5\.0 /.test(userAgent) &&
    /\b(Chrome|Firefox|Safari|Edg|OPR)\//.test(userAgent) &&
    !/\b(Mobile|Android|iPhone|iPad)\b/.test(userAgent)
  );
}

export function automationScore(req: DetectionRequest): { score: number; reasons: string[] } {
  const ua = req.get("user-agent")?.trim() ?? "";
  const reasons: string[] = [];
  let score = 0;
  const add = (weight: number, reason: string) => {
    score += weight;
    reasons.push(`${reason} (+${weight})`);
  };

  if (!ua) {
    add(AUTOMATION_WEIGHTS.emptyUserAgent, "empty user agent");
  } else {
    const preview = linkPreviewApp(ua);
    // A link-preview fetcher may name its HTTP library (LinkedIn's says Apache-HttpClient).
    const client = preview ? undefined : HTTP_CLIENTS.find(([pattern]) => pattern.test(ua));
    if (client) add(AUTOMATION_WEIGHTS.httpClient, `HTTP client library (${client[1]})`);
    const headless = HEADLESS.find(([pattern]) => pattern.test(ua));
    if (headless) add(AUTOMATION_WEIGHTS.headless, `automation browser (${headless[1]})`);
    if (preview) {
      reasons.push(`link preview for ${preview} (not scored)`);
    } else if (!client && !headless && !claimsBrowser(ua) && !knownBotFromUserAgent(ua)) {
      add(AUTOMATION_WEIGHTS.nonBrowser, "user agent is not a browser (no Mozilla/ token)");
    }
    if (claimsDesktopBrowser(ua)) {
      const language = req.get("accept-language")?.trim() ?? "";
      if (!language || language === "*") {
        add(AUTOMATION_WEIGHTS.noAcceptLanguage, "browser user agent without Accept-Language");
      }
      if (!req.get("sec-fetch-site") || !req.get("sec-fetch-dest")) {
        add(AUTOMATION_WEIGHTS.noSecFetch, "browser user agent without Sec-Fetch-*");
      }
    }
  }
  return { score: Math.min(100, score), reasons };
}
