/**
 * `botfare()`: the publisher's one-line middleware. Humans browse free; agents get an x402 402
 * and pay per request through the official `@x402/express` middleware, settled by BotFare.
 *
 *   app.use(botfare({ siteId: "site_…", siteSecret: process.env.BOTFARE_SITE_SECRET }));
 *
 * Mount it at the app root, before the routes it prices. Behind a proxy or CDN, set Express's
 * `trust proxy` so `req.ip` is the client's address (used to verify known crawlers).
 */
import { type OfferPreview, type SiteConfig, siteAuthHeader } from "@botfare/contracts";
import type { Request, RequestHandler } from "express";
import { SiteConfigCache } from "./config-cache";
import {
  type Detection,
  detectAgent,
  effectiveDetection,
  HumanPass,
  SignatureDirectory,
} from "./detection";
import {
  HUMAN_CHECK_PATH,
  handleHumanCheck,
  humanCheckHtml,
  humanCheckPaywall,
  resolveTurnstileSecret,
  TURNSTILE_SITEVERIFY_URL,
  turnstileSecretFor,
} from "./human-check";
import { normalizeConfig, ruleFor } from "./matching";
import { BOTFARE_SIGNAL_EXTRA, PaymentGate } from "./payment-gate";

export * from "./detection";
export {
  HUMAN_CHECK_PATH,
  isTurnstileTestSiteKey,
  resolveTurnstileSecret,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_TEST_SITE_KEY,
  turnstileSecretFor,
} from "./human-check";
export { isAgentRequest, normalizePath } from "./matching";
export { BOTFARE_SIGNAL_EXTRA };

export interface BotFareOptions {
  siteId: string;
  siteSecret: string;
  /** BotFare app origin. Default: `process.env.BOTFARE_URL`. */
  botfareUrl?: string;
  /** How long a fetched site config is used before it is refreshed. Default 30 s. */
  configTtlMs?: number;
  /** Free preview put in the 402 body as `{ preview }`, so agents can decide before paying. */
  preview?: (req: Request) => OfferPreview | undefined | Promise<OfferPreview | undefined>;
  /**
   * Cloudflare Turnstile secret for the human check: the secret of the widget whose site key is
   * in the dashboard. Default: `process.env.TURNSTILE_SECRET_KEY`. Cloudflare's test site keys
   * always use Cloudflare's always-pass test secret instead, and a test secret is never paired
   * with a real site key.
   */
  turnstileSecret?: string;
  /** Turnstile siteverify endpoint (tests). Default Cloudflare's. */
  turnstileVerifyUrl?: string;
  /** Default: `console.log` with a `[botfare]` prefix. */
  logger?: (msg: string) => void;
}

/** What botfare() decided for a priced request, on `res.locals.botfare`. */
export type BotFareLocals = Detection;

/**
 * Per request:
 * - `POST /__botfare/human` → the Turnstile human check (sets the 24 h human pass);
 * - no site config loaded yet (BotFare never reached) → pass through, so humans are never blocked;
 * - no pricing rule for the method and path, or a free path → pass through;
 * - the detection engine (src/detection) decides who pays: on an `agents` path a request with no
 *   charging signal passes through free; on an `everyone` path every request pays;
 * - otherwise charge: 402 with `PAYMENT-REQUIRED` and `{ preview }`, or verify → handler → settle.
 *   A browser charged only on a score sees the human check instead of a bare paywall (still a 402
 *   with the offer) when the site has a Turnstile key.
 *   If BotFare's facilitator cannot be reached for that, the agent gets
 *   `503 { error: "botfare_unavailable" }` with `Retry-After`. Humans are unaffected: those with
 *   no charging signal pass through, and a browser charged only on a score still gets the human
 *   check (as a 503 page, since there is no offer to show).
 */
export function botfare(options: BotFareOptions): RequestHandler {
  const { siteId, siteSecret } = options;
  const botfareUrl = options.botfareUrl ?? process.env.BOTFARE_URL;
  if (!siteId || !siteSecret) throw new Error("botfare(): siteId and siteSecret are required");
  if (!botfareUrl) throw new Error("botfare(): set botfareUrl or BOTFARE_URL");

  const log = options.logger ?? ((msg: string) => console.log(`[botfare] ${msg}`));
  const authHeader = siteAuthHeader(siteId, siteSecret);
  const configs = new SiteConfigCache({
    botfareUrl,
    siteId,
    authHeader,
    ttlMs: options.configTtlMs ?? 30_000,
    log,
  });
  const gate = new PaymentGate({ botfareUrl, siteId, authHeader, preview: options.preview, log });
  const directory = new SignatureDirectory({ botfareUrl, log });
  const humanPass = new HumanPass(siteId, siteSecret);
  const configuredSecret = options.turnstileSecret ?? process.env.TURNSTILE_SECRET_KEY;
  const turnstileSecret = (siteKey: string | null) => turnstileSecretFor(siteKey, configuredSecret);
  let turnstileProblem: string | undefined;
  void configs.refresh(); // warm the cache at startup; requests never wait on this one alone

  let raw: SiteConfig | undefined;
  let normalized: SiteConfig | undefined;

  return async (req, res, next) => {
    if (req.method === "POST" && req.path === HUMAN_CHECK_PATH) {
      await handleHumanCheck(req, res, {
        humanPass,
        verifyUrl: options.turnstileVerifyUrl ?? TURNSTILE_SITEVERIFY_URL,
        log,
        secret: async () => {
          const config = await configs.get();
          return config ? turnstileSecret(effectiveDetection(config).turnstileSiteKey) : undefined;
        },
      });
      return;
    }

    const config = await configs.get(); // never rejects
    if (!config) return next();
    if (config !== raw) {
      raw = config;
      normalized = normalizeConfig(config);
      // Say once (until it changes) why a configured human check cannot run.
      const { problem } = resolveTurnstileSecret(
        effectiveDetection(config).turnstileSiteKey,
        configuredSecret,
      );
      if (problem && problem !== turnstileProblem) log(problem);
      turnstileProblem = problem;
    }
    const rule = ruleFor(req, normalized as SiteConfig);
    if (!rule) return next();

    const detection = await detectAgent(req, config, {
      directory,
      humanPass,
      audience: rule.audience,
    });
    res.locals.botfare = detection satisfies BotFareLocals;
    if (!detection.charge || !detection.signal) return next();

    // "Pay, or prove you're human": only for a request charged on a score, with a site key whose
    // secret we hold. The SDK shows paywall HTML only to browsers (Accept: text/html, Mozilla UA).
    const siteKey = effectiveDetection(config).turnstileSiteKey;
    const humanCheckKey =
      detection.humanCheckable && siteKey && turnstileSecret(siteKey) ? siteKey : undefined;

    if (!(await gate.ensureReady())) {
      res.status(503).set("Retry-After", "5");
      if (humanCheckKey && isBrowserRequest(req)) {
        // The human check needs only Cloudflare, so a suspected human still has a way through.
        res
          .set("Cache-Control", "no-store")
          .type("html")
          .send(humanCheckHtml({ siteKey: humanCheckKey, returnTo: req.originalUrl }));
        return;
      }
      res.json({ error: "botfare_unavailable", message: "Payments are briefly unavailable." });
      return;
    }

    const browserPaywall = humanCheckKey
      ? humanCheckPaywall(humanCheckKey, req.originalUrl)
      : undefined;

    // The SDK middleware answers 402/5xx itself and calls next() only for a verified payment.
    await gate.charge(rule, req, res, next, { signal: detection.signal, browserPaywall });
  };
}

/** The same test the x402 SDK uses before it serves paywall HTML instead of JSON. */
function isBrowserRequest(req: Request): boolean {
  return (
    (req.get("accept") ?? "").includes("text/html") &&
    (req.get("user-agent") ?? "").includes("Mozilla")
  );
}
