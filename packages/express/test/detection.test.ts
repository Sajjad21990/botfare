import {
  AGENT_HEADER,
  DEFAULT_DETECTION,
  type DetectionConfig,
  SIGNATURE_DIRECTORY_PATH,
} from "@botfare/contracts";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DetectionRequest,
  type DetectOptions,
  detectAgent,
  effectiveDetection,
  HumanPass,
  SignatureDirectory,
  sampleCrawlerIp,
} from "../src/detection";
import { type Listening, listen, SITE_ID, SITE_SECRET } from "./helpers";
import { generateSigningKey, type SignOptions, signRequest } from "./signing";

const PUBLISHER = "http://crema.test:4100";
const NOT_A_CRAWLER_IP = "203.0.113.7"; // TEST-NET-3

/** Request headers of real browsers on a page navigation. */
const BROWSERS: Record<string, Record<string, string>> = {
  "Chrome (macOS)": {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
  },
  "Firefox (Windows)": {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-GB,en;q=0.5",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
  },
  "Safari (macOS)": {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-IN,en;q=0.9",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
  },
  "Safari (iPhone)": {
    "user-agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  },
  "Chrome over plain HTTP to a LAN address (no Sec-Fetch-*)": {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "de-DE,de;q=0.9",
  },
};

const CHROME = BROWSERS["Chrome (macOS)"] as Record<string, string>;
const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)";
const BYTESPIDER_UA =
  "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (compatible; Bytespider)";

function fakeReq(
  headers: Record<string, string>,
  init: { ip?: string; url?: string; method?: string; host?: string } = {},
): DetectionRequest {
  const all: Record<string, string> = { host: init.host ?? new URL(PUBLISHER).host };
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = value;
  return {
    method: init.method ?? "GET",
    originalUrl: init.url ?? "/articles/burr-basics",
    protocol: "http",
    ip: init.ip ?? NOT_A_CRAWLER_IP,
    get: (name) => all[name.toLowerCase()],
  };
}

function config(detection: Partial<DetectionConfig>, chargeKnownBots = false) {
  return { chargeKnownBots, detection: { ...DEFAULT_DETECTION, ...detection } };
}

const LEVELS = ["off", "known-bots", "standard", "strict"] as const;

describe("effectiveDetection", () => {
  it("folds chargeKnownBots into the level and fills thresholds", () => {
    expect(effectiveDetection(config({ level: "off" }, true)).level).toBe("known-bots");
    expect(effectiveDetection(config({ level: "strict" }, true)).level).toBe("strict");
    expect(effectiveDetection({ chargeKnownBots: false }).level).toBe("off");
    expect(effectiveDetection({ chargeKnownBots: true }).level).toBe("known-bots");
    expect(effectiveDetection(config({ level: "standard" })).threshold).toBe(60);
    expect(effectiveDetection(config({ level: "strict" })).threshold).toBe(40);
    expect(effectiveDetection(config({ level: "standard", threshold: 75 })).threshold).toBe(75);
    expect(effectiveDetection(config({ level: "known-bots" })).threshold).toBeUndefined();
  });
});

describe("detectAgent: people in normal browsers", () => {
  for (const [name, headers] of Object.entries(BROWSERS)) {
    for (const level of LEVELS) {
      it(`never charges ${name} at level ${level}`, async () => {
        const result = await detectAgent(fakeReq(headers), config({ level }));
        expect(result.charge).toBe(false);
        expect(result.signal).toBeNull();
        expect(result.score).toBeLessThan(40);
      });
    }
  }
});

describe("detectAgent: self-identified agents", () => {
  for (const level of LEVELS) {
    it(`charges the agent header at level ${level}`, async () => {
      const result = await detectAgent(
        fakeReq({ ...CHROME, [AGENT_HEADER]: "1" }),
        config({ level }),
      );
      expect(result).toMatchObject({ charge: true, signal: "agent-header", score: 100 });
    });

    it(`charges a bare x402 payment at level ${level}`, async () => {
      const result = await detectAgent(
        fakeReq({ ...CHROME, "payment-signature": "eyJ4NDAyVmVyc2lvbiI6Mn0=" }),
        config({ level }),
      );
      expect(result).toMatchObject({ charge: true, signal: "payment-signature" });
    });
  }

  it("records the signal that asked for payment, not payment-signature, on a paid retry", async () => {
    const result = await detectAgent(
      fakeReq({ [AGENT_HEADER]: "1", "payment-signature": "x" }),
      config({ level: "off" }),
    );
    expect(result.signal).toBe("agent-header");
  });
});

describe("detectAgent: known AI crawlers", () => {
  const gptbotIp = sampleCrawlerIp("GPTBot") as string;

  it("has a published GPTBot address to test with", () => {
    expect(gptbotIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("charges GPTBot from its published ranges from known-bots up, not at off", async () => {
    const req = fakeReq({ "user-agent": GPTBOT_UA }, { ip: gptbotIp });
    expect((await detectAgent(req, config({ level: "off" }))).charge).toBe(false);
    for (const level of ["known-bots", "standard", "strict"] as const) {
      const result = await detectAgent(req, config({ level }));
      expect(result, level).toMatchObject({ charge: true, signal: "known-bot", score: 100 });
    }
  });

  it("reads IPv4-mapped IPv6 client addresses", async () => {
    const req = fakeReq({ "user-agent": GPTBOT_UA }, { ip: `::ffff:${gptbotIp}` });
    expect((await detectAgent(req, config({ level: "known-bots" }))).signal).toBe("known-bot");
  });

  it("calls a GPTBot user agent from outside OpenAI's ranges an impostor (score 90)", async () => {
    const req = fakeReq({ "user-agent": GPTBOT_UA }, { ip: NOT_A_CRAWLER_IP });
    expect(await detectAgent(req, config({ level: "off" }))).toMatchObject({
      charge: false,
      score: 90,
    });
    const result = await detectAgent(req, config({ level: "known-bots" }));
    expect(result).toMatchObject({ charge: true, signal: "bot-impostor", score: 90 });
    expect(result.reasons.join(" ")).toContain(NOT_A_CRAWLER_IP);
  });

  it("verifies Googlebot's IPv6 ranges too", async () => {
    const ua = "Mozilla/5.0 (compatible; Google-Extended)";
    const inside = fakeReq({ "user-agent": ua }, { ip: "2001:4860:4801:10::1" });
    expect((await detectAgent(inside, config({ level: "known-bots" }))).signal).toBe("known-bot");
    const outside = fakeReq({ "user-agent": ua }, { ip: "2001:db8::1" });
    expect((await detectAgent(outside, config({ level: "known-bots" }))).signal).toBe(
      "bot-impostor",
    );
  });

  it("trusts a crawler with no published list by user agent only", async () => {
    const result = await detectAgent(
      fakeReq({ "user-agent": BYTESPIDER_UA }),
      config({ level: "known-bots" }),
    );
    expect(result).toMatchObject({ charge: true, signal: "known-bot" });
  });

  it("keeps chargeKnownBots working when the level is off", async () => {
    const req = fakeReq({ "user-agent": GPTBOT_UA }, { ip: gptbotIp });
    expect((await detectAgent(req, config({ level: "off" }, true))).signal).toBe("known-bot");
    expect((await detectAgent(req, { chargeKnownBots: true })).signal).toBe("known-bot");
  });
});

describe("detectAgent: edge bot scores", () => {
  const cloudflare = {
    enabled: true,
    scoreHeader: "cf-bot-score",
    verifiedBotHeader: "cf-verified-bot",
    maxBotScore: 29,
  };
  const edgeOn = (level: DetectionConfig["level"]) =>
    config({ level, edge: { ...DEFAULT_DETECTION.edge, cloudflare } });

  it("charges a low Cloudflare score from standard up, scored 100 - cfScore", async () => {
    const req = fakeReq({ ...CHROME, "cf-bot-score": "5" });
    expect((await detectAgent(req, edgeOn("known-bots"))).charge).toBe(false);
    const result = await detectAgent(req, edgeOn("standard"));
    expect(result).toMatchObject({ charge: true, signal: "edge-score", score: 95 });
    expect(result.humanCheckable).toBe(true);
  });

  it("ignores Cloudflare scores above maxBotScore and when the edge is disabled", async () => {
    const human = fakeReq({ ...CHROME, "cf-bot-score": "80" });
    expect((await detectAgent(human, edgeOn("strict"))).charge).toBe(false);
    const spoofed = fakeReq({ ...CHROME, "cf-bot-score": "1" });
    expect((await detectAgent(spoofed, config({ level: "strict" }))).charge).toBe(false);
  });

  it("treats a Cloudflare verified bot like a known bot", async () => {
    const req = fakeReq({ "user-agent": GPTBOT_UA, "cf-verified-bot": "true" });
    expect((await detectAgent(req, edgeOn("known-bots"))).signal).toBe("known-bot");
  });

  it("reads Akamai bot results", async () => {
    const akamaiOn = config({
      level: "standard",
      edge: { ...DEFAULT_DETECTION.edge, akamai: { enabled: true, header: "akamai-bot" } },
    });
    const bot = await detectAgent(fakeReq({ ...CHROME, "akamai-bot": "bot" }), akamaiOn);
    expect(bot).toMatchObject({ charge: true, signal: "edge-score", score: 90 });
    const scored = await detectAgent(fakeReq({ ...CHROME, "akamai-bot": "72" }), akamaiOn);
    expect(scored).toMatchObject({ charge: true, signal: "edge-score", score: 72 });
    const verified = await detectAgent(fakeReq({ ...CHROME, "akamai-bot": "verified" }), akamaiOn);
    expect(verified.signal).toBe("known-bot");
    const human = await detectAgent(fakeReq({ ...CHROME, "akamai-bot": "human" }), akamaiOn);
    expect(human.charge).toBe(false);
  });
});

describe("detectAgent: automation heuristics", () => {
  const scripts: Record<string, Record<string, string>> = {
    curl: { "user-agent": "curl/8.7.1", accept: "*/*" },
    "python-requests": { "user-agent": "python-requests/2.32.3", accept: "*/*" },
    httpx: { "user-agent": "python-httpx/0.27.0" },
    "Go-http-client": { "user-agent": "Go-http-client/1.1" },
    "Node fetch": { "user-agent": "node" },
    Scrapy: { "user-agent": "Scrapy/2.11.2 (+https://scrapy.org)" },
    HeadlessChrome: {
      ...CHROME,
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
    },
    "empty user agent": {},
    "Node fetch dressed as Chrome": {
      "user-agent": CHROME["user-agent"] as string,
      accept: "text/html",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
    },
    "browser UA without browser headers": {
      "user-agent": CHROME["user-agent"] as string,
      accept: "*/*",
    },
  };

  for (const [name, headers] of Object.entries(scripts)) {
    it(`charges ${name} at standard and strict, not below`, async () => {
      for (const level of ["off", "known-bots"] as const) {
        expect((await detectAgent(fakeReq(headers), config({ level }))).charge, level).toBe(false);
      }
      for (const level of ["standard", "strict"] as const) {
        const result = await detectAgent(fakeReq(headers), config({ level }));
        expect(result, level).toMatchObject({ charge: true, signal: "automation" });
        expect(result.score).toBeGreaterThanOrEqual(60);
      }
    });
  }

  it("uses the site's own threshold", async () => {
    const curl = fakeReq({ "user-agent": "curl/8.7.1" });
    expect((await detectAgent(curl, config({ level: "standard", threshold: 90 }))).charge).toBe(
      false,
    );
  });

  it("charges a browser UA missing one browser header only at a low threshold", async () => {
    const noLanguage = fakeReq({ ...CHROME, "accept-language": "" });
    const standard = await detectAgent(noLanguage, config({ level: "standard" }));
    expect(standard).toMatchObject({ charge: false, score: 30 });
    const custom = await detectAgent(noLanguage, config({ level: "strict", threshold: 30 }));
    expect(custom.signal).toBe("automation");
  });
});

describe("detectAgent: human pass and 'everyone' paths", () => {
  const pass = new HumanPass(SITE_ID, SITE_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const curl = { "user-agent": "curl/8.7.1" };

  it("lets a valid human pass through automation and edge scores", async () => {
    const cookie = `theme=dark; botfare_human=${pass.issue(now)}`;
    const result = await detectAgent(fakeReq({ ...curl, cookie }), config({ level: "strict" }), {
      humanPass: pass,
    });
    expect(result).toMatchObject({ charge: false, humanPass: true });
  });

  it("never lets a human pass override self-identified agents, crawlers or payments", async () => {
    const cookie = `botfare_human=${pass.issue(now)}`;
    const opts: DetectOptions = { humanPass: pass };
    const strict = config({ level: "strict" });
    const header = await detectAgent(fakeReq({ cookie, [AGENT_HEADER]: "1" }), strict, opts);
    expect(header.signal).toBe("agent-header");
    const paid = await detectAgent(
      fakeReq({ ...CHROME, cookie, "payment-signature": "x" }),
      strict,
      opts,
    );
    expect(paid.signal).toBe("payment-signature");
    const impostor = await detectAgent(fakeReq({ cookie, "user-agent": GPTBOT_UA }), strict, opts);
    expect(impostor.signal).toBe("bot-impostor");
  });

  it("refuses forged, expired and other-site passes", async () => {
    const strict = config({ level: "strict" });
    const other = new HumanPass("site_ffffffffffffffff", SITE_SECRET);
    const cases = [
      `v1.${now + 3600}.${"A".repeat(43)}`,
      pass.issue(now - 2 * 24 * 3600),
      other.issue(now),
      "garbage",
    ];
    for (const value of cases) {
      const result = await detectAgent(
        fakeReq({ ...curl, cookie: `botfare_human=${value}` }),
        strict,
        { humanPass: pass },
      );
      expect(result.signal, value).toBe("automation");
    }
  });

  it("charges everyone on an 'everyone' path, with the strongest signal or 'everyone'", async () => {
    const opts: DetectOptions = { audience: "everyone" };
    const human = await detectAgent(fakeReq(CHROME), config({ level: "off" }), opts);
    expect(human).toMatchObject({ charge: true, signal: "everyone", humanCheckable: false });
    const agent = await detectAgent(
      fakeReq({ [AGENT_HEADER]: "1" }),
      config({ level: "off" }),
      opts,
    );
    expect(agent.signal).toBe("agent-header");
    const script = await detectAgent(fakeReq(curl), config({ level: "standard" }), opts);
    expect(script).toMatchObject({ signal: "automation", humanCheckable: false });
    const paid = await detectAgent(
      fakeReq({ ...CHROME, "payment-signature": "x" }),
      config({ level: "off" }),
      opts,
    );
    expect(paid.signal).toBe("everyone");
  });
});

describe("detectAgent: signed agents (Web Bot Auth)", () => {
  const key = generateSigningKey();
  const other = generateSigningKey();
  let directoryServer: Listening;
  let directory: SignatureDirectory;
  let fetches = 0;
  const off = config({ level: "off" });

  beforeAll(async () => {
    const app = express();
    app.get(SIGNATURE_DIRECTORY_PATH, (_req, res) => {
      fetches++;
      res.json({ keys: [{ ...key.publicJwk, kid: "ak_signed", use: "sig" }] });
    });
    directoryServer = await listen(app);
    directory = new SignatureDirectory({ botfareUrl: directoryServer.url, minRefreshMs: 0 });
  });
  afterAll(() => directoryServer.close());

  const url = `${PUBLISHER}/articles/burr-basics`;
  const signed = (extra: Partial<SignOptions>) =>
    signRequest({
      url,
      key,
      signatureAgent: directoryServer.url.replace("http:", "https:"),
      ...extra,
    });

  it("charges a valid signature at every level, as signed-agent", async () => {
    for (const level of LEVELS) {
      const result = await detectAgent(fakeReq({ ...CHROME, ...signed({}) }), config({ level }), {
        directory,
      });
      expect(result, level).toMatchObject({ charge: true, signal: "signed-agent", score: 100 });
      expect(result.reasons).toContain("signed agent ak_signed");
    }
  });

  it("accepts a signature without Signature-Agent and with any label", async () => {
    const headers = signRequest({ url, key, label: "botfare" });
    const result = await detectAgent(fakeReq(headers), off, { directory });
    expect(result.signal).toBe("signed-agent");
  });

  it("ranks a signature above the agent header", async () => {
    const result = await detectAgent(fakeReq({ ...signed({}), [AGENT_HEADER]: "1" }), off, {
      directory,
    });
    expect(result.signal).toBe("signed-agent");
  });

  it("ignores expired, future, unknown-key and tampered signatures, and keeps scoring", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Record<string, string>, DetectionRequest?][] = [
      ["expired", signed({ created: now - 600, expires: now - 300 })],
      ["future", signed({ created: now + 600, expires: now + 660 })],
      ["too long", signed({ created: now, expires: now + 2 * 24 * 3600 })],
      ["unknown key", signRequest({ url, key: other })],
      ["wrong tag", signed({ tag: "other-tag" })],
      ["other host", signRequest({ url: "http://elsewhere.test/articles/burr-basics", key })],
    ];
    const tampered = signed({});
    tampered["signature-agent"] = '"https://evil.test"';
    cases.push(["tampered Signature-Agent", tampered]);
    cases.push(["garbage", { "signature-input": "sig1=(oops", signature: "sig1=:AAAA:" }]);

    for (const [name, headers] of cases) {
      // Only the HTTP client UA counts: a bad signature is never held against the request.
      const result = await detectAgent(
        fakeReq({ "user-agent": "curl/8.7.1", ...headers }),
        config({ level: "standard" }),
        { directory },
      );
      expect(result.signal, name).toBe("automation");
      expect(result.score, name).toBe(80);
      expect(
        result.reasons.some((r) => r.startsWith("signature ignored")),
        name,
      ).toBe(true);
      const human = await detectAgent(fakeReq({ ...CHROME, ...headers }), off, { directory });
      expect(human.charge, name).toBe(false);
    }
  });

  it("caches the directory instead of fetching it per request", async () => {
    const cached = new SignatureDirectory({ botfareUrl: directoryServer.url });
    const before = fetches;
    for (let i = 0; i < 3; i++) {
      const result = await detectAgent(fakeReq(signed({})), off, { directory: cached });
      expect(result.signal).toBe("signed-agent");
    }
    expect(fetches - before).toBe(1);
  });

  it("does not fetch the directory for unsigned requests", async () => {
    const lazy = new SignatureDirectory({ botfareUrl: directoryServer.url });
    const before = fetches;
    await detectAgent(fakeReq({ "user-agent": "curl/8.7.1" }), off, { directory: lazy });
    expect(fetches).toBe(before);
  });
});
