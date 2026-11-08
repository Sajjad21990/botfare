import { type OfferPreview, offerPreviewSchema } from "@botfare/contracts";
import { formatUsd, PAYPAL_SANDBOX, PREPAID_SCHEME, parseAtomicCents } from "@botfare/x402-paypal";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { BotFareOfferError } from "./errors";

/** What a page costs, read from a 402 without paying. */
export interface Offer {
  url: string;
  /** Integer US cents, straight from `requirements.amount`. */
  priceCents: number;
  /** e.g. "$0.03" */
  priceUsd: string;
  /** The publisher's site ID. */
  payTo: string;
  /** The `prepaid` / `paypal:sandbox` entry of `accepts[]`. */
  requirements: PaymentRequirements;
  paymentRequired: PaymentRequired;
  description?: string;
  preview?: OfferPreview;
}

const PAYMENT_REQUIRED = "PAYMENT-REQUIRED";

/** Decodes the PAYMENT-REQUIRED header of a 402, or null when there is none. */
export function readPaymentRequired(response: Response): PaymentRequired | null {
  const header = response.headers.get(PAYMENT_REQUIRED);
  if (!header) return null;
  try {
    return decodePaymentRequiredHeader(header);
  } catch {
    return null;
  }
}

/**
 * Builds an Offer from a 402 and its body text. The preview comes from the JSON body
 * (`{ preview: { title, excerpt, wordCount? } }`, the middleware's `unpaidResponseBody`),
 * falling back to `extra.title` / `extra.preview` on the requirements.
 */
export function parseOffer(url: string, response: Response, bodyText: string): Offer {
  const paymentRequired = readPaymentRequired(response);
  if (!paymentRequired) {
    throw new BotFareOfferError(`${url} answered 402 without a valid PAYMENT-REQUIRED header`);
  }
  const requirements = paymentRequired.accepts.find(
    (accept) => accept.scheme === PREPAID_SCHEME && accept.network === PAYPAL_SANDBOX,
  );
  if (!requirements) {
    throw new BotFareOfferError(`${url} does not accept ${PREPAID_SCHEME} on ${PAYPAL_SANDBOX}`);
  }
  let priceCents: number;
  try {
    priceCents = parseAtomicCents(requirements.amount);
  } catch (err) {
    throw new BotFareOfferError(`${url} sent an invalid price: ${(err as Error).message}`);
  }
  const description = paymentRequired.resource?.description || undefined;
  const preview = previewFromBody(bodyText) ?? previewFromExtra(requirements);
  return {
    url,
    priceCents,
    priceUsd: formatUsd(priceCents),
    payTo: requirements.payTo,
    requirements,
    paymentRequired,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
  };
}

function previewFromBody(bodyText: string): OfferPreview | undefined {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const candidate =
    body && typeof body === "object" && "preview" in body
      ? (body as { preview: unknown }).preview
      : body;
  return parsePreview(candidate);
}

function previewFromExtra(requirements: PaymentRequirements): OfferPreview | undefined {
  const { title, preview } = requirements.extra ?? {};
  if (typeof preview === "object") return parsePreview(preview);
  if (typeof title !== "string" || typeof preview !== "string") return undefined;
  return parsePreview({ title, excerpt: preview });
}

function parsePreview(value: unknown): OfferPreview | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const excerpt = typeof raw.excerpt === "string" ? raw.excerpt.slice(0, 600) : raw.excerpt;
  const parsed = offerPreviewSchema.safeParse({ ...raw, excerpt });
  return parsed.success ? parsed.data : undefined;
}
