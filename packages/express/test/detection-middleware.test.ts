import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveTurnstileSecret,
  sampleCrawlerIp,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_TEST_SITE_KEY,
} from "../src";
import { detectionConfig, startFakeBotFare, startFakeTurnstile, startPublisher } from "./helpers";
import { generateSigningKey, signRequest } from "./signing";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CHROME_HEADERS = {
  "user-agent": CHROME_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};
/** A script dressed up as Chrome: browser UA, asks for HTML, none of the other browser headers. */
const FAKE_BROWSER = { "user-agent": CHROME_UA, accept: "text/html,*/*;q=0.8" };
const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)";

function signalOf(res: Response): unknown {
  const header = res.headers.get("payment-required");
  if (!header) return undefined;
  return decodePaymentRequiredHeader(header).accepts[0]?.extra?.botfareSignal;
}

describe("botfare(): pay, or prove you're human (Turnstile)", () => {
  let botfare: Awaited<ReturnType<typeof startFakeBotFare>>;
  let site: Awaited<ReturnType<typeof startPublisher>>;
  let turnstile: Awaited<ReturnType<typeof startFakeTurnstile>>;
  const article = "/articles/burr-basics?ref=newsletter";

  beforeAll(async () => {
    turnstile = await startFakeTurnstile();
    botfare = await startFakeBotFare(
      detectionConfig({ level: "standard", turnstileSiteKey: "test-site-key" }),
    );
    site = await startPublisher({
      botfareUrl: botfare.url,
      turnstileSecret: "test-secret",
      turnstileVerifyUrl: turnstile.verifyUrl,
    });
  });
  afterAll(async () => {
    await site.close();
    await botfare.close();
    await turnstile.close();
  });

  it("serves a person in a normal browser for free", async () => {
    const res = await fetch(`${site.url}${article}`, { headers: CHROME_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-required")).toBeNull();
  });

  it("shows a suspected human the human check, with the x402 offer still on the 402", async () => {
    const res = await fetch(`${site.url}${article}`, { headers: FAKE_BROWSER });
    expect(res.status).toBe(402);
    expect(signalOf(res)).toBe("automation");
    const html = await res.text();
    expect(html).toContain("Reading as a human? Continue free.");
    expect(html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).toContain('data-sitekey="test-site-key"');
    expect(html).toContain('action="/__botfare/human"');
    expect(html).toContain('name="return" value="/articles/burr-basics?ref=newsletter"');
    expect(html).toContain("$0.03");
  });

  it("gives non-browser scripts the plain 402 with the preview", async () => {
    const res = await fetch(`${site.url}${article}`, { headers: { "user-agent": "curl/8.7.1" } });
    expect(res.status).toBe(402);
    expect(signalOf(res)).toBe("automation");
    expect(await res.json()).toMatchObject({
      preview: { title: "Preview of /articles/burr-basics" },
    });
  });

  it("refuses a bad token and sets no pass", async () => {
    const res = await fetch(`${site.url}/__botfare/human`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "bad-token", return: article }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("Try again");
  });

  it("sets a 24 h human pass on a good token and lets that browser read free", async () => {
    const res = await fetch(`${site.url}/__botfare/human`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "pass-token", return: article }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(article);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(
      /^botfare_human=v1\.\d+\.[\w-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/,
    );
    expect(turnstile.requests.at(-1)).toMatchObject({
      secret: "test-secret",
      response: "pass-token",
    });

    const cookie = setCookie.split(";")[0] as string;
    const again = await fetch(`${site.url}${article}`, { headers: { ...FAKE_BROWSER, cookie } });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("The full article.");
  });

  it("does not let the pass cover a self-identified agent", async () => {
    const pass = new URLSearchParams({ "cf-turnstile-response": "pass-token", return: "/" });
    const res = await fetch(`${site.url}/__botfare/human`, {
      method: "POST",
      body: pass,
      redirect: "manual",
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const agent = await fetch(`${site.url}${article}`, {
      headers: { cookie, "x-botfare-agent": "1" },
    });
    expect(agent.status).toBe(402);
    expect(signalOf(agent)).toBe("agent-header");
  });

  it("only redirects back to paths on the same site", async () => {
    for (const target of ["//evil.test/x", "https://evil.test/", "/\\evil.test"]) {
      const res = await fetch(`${site.url}/__botfare/human`, {
        method: "POST",
        body: new URLSearchParams({ "cf-turnstile-response": "pass-token", return: target }),
        redirect: "manual",
      });
      expect(res.headers.get("location"), target).toBe("/");
    }
  });
});

describe("botfare(): human check settings", () => {
  it("falls back to the plain paywall when the site has no Turnstile key", async () => {
    const botfare = await startFakeBotFare(detectionConfig({ level: "standard" }));
    const site = await startPublisher({ botfareUrl: botfare.url, turnstileSecret: "test-secret" });
    try {
      const res = await fetch(`${site.url}/articles/burr-basics`, { headers: FAKE_BROWSER });
      expect(res.status).toBe(402);
      const html = await res.text();
      expect(html).not.toContain("Continue free");
      expect(html).toContain("Payment required");
      const post = await fetch(`${site.url}/__botfare/human`, {
        method: "POST",
        body: new URLSearchParams({ "cf-turnstile-response": "pass-token" }),
      });
      expect(post.status).toBe(404);
    } finally {
      await site.close();
      await botfare.close();
    }
  });

  it("uses Cloudflare's always-pass test secret with Cloudflare's test site key", async () => {
    const turnstile = await startFakeTurnstile();
    const botfare = await startFakeBotFare(
      detectionConfig({ level: "standard", turnstileSiteKey: TURNSTILE_TEST_SITE_KEY }),
    );
    const savedEnv = process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const site = await startPublisher({
      botfareUrl: botfare.url,
      turnstileVerifyUrl: turnstile.verifyUrl,
    });
    try {
      const res = await fetch(`${site.url}/articles/burr-basics`, { headers: FAKE_BROWSER });
      expect(await res.text()).toContain(`data-sitekey="${TURNSTILE_TEST_SITE_KEY}"`);
      await fetch(`${site.url}/__botfare/human`, {
        method: "POST",
        body: new URLSearchParams({ "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" }),
        redirect: "manual",
      });
      expect(turnstile.requests.at(-1)?.secret).toBe(TURNSTILE_TEST_SECRET);
    } finally {
      if (savedEnv !== undefined) process.env.TURNSTILE_SECRET_KEY = savedEnv;
      await site.close();
      await botfare.close();
      await turnstile.close();
    }
  });

  it("uses the test secret with the test site key even when a real secret is configured", async () => {
    const turnstile = await startFakeTurnstile();
    const botfare = await startFakeBotFare(
      detectionConfig({ level: "standard", turnstileSiteKey: TURNSTILE_TEST_SITE_KEY }),
    );
    const site = await startPublisher({
      botfareUrl: botfare.url,
      turnstileSecret: "real-widget-secret",
      turnstileVerifyUrl: turnstile.verifyUrl,
    });
    try {
      const res = await fetch(`${site.url}/articles/burr-basics`, { headers: FAKE_BROWSER });
      expect(await res.text()).toContain(`data-sitekey="${TURNSTILE_TEST_SITE_KEY}"`);
      await fetch(`${site.url}/__botfare/human`, {
        method: "POST",
        body: new URLSearchParams({ "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" }),
        redirect: "manual",
      });
      expect(turnstile.requests.at(-1)?.secret).toBe(TURNSTILE_TEST_SECRET);
    } finally {
      await site.close();
      await botfare.close();
      await turnstile.close();
    }
  });

  it("never pairs a real site key with a test secret, and says so once", async () => {
    const botfare = await startFakeBotFare(
      detectionConfig({ level: "standard", turnstileSiteKey: "0x4AAAAAAAreal-site-key" }),
    );
    const site = await startPublisher({
      botfareUrl: botfare.url,
      turnstileSecret: TURNSTILE_TEST_SECRET,
      configTtlMs: 0,
    });
    try {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${site.url}/articles/burr-basics`, { headers: FAKE_BROWSER });
        expect(res.status).toBe(402);
        expect(await res.text()).not.toContain("Continue free");
      }
      const post = await fetch(`${site.url}/__botfare/human`, {
        method: "POST",
        body: new URLSearchParams({ "cf-turnstile-response": "anything" }),
        redirect: "manual",
      });
      expect(post.status).toBe(404);
      expect(post.headers.get("set-cookie")).toBeNull();
      const warnings = site.logs.filter((l) => l.includes("Cloudflare's test secret"));
      expect(warnings).toHaveLength(1);
    } finally {
      await site.close();
      await botfare.close();
    }
  });

  it("logs when a real site key has no secret", async () => {
    const botfare = await startFakeBotFare(
      detectionConfig({ level: "standard", turnstileSiteKey: "0x4AAAAAAAreal-site-key" }),
    );
    const savedEnv = process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const site = await startPublisher({ botfareUrl: botfare.url });
    try {
      const res = await fetch(`${site.url}/articles/burr-basics`, { headers: FAKE_BROWSER });
      expect(res.status).toBe(402);
      expect(site.logs.some((l) => l.includes("TURNSTILE_SECRET_KEY is not set"))).toBe(true);
    } finally {
      if (savedEnv !== undefined) process.env.TURNSTILE_SECRET_KEY = savedEnv;
      await site.close();
      await botfare.close();
    }
  });

  it("never shows the human check on an 'everyone' path", async () => {
    const botfare = await startFakeBotFare(
      detectionConfig({ level: "standard", turnstileSiteKey: "test-site-key" }),
    );
    const site = await startPublisher({ botfareUrl: botfare.url, turnstileSecret: "test-secret" });
    try {
      const res = await fetch(`${site.url}/api/brew-ratio`, { headers: CHROME_HEADERS });
      expect(res.status).toBe(402);
      expect(signalOf(res)).toBe("everyone");
      expect(await res.text()).not.toContain("Continue free");
    } finally {
      await site.close();
      await botfare.close();
    }
  });
});

describe("resolveTurnstileSecret()", () => {
  it("pairs test keys with the test secret and real keys only with a real secret", () => {
    expect(resolveTurnstileSecret(null, "real")).toEqual({});
    expect(resolveTurnstileSecret(TURNSTILE_TEST_SITE_KEY, "real").secret).toBe(
      TURNSTILE_TEST_SECRET,
    );
    expect(resolveTurnstileSecret("3x00000000000000000000FF", undefined).secret).toBe(
      TURNSTILE_TEST_SECRET,
    );
    expect(resolveTurnstileSecret("0x4AAAAAAAkey", "real").secret).toBe("real");
    const noSecret = resolveTurnstileSecret("0x4AAAAAAAkey", undefined);
    expect(noSecret.secret).toBeUndefined();
    expect(noSecret.problem).toContain("not set");
    const testSecret = resolveTurnstileSecret("0x4AAAAAAAkey", TURNSTILE_TEST_SECRET);
    expect(testSecret.secret).toBeUndefined();
    expect(testSecret.problem).toContain("test secret");
  });
});

describe("botfare(): facilitator unreachable", () => {
  it("still gives a suspected human the human check, and agents a 503", async () => {
    const turnstile = await startFakeTurnstile();
    const botfare = await startFakeBotFare(
      detectionConfig({ level: "standard", turnstileSiteKey: "test-site-key" }),
    );
    botfare.setSupportedFailing(true);
    const site = await startPublisher({
      botfareUrl: botfare.url,
      turnstileSecret: "test-secret",
      turnstileVerifyUrl: turnstile.verifyUrl,
    });
    const article = "/articles/burr-basics";
    try {
      const browser = await fetch(`${site.url}${article}`, { headers: FAKE_BROWSER });
      expect(browser.status).toBe(503);
      expect(browser.headers.get("retry-after")).toBe("5");
      const html = await browser.text();
      expect(html).toContain("Reading as a human? Continue free.");
      expect(html).toContain('data-sitekey="test-site-key"');
      expect(html).toContain("payments are briefly unavailable");

      const agent = await fetch(`${site.url}${article}`, { headers: { "user-agent": "curl/8" } });
      expect(agent.status).toBe(503);
      expect(await agent.json()).toMatchObject({ error: "botfare_unavailable" });

      const pass = await fetch(`${site.url}/__botfare/human`, {
        method: "POST",
        body: new URLSearchParams({ "cf-turnstile-response": "pass-token", return: article }),
        redirect: "manual",
      });
      expect(pass.status).toBe(303);
      const cookie = (pass.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const again = await fetch(`${site.url}${article}`, {
        headers: { ...FAKE_BROWSER, cookie },
      });
      expect(again.status).toBe(200);
    } finally {
      await site.close();
      await botfare.close();
      await turnstile.close();
    }
  });
});

describe("botfare(): known crawlers and signed agents", () => {
  it("charges GPTBot from OpenAI's ranges as known-bot and an impostor as bot-impostor", async () => {
    const botfare = await startFakeBotFare(detectionConfig({ level: "known-bots" }));
    const site = await startPublisher({ botfareUrl: botfare.url, trustProxy: true });
    try {
      const real = await fetch(`${site.url}/articles/burr-basics`, {
        headers: { "user-agent": GPTBOT_UA, "x-forwarded-for": sampleCrawlerIp("GPTBot") ?? "" },
      });
      expect(real.status).toBe(402);
      expect(signalOf(real)).toBe("known-bot");

      const impostor = await fetch(`${site.url}/articles/burr-basics`, {
        headers: { "user-agent": GPTBOT_UA, "x-forwarded-for": "203.0.113.7" },
      });
      expect(impostor.status).toBe(402);
      expect(signalOf(impostor)).toBe("bot-impostor");

      const human = await fetch(`${site.url}/articles/burr-basics`, { headers: CHROME_HEADERS });
      expect(human.status).toBe(200);
    } finally {
      await site.close();
      await botfare.close();
    }
  });

  it("charges a signed agent even with detection off, and ignores a bad signature", async () => {
    const key = generateSigningKey();
    const botfare = await startFakeBotFare(detectionConfig({ level: "off" }));
    botfare.setDirectoryKeys([{ ...key.publicJwk, kid: "ak_signed" }]);
    const site = await startPublisher({ botfareUrl: botfare.url });
    try {
      const url = `${site.url}/articles/burr-basics`;
      const headers = signRequest({ url, key, signatureAgent: "https://botfare.test" });
      const signed = await fetch(url, { headers });
      expect(signed.status).toBe(402);
      expect(signalOf(signed)).toBe("signed-agent");
      expect(botfare.calls).toContain("GET /.well-known/http-message-signatures-directory");

      const stranger = generateSigningKey();
      const unknown = await fetch(url, { headers: signRequest({ url, key: stranger }) });
      expect(unknown.status).toBe(200);
    } finally {
      await site.close();
      await botfare.close();
    }
  });
});
