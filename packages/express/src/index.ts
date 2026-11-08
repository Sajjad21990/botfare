/**
 * `botfare()`: the publisher's one-line middleware. Humans browse free; agents get an x402 402
 * and pay per request through the official `@x402/express` middleware, settled by BotFare.
 *
 *   app.use(botfare({ siteId: "site_…", siteSecret: process.env.BOTFARE_SITE_SECRET }));
 *
 * Mount it at the app root, before the routes it prices.
 */
import { type OfferPreview, type SiteConfig, siteAuthHeader } from "@botfare/contracts";
import type { Request, RequestHandler } from "express";
import { SiteConfigCache } from "./config-cache";
import { isAgentRequest, normalizeConfig, ruleFor } from "./matching";
import { PaymentGate } from "./payment-gate";

export { isAgentRequest, normalizePath } from "./matching";

export interface BotFareOptions {
  siteId: string;
  siteSecret: string;
  /** BotFare app origin. Default: `process.env.BOTFARE_URL`. */
  botfareUrl?: string;
  /** How long a fetched site config is used before it is refreshed. Default 30 s. */
  configTtlMs?: number;
  /** Free preview put in the 402 body as `{ preview }`, so agents can decide before paying. */
  preview?: (req: Request) => OfferPreview | undefined | Promise<OfferPreview | undefined>;
  /** Default: `console.log` with a `[botfare]` prefix. */
  logger?: (msg: string) => void;
}

/**
 * Per request:
 * - no site config loaded yet (BotFare never reached) → pass through, so humans are never blocked;
 * - no pricing rule for the method and path, or a free path → pass through;
 * - rule for `agents` and the request is not from an agent → pass through (free for humans);
 * - otherwise charge: 402 with `PAYMENT-REQUIRED` and `{ preview }`, or verify → handler → settle.
 *   If BotFare's facilitator cannot be reached for that, the agent gets
 *   `503 { error: "botfare_unavailable" }` with `Retry-After`; humans are unaffected.
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
  void configs.refresh(); // warm the cache at startup; requests never wait on this one alone

  let raw: SiteConfig | undefined;
  let normalized: SiteConfig | undefined;

  return async (req, res, next) => {
    const config = await configs.get(); // never rejects
    if (!config) return next();
    if (config !== raw) {
      raw = config;
      normalized = normalizeConfig(config);
    }
    const rule = ruleFor(req, normalized as SiteConfig);
    if (!rule) return next();
    if (rule.audience === "agents" && !isAgentRequest(req, config)) return next();

    if (!(await gate.ensureReady())) {
      res
        .status(503)
        .set("Retry-After", "5")
        .json({ error: "botfare_unavailable", message: "Payments are briefly unavailable." });
      return;
    }
    // The SDK middleware answers 402/5xx itself and calls next() only for a verified payment.
    await gate.charge(rule, req, res, next);
  };
}
