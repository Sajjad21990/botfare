/**
 * Copy-paste curl commands for "See a 402 yourself" on /judge, against the demo publisher.
 * Crema Notes runs at the Standard detection level: a request with real browser headers reads
 * free, while `x-botfare-agent: 1` (or a plain curl user agent) gets an x402 price.
 */
export const DEMO_ARTICLE_PATH = "/articles/burr-basics";

/** A desktop Chrome user agent with the headers a real browser sends on a navigation. */
const BROWSER_HEADERS = [
  "-A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'",
  "-H 'Accept: text/html'",
  "-H 'Accept-Language: en-US,en;q=0.9'",
  "-H 'Sec-Fetch-Site: none'",
  "-H 'Sec-Fetch-Mode: navigate'",
  "-H 'Sec-Fetch-Dest: document'",
];

/** The demo site's public base URL without a trailing slash. */
export function demoBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() || "http://localhost:4000";
  return value.replace(/\/+$/, "");
}

export function demoCommands(baseUrl: string) {
  const url = `${baseUrl}${DEMO_ARTICLE_PATH}`;
  return {
    url,
    human: [
      `curl -s -o /dev/null -w '%{http_code}\\n' \\`,
      ...BROWSER_HEADERS.map((h) => `  ${h} \\`),
      `  ${url}`,
    ].join("\n"),
    agent: `curl -i -H 'x-botfare-agent: 1' ${url}`,
    decode: [
      `curl -s -o /dev/null -D - -H 'x-botfare-agent: 1' ${url} \\`,
      "  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\\r' \\",
      "  | base64 --decode | jq .",
    ].join("\n"),
  };
}
