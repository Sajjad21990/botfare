/**
 * "Pay, or prove you're human." A browser charged only because of a score (automation heuristics
 * or a CDN bot score) gets a small page instead of a bare paywall: a Cloudflare Turnstile widget
 * that lets a person continue free, plus the x402 offer for agents (the 402 status and the
 * PAYMENT-REQUIRED header stay on the response).
 *
 * The widget posts to `POST /__botfare/human` on the publisher's own app (botfare() answers it).
 * The token is checked with Cloudflare siteverify using the publisher's secret
 * (`TURNSTILE_SECRET_KEY`); on success the browser gets a 24 h human-pass cookie and is sent back
 * to the page it asked for.
 *
 * Cloudflare's documented test keys work for demos: site key `1x00000000000000000000AA` with
 * secret `1x0000000000000000000000000000000AA` always passes (token `XXXX.DUMMY.TOKEN.XXXX`).
 */
import { randomUUID } from "node:crypto";
import type { PaywallProvider } from "@x402/core/server";
import type { Request, Response } from "express";
import type { HumanPass } from "./detection";

export const HUMAN_CHECK_PATH = "/__botfare/human";
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";
export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Cloudflare's always-pass test pair (https://developers.cloudflare.com/turnstile/troubleshooting/testing/). */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

const MAX_BODY_BYTES = 8 * 1024;
const VERIFY_TIMEOUT_MS = 5_000;

/** The Turnstile secret for a site key: the publisher's, or Cloudflare's test secret for the test key. */
export function turnstileSecretFor(
  siteKey: string,
  configured: string | undefined,
): string | undefined {
  if (configured) return configured;
  return siteKey === TURNSTILE_TEST_SITE_KEY ? TURNSTILE_TEST_SECRET : undefined;
}

/** Paywall HTML for a suspected human: the Turnstile widget, plus the offer for agents. */
export function humanCheckPaywall(siteKey: string, returnTo: string): PaywallProvider {
  return {
    generateHtml(paymentRequired) {
      const offer = paymentRequired.accepts[0];
      const price = offer ? `$${(Number(offer.amount) / 100).toFixed(2)}` : "a small fee";
      return humanCheckHtml({ siteKey, returnTo, price });
    },
  };
}

export function humanCheckHtml(input: {
  siteKey: string;
  returnTo: string;
  price: string;
}): string {
  const siteKey = escapeHtml(input.siteKey);
  const returnTo = escapeHtml(input.returnTo);
  const price = escapeHtml(input.price);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Reading as a human?</title>
<script src="${TURNSTILE_SCRIPT_URL}" async defer></script>
<style>
  :root { color-scheme: light dark; --fg: #1c1917; --muted: #57534e; --bg: #fafaf9; --card: #fff; --line: #e7e5e4; --accent: #1c1917; --accent-fg: #fafaf9; }
  @media (prefers-color-scheme: dark) { :root { --fg: #fafaf9; --muted: #a8a29e; --bg: #0c0a09; --card: #1c1917; --line: #292524; --accent: #fafaf9; --accent-fg: #1c1917; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 26rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { margin: 0 0 16px; color: var(--muted); }
  .widget { min-height: 65px; margin: 4px 0 16px; }
  button { width: 100%; height: 40px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 500; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  .agents { margin: 20px 0 0; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>Reading as a human? Continue free.</h1>
  <p>This page is free for people. Confirm you're not a bot and we'll take you straight there.</p>
  <form method="post" action="${HUMAN_CHECK_PATH}" id="human-check">
    <input type="hidden" name="return" value="${returnTo}">
    <div class="widget"><div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="botfareHumanPassed" data-expired-callback="botfareHumanExpired"></div></div>
    <button type="submit" id="continue" disabled>Continue free</button>
  </form>
  <p class="agents">AI agents: this page costs ${price} per request, paid with x402 through BotFare. The offer is in the <code>PAYMENT-REQUIRED</code> header of this 402 response.</p>
</main>
<script>
  function botfareHumanPassed() { var b = document.getElementById("continue"); b.disabled = false; document.getElementById("human-check").requestSubmit ? document.getElementById("human-check").requestSubmit() : document.getElementById("human-check").submit(); }
  function botfareHumanExpired() { document.getElementById("continue").disabled = true; }
</script>
</body>
</html>`;
}

export interface HumanCheckHandlerOptions {
  humanPass: HumanPass;
  /** Turnstile secret for the site's current site key; undefined when none is configured. */
  secret: () => Promise<string | undefined>;
  verifyUrl: string;
  log: (msg: string) => void;
}

/** `POST /__botfare/human`: verify the Turnstile token, set the human pass, redirect back. */
export async function handleHumanCheck(
  req: Request,
  res: Response,
  options: HumanCheckHandlerOptions,
): Promise<void> {
  res.set("Cache-Control", "no-store");
  const form = await readForm(req);
  const returnTo = safeReturnPath(form?.get("return"));
  const token = form?.get("cf-turnstile-response") ?? "";
  const secret = await options.secret();
  if (!secret) {
    res.status(404).type("text/plain").send("Human check is not enabled on this site.");
    return;
  }
  if (!token || token.length > 2048) {
    sendRetryPage(res, returnTo, 400);
    return;
  }

  let success = false;
  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      idempotency_key: randomUUID(),
    });
    if (req.ip) body.set("remoteip", req.ip.replace(/^::ffff:/, ""));
    const verify = await fetch(options.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    const result = (await verify.json()) as { success?: unknown; "error-codes"?: unknown };
    success = result.success === true;
    if (!success) {
      options.log(`human check failed (${JSON.stringify(result["error-codes"] ?? [])})`);
    }
  } catch (err) {
    options.log(`Turnstile siteverify unreachable (${(err as Error).message})`);
  }
  if (!success) {
    sendRetryPage(res, returnTo, 403);
    return;
  }
  res.set(
    "Set-Cookie",
    options.humanPass.setCookieHeader(Math.floor(Date.now() / 1000), req.secure),
  );
  res.redirect(303, returnTo);
}

/** Only same-site paths: `/x`, never `//host`, `/\host` or an absolute URL. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/";
  }
  if (/[\r\n\t]/.test(value) || value.length > 2048) return "/";
  return value;
}

async function readForm(req: Request): Promise<URLSearchParams | undefined> {
  // A body parser mounted before botfare() may already have read it.
  const parsed = (req as Request & { body?: unknown }).body;
  if (parsed && typeof parsed === "object" && !Buffer.isBuffer(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    return new URLSearchParams(entries);
  }
  const type = req.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendRetryPage(res: Response, returnTo: string, status: number): void {
  const back = escapeHtml(returnTo);
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Couldn't confirm</title></head><body style="font:15px/1.55 system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 16px"><h1 style="font-size:1.25rem">We couldn't confirm that</h1><p>The human check didn't go through. <a href="${back}">Try again</a>.</p></body></html>`,
    );
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
