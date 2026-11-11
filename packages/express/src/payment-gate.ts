import {
  type DetectionSignal,
  FACILITATOR_PATH,
  type OfferPreview,
  offerPreviewSchema,
  type PricingRule,
} from "@botfare/contracts";
import {
  type DeclaredOffer,
  declaredOfferSchema,
  REQUIREMENT_EXTRA_KEYS,
} from "@botfare/contracts/fare";
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
import { normalizePath } from "./matching";

/**
 * Requirements carry the detection signal as `extra.botfareSignal`, so the facilitator can store
 * why each request paid. It is a dynamic field: the SDK leaves it out when matching a payment's
 * `accepted` against the requirements, so a paid retry matches even if its signal differs from
 * the 402's, and the requirements sent to verify/settle carry the server's own signal.
 */
export const BOTFARE_SIGNAL_EXTRA = REQUIREMENT_EXTRA_KEYS.signal;

/**
 * Fare Court: requirements also declare the offer (title, preview, word count) as
 * `extra.botfareOffer`. Like the signal it is server-authored and dynamic, so the facilitator's
 * settle call receives the publisher's own declaration (stored on the receipt), never the agent's
 * echo of it.
 */
export const BOTFARE_OFFER_EXTRA = REQUIREMENT_EXTRA_KEYS.offer;

/**
 * Signed receipts: requirements also carry the URL this server is serving as
 * `extra.botfareResource` (the same value as the 402's `resource.url`). Server-authored and
 * dynamic like the others, so the facilitator records the publisher's URL on the receipt, never
 * the `resource.url` the agent echoes back (its signature does not cover that field).
 */
export const BOTFARE_RESOURCE_EXTRA = REQUIREMENT_EXTRA_KEYS.resource;

class SignalRecordingPrepaidServer extends PrepaidPayPalServer {
  readonly dynamicExtraFields = [BOTFARE_SIGNAL_EXTRA, BOTFARE_OFFER_EXTRA, BOTFARE_RESOURCE_EXTRA];
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

/** What the gate did with one request, reported once the response has finished. */
export interface ChargeHooks {
  /** A 402 carrying a price was sent (Fare Advisor telemetry). */
  onOfferShown?: (offer: { path: string; method: string; priceCents: number }) => void;
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
   * the requirements; `browserPaywall` replaces the plain HTML paywall (the human check);
   * `siteOrigin` lets a matching X-Forwarded-Host name the signed resource (see `resourceUrl`).
   */
  async charge(
    rule: PricingRule,
    req: Request,
    res: Response,
    next: NextFunction,
    charge: {
      signal: DetectionSignal;
      browserPaywall?: PaywallProvider;
      hooks?: ChargeHooks;
      /** The site's registered origin (site config), the only forwarded origin trusted. */
      siteOrigin?: string;
    },
  ): Promise<void> {
    const preview = await this.previewFor(req);
    const route = this.routeFor(rule, charge.signal, preview, resourceUrl(req, charge.siteOrigin));
    const onOfferShown = charge.hooks?.onOfferShown;
    if (onOfferShown) {
      res.once("finish", () => {
        if (res.statusCode === 402 && res.getHeader("payment-required")) {
          onOfferShown({
            path: normalizePath(req.baseUrl + req.path),
            method: req.method,
            priceCents: rule.priceCents,
          });
        }
      });
    }
    const httpServer = new x402HTTPResourceServer(this.resourceServer, route);
    const provider = charge.browserPaywall ?? paywall;
    const middleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, provider, false);
    return middleware(req, res, next);
  }

  private routeFor(
    rule: PricingRule,
    signal: DetectionSignal,
    preview: OfferPreview | undefined,
    resource: string,
  ): RouteConfig {
    return {
      // The 402's resource.url and extra.botfareResource are the same server-built URL.
      resource,
      accepts: {
        scheme: PREPAID_SCHEME,
        network: PAYPAL_SANDBOX,
        payTo: this.options.siteId,
        // Integer cents as the asset amount; no float formatting on the way.
        price: { asset: USD.asset, amount: String(rule.priceCents) },
        maxTimeoutSeconds: MAX_AUTHORIZATION_SECONDS,
        extra: {
          [BOTFARE_SIGNAL_EXTRA]: signal,
          [BOTFARE_OFFER_EXTRA]: declaredOffer(rule, preview),
          [BOTFARE_RESOURCE_EXTRA]: resource,
        },
      },
      description: rule.description ?? `${rule.method} ${rule.pattern}`,
      mimeType: rule.mimeType ?? "",
      unpaidResponseBody: async () => ({
        contentType: "application/json",
        body: { preview: preview ?? null },
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

/** What `resourceUrl` reads from a request (Express `Request` satisfies it). */
export interface ResourceRequest {
  /** `http` or `https` (Express `req.protocol`, which honours `trust proxy`). */
  protocol: string;
  originalUrl: string;
  get(name: string): string | undefined;
}

/**
 * The URL being served, built as `@x402/express` builds a 402's `resource.url` (`req.protocol`,
 * the Host header, `req.originalUrl`), so honest agents cite the same string.
 *
 * Behind a reverse proxy the Host header is the internal one (the judge Docker stack fetches the
 * demo at `http://demo:4000` with `X-Forwarded-Host: localhost:4300`). The first X-Forwarded-Host
 * (with X-Forwarded-Proto, else `req.protocol`) is used instead only when it names exactly the
 * site's registered origin, so a client can never get a payment statement signed for a host of
 * its choosing.
 */
export function resourceUrl(req: ResourceRequest, siteOrigin?: string): string {
  const forwardedHost = firstValue(req.get("x-forwarded-host"));
  if (forwardedHost && siteOrigin) {
    const proto = firstValue(req.get("x-forwarded-proto")) ?? req.protocol;
    const forwarded = originOf(`${proto}://${forwardedHost}`);
    if (forwarded && forwarded === originOf(siteOrigin)) return `${forwarded}${req.originalUrl}`;
  }
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

/** First entry of a comma-separated forwarding header, trimmed; undefined when empty. */
function firstValue(header: string | undefined): string | undefined {
  return header?.split(",")[0]?.trim() || undefined;
}

/** The URL's origin, or undefined when it does not parse to one (e.g. an opaque `null` origin). */
function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * The offer as declared to the agent: the publisher's preview when there is one, else the pricing
 * rule's description. Always valid against `declaredOfferSchema` (trimmed to its limits).
 */
export function declaredOffer(rule: PricingRule, preview: OfferPreview | undefined): DeclaredOffer {
  const title =
    preview?.title.trim() || rule.description?.trim() || `${rule.method} ${rule.pattern}`;
  return declaredOfferSchema.parse({
    title: title.slice(0, 200),
    preview: (preview?.excerpt ?? "").slice(0, 600),
    ...(preview?.wordCount !== undefined ? { wordCount: preview.wordCount } : {}),
  });
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
