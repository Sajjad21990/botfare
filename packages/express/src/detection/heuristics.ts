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
 * | Desktop-browser user agent without Accept-Language           | 30     |
 * | Desktop-browser user agent without any Sec-Fetch-* header    | 30     |
 *
 * A real desktop browser always sends Accept-Language, and Chrome, Edge, Firefox and Safari 16.4+
 * send Sec-Fetch-* to HTTPS and localhost origins, so a person in a normal browser scores 0
 * (30 at most over plain HTTP to a LAN address, below every default threshold). A script that
 * fakes a browser user agent but sends neither header scores 60. No IP reputation lists are used.
 */
import type { DetectionRequest } from "./types";

export const AUTOMATION_WEIGHTS = {
  httpClient: 80,
  headless: 80,
  emptyUserAgent: 70,
  noAcceptLanguage: 30,
  noSecFetch: 30,
} as const;

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
    const client = HTTP_CLIENTS.find(([pattern]) => pattern.test(ua));
    if (client) add(AUTOMATION_WEIGHTS.httpClient, `HTTP client library (${client[1]})`);
    const headless = HEADLESS.find(([pattern]) => pattern.test(ua));
    if (headless) add(AUTOMATION_WEIGHTS.headless, `automation browser (${headless[1]})`);
    if (claimsDesktopBrowser(ua)) {
      if (!req.get("accept-language")) {
        add(AUTOMATION_WEIGHTS.noAcceptLanguage, "browser user agent without Accept-Language");
      }
      const secFetch = ["sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"];
      if (!secFetch.some((name) => req.get(name))) {
        add(AUTOMATION_WEIGHTS.noSecFetch, "browser user agent without Sec-Fetch-*");
      }
    }
  }
  return { score: Math.min(100, score), reasons };
}
