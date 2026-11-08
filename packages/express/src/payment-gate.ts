import {
  type DetectionSignal,
  FACILITATOR_PATH,
  type OfferPreview,
  offerPreviewSchema,
  type PricingRule,
} from "@botfare/contracts";
import {
  MAX_AUTHORIZATION_SECONDS,
  PAYPAL_SANDBOX,
  PREPAID_SCHEME,
  PrepaidPayPalServer,
  USD,
} from "@botfare/x402-paypal";
import {
  HTTPFacilitatorClient,
  type PaywallProvider,
  type RouteConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import type { NextFunction, Request, Response } from "express";
import { escapeHtml } from "./human-check";

/**
 * Requirements carry the detection signal as `extra.botfareSignal`, so the facilitator can store
 * why each request paid. It is a dynamic field: the SDK leaves it out when matching a payment's
 * `accepted` against the requirements, so a paid retry matches even if its signal differs from
 * the 402's, and the requirements sent to verify/settle carry the server's own signal.
 */
export const BOTFARE_SIGNAL_EXTRA = "botfareSignal";

class SignalRecordingPrepaidServer extends PrepaidPayPalServer {
  readonly dynamicExtraFields = [BOTFARE_SIGNAL_EXTRA];
}

/** Per-call timeout for /supported, /verify and /settle. */
const FACILITATOR_TIMEOUT_MS = 15_000;
/** After /supported fails, answer 503 for this long before asking again. */
const RETRY_INIT_AFTER_MS = 5_000;

export type PreviewFn = (
  req: Request,
) => OfferPreview | undefined | Promise<OfferPreview | undefined>;

export interface PaymentGateOptions {
  botfareUrl: string;
  siteId: string;
  authHeader: string;
  preview?: PreviewFn;
  log: (msg: string) => void;
}

/**
 * Charges one request through the official `@x402/express` middleware.
 *
 * The x402 route is built per request from the pricing rule the caller already matched: one
 * catch-all route whose price, description and mimeType come from that rule. So a price change
 * applies as soon as the site config refreshes, and BotFare's own pattern matching is the only
 * one that decides what is paid (the SDK's route patterns never come into play).
 *
 * The SDK would fetch the facilitator's `/supported` when the middleware is created and
 * `process.exit(1)` on some startup errors. Instead the resource server is initialised here,
 * lazily on the first paid request, and retried later if BotFare is unreachable.
 */
export class PaymentGate {
  private readonly resourceServer: x402ResourceServer;
  private ready = false;
  private initializing: Promise<void> | undefined;
  private failedAt = 0;

  constructor(private readonly options: PaymentGateOptions) {
    const auth = { authorization: options.authHeader };
    const facilitator = new HTTPFacilitatorClient({
      url: new URL(FACILITATOR_PATH, options.botfareUrl).toString(),
      timeoutMs: FACILITATOR_TIMEOUT_MS,
      createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
    });
    this.resourceServer = new x402ResourceServer(facilitator).register(
      PAYPAL_SANDBOX,
      new SignalRecordingPrepaidServer(),
    );
  }

  /** True once the facilitator's supported kinds are loaded; false while BotFare is unreachable. */
  async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    if (!this.initializing) {
      if (Date.now() - this.failedAt < RETRY_INIT_AFTER_MS) return false;
      this.initializing = this.resourceServer
        .initialize()
        .then(
          () => {
            this.ready = true;
            this.options.log("connected to the BotFare facilitator");
          },
          (err: Error) => {
            this.failedAt = Date.now();
            this.options.log(`BotFare facilitator unreachable (${err.message})`);
          },
        )
        .finally(() => {
          this.initializing = undefined;
        });
    }
    await this.initializing;
    return this.ready;
  }

  /**
   * Runs the x402 flow for one request: 402, or verify → `next()` → settle. `signal` goes into
   * the requirements; `browserPaywall` replaces the plain HTML paywall (the human check).
   */
  charge(
    rule: PricingRule,
    req: Request,
    res: Response,
    next: NextFunction,
    charge: { signal: DetectionSignal; browserPaywall?: PaywallProvider },
  ): Promise<void> {
    const route = this.routeFor(rule, req, charge.signal);
    const httpServer = new x402HTTPResourceServer(this.resourceServer, route);
    const provider = charge.browserPaywall ?? paywall;
    const middleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, provider, false);
    return middleware(req, res, next);
  }

  private routeFor(rule: PricingRule, req: Request, signal: DetectionSignal): RouteConfig {
    return {
      accepts: {
        scheme: PREPAID_SCHEME,
        network: PAYPAL_SANDBOX,
        payTo: this.options.siteId,
        // Integer cents as the asset amount; no float formatting on the way.
        price: { asset: USD.asset, amount: String(rule.priceCents) },
        maxTimeoutSeconds: MAX_AUTHORIZATION_SECONDS,
        extra: { [BOTFARE_SIGNAL_EXTRA]: signal },
      },
      description: rule.description ?? `${rule.method} ${rule.pattern}`,
      mimeType: rule.mimeType ?? "",
      unpaidResponseBody: async () => ({
        contentType: "application/json",
        body: { preview: (await this.previewFor(req)) ?? null },
      }),
    };
  }

  /** The publisher's preview, validated; a broken preview never breaks the 402. */
  private async previewFor(req: Request): Promise<OfferPreview | undefined> {
    if (!this.options.preview) return undefined;
    try {
      const preview = await this.options.preview(req);
      if (!preview) return undefined;
      const parsed = offerPreviewSchema.safeParse({
        ...preview,
        excerpt: String(preview.excerpt ?? "").slice(0, 600),
      });
      if (parsed.success) return parsed.data;
      this.options.log(`preview for ${req.path} is invalid: ${parsed.error.message}`);
    } catch (err) {
      this.options.log(`preview for ${req.path} threw: ${(err as Error).message}`);
    }
    return undefined;
  }
}

/** Plain HTML for a browser that hits an "everyone" route; the SDK's default paywall is for wallets. */
const paywall: PaywallProvider = {
  generateHtml(paymentRequired) {
    const offer = paymentRequired.accepts[0];
    const price = offer ? `$${(Number(offer.amount) / 100).toFixed(2)}` : "a small fee";
    const what = escapeHtml(paymentRequired.resource?.description || "This resource");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Payment required</title></head><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>Payment required</h1><p>${what} costs ${price} per request, paid by AI agents through BotFare.</p></body></html>`;
  },
};
