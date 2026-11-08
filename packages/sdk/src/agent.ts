import { AGENT_HEADER, decodeAgentKey } from "@botfare/contracts";
import type { DisputeOutcome } from "@botfare/contracts/fare";
import { createRequestSigner, type RequestSigner } from "@botfare/contracts/web-bot-auth";
import { PAYPAL_SANDBOX, PrepaidPayPalClient } from "@botfare/x402-paypal";
import { MAX_CONTROL_PLANE_RESPONSE_BYTES, readLimitedText } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { JWK } from "jose";
import { BotFareAgentKeyError, BotFareSpendLimitError } from "./errors";
import {
  type CitationReportInput,
  createFareApi,
  type DeclineInput,
  type DisputeInput,
} from "./fare";
import { type Offer, parseOffer, readPaymentRequired } from "./offer";
import { readReceipt } from "./receipt";
import {
  emitPaymentRequired,
  emitPaymentResponse,
  emitPaymentSignature,
  type WireListener,
} from "./wire";

export interface BotFareAgentOptions {
  /** `bfk_...` agent key from the BotFare dashboard (`encodeAgentKey` in @botfare/contracts). */
  agentKey: string;
  /** Highest price the agent pays for one request; default 0.10. Checked before anything is signed. */
  maxPerRequestUsd?: number;
  /** Underlying fetch; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Called for each step of the x402 handshake, in order. */
  onWire?: WireListener;
  /**
   * BotFare app URL, sent as `Signature-Agent` so publishers can find this key in BotFare's
   * directory (`/.well-known/http-message-signatures-directory`). Default `process.env.BOTFARE_URL`;
   * without one, requests are still signed but carry no Signature-Agent.
   */
  botfareUrl?: string;
  /**
   * Sign every request (including paid retries) with an RFC 9421 HTTP Message Signature, Web Bot
   * Auth style, so publishers can tell a BotFare agent from an impostor. Default true.
   */
  signRequests?: boolean;
}

export interface PaidResult {
  /**
   * The publisher's response. For a paid response its body has already been read into `body`,
   * and `response` replays those same bytes, so read either (or both).
   */
  response: Response;
  /** True when the publisher settled a payment for this response. */
  paid: boolean;
  /** Decoded PAYMENT-RESPONSE (also present when settlement failed, with `success: false`). */
  receipt: SettleResponse | null;
  /** The receipt ID (`rcpt_…`) of a settled payment: what `agent.dispute()` takes. */
  receiptId: string | null;
  /**
   * The exact bytes delivered for a paid response (what the publisher attested by digest), kept
   * so a Fare Court dispute can submit them; null when nothing was paid.
   */
  body: Uint8Array | null;
  /** The 402 offer that was paid (or refused by the publisher); null if no 402 was seen. */
  offer: Offer | null;
  /** Why the publisher refused the payment (x402 `error` reason), when the result is still a 402. */
  failureReason?: string;
}

export interface BotFareAgent {
  keyId: string;
  /** JWK thumbprint of the agent's public key: the `keyid` in its request signatures; null if unsigned. */
  signatureKeyId(): Promise<string | null>;
  maxPerRequestCents: number;
  /** One unpaid request: the offer behind a 402, or null if the URL did not ask for payment. Never pays. */
  getOffer(url: string, init?: RequestInit): Promise<Offer | null>;
  /**
   * Fetches `url`, paying automatically when the price is within `maxPerRequestUsd`.
   * Over-cap prices throw BotFareSpendLimitError before anything is signed.
   */
  fetch(url: string, init?: RequestInit): Promise<PaidResult>;
  /**
   * Fare Court: disputes a paid receipt whose content did not match the offer (a stub, a paywall,
   * an error page, something unrelated). Pass the delivered bytes (`PaidResult.body`). Needs a
   * BotFare URL (`botfareUrl` or BOTFARE_URL). Throws BotFareApiError if BotFare cannot take it.
   */
  dispute(input: DisputeInput): Promise<DisputeOutcome>;
  /** Fare Advisor: a free, best-effort note saying why an offer was skipped. Never throws. */
  decline(offer: { url: string; priceCents: number }, input: DeclineInput): Promise<boolean>;
  /** Fare Advisor: which receipts an answer cited. Best effort; never throws. */
  reportCitations(report: CitationReportInput): Promise<boolean>;
}

export const DEFAULT_MAX_PER_REQUEST_USD = 0.1;

export function createBotFareAgent(options: BotFareAgentOptions): BotFareAgent {
  const { keyId, privateJwk } = readAgentKey(options.agentKey);
  const maxPerRequestCents = toCapCents(options.maxPerRequestUsd ?? DEFAULT_MAX_PER_REQUEST_USD);
  const baseFetch = options.fetch ?? globalThis.fetch;
  const onWire = options.onWire;
  const botfareUrl = readBotFareUrl(options.botfareUrl);
  const signingKey = privateJwk as Parameters<typeof createRequestSigner>[0]["privateJwk"];
  const signer =
    options.signRequests === false
      ? null
      : createRequestSigner({ privateJwk: signingKey, signatureAgent: botfareUrl });
  // Calls to BotFare's own API are always signed: the signature is the agent's credential there.
  const fare = createFareApi({
    botfareUrl,
    signer: signer ?? createRequestSigner({ privateJwk: signingKey, signatureAgent: botfareUrl }),
    fetch: baseFetch,
  });

  // The official x402 client with BotFare's scheme; spend controls run before the plug-in signs.
  const client = new x402Client()
    .register(PAYPAL_SANDBOX, new PrepaidPayPalClient({ keyId, privateJwk: privateJwk as JWK }))
    .setSpendControls({ maxAmountPerPayment: `$${(maxPerRequestCents / 100).toFixed(2)}` });

  async function getOffer(url: string, init?: RequestInit): Promise<Offer | null> {
    const response = await baseFetch(await sign(signer, new Request(url, withAgentHeader(init))));
    if (response.status !== 402) {
      await response.body?.cancel();
      return null;
    }
    emitPaymentRequired(onWire, url, response);
    return parseOffer(url, response, await readBody(response));
  }

  async function fetchPaid(url: string, init?: RequestInit): Promise<PaidResult> {
    let offer: Offer | null = null;
    let failureReason: string | undefined;

    // Sits under @x402/fetch so the wire inspector sees exactly what was sent and received.
    const observedFetch: typeof fetch = async (input, innerInit) => {
      const request = await sign(signer, new Request(input, innerInit));
      emitPaymentSignature(onWire, request);
      const response = await baseFetch(request);
      if (response.status === 402) {
        emitPaymentRequired(onWire, request.url, response);
        failureReason = readPaymentRequired(response)?.error;
        if (!offer) {
          try {
            offer = parseOffer(url, response, await readBody(response.clone()));
          } catch {
            // Not a BotFare offer; @x402/fetch reports its own error.
          }
        }
      } else {
        emitPaymentResponse(onWire, request.url, response);
      }
      return response;
    };

    let response: Response;
    try {
      response = await wrapFetchWithPayment(observedFetch, client)(url, withAgentHeader(init));
    } catch (err) {
      const capped = offer as Offer | null;
      if (capped && capped.priceCents > maxPerRequestCents && isSpendControlError(err)) {
        throw new BotFareSpendLimitError(capped, maxPerRequestCents);
      }
      throw err;
    }

    const receipt = readReceipt(response);
    const paid = receipt?.success === true;
    let body: Uint8Array | null = null;
    if (paid) {
      // Keep the exact bytes for a possible dispute, and hand back a response that replays them.
      body = new Uint8Array(await response.arrayBuffer());
      response = replayResponse(response, body);
    }
    return {
      response,
      paid,
      receipt,
      receiptId: paid && receipt?.transaction ? receipt.transaction : null,
      body,
      offer,
      ...(response.status === 402 && failureReason ? { failureReason } : {}),
    };
  }

  return {
    keyId,
    maxPerRequestCents,
    signatureKeyId: async () => (signer ? signer.keyid() : null),
    getOffer,
    fetch: fetchPaid,
    dispute: fare.dispute,
    decline: fare.decline,
    reportCitations: fare.reportCitations,
  };
}

/** A Response over already-read bytes, with the original's status, headers and URL. */
function replayResponse(original: Response, body: Uint8Array): Response {
  // A copy backed by a plain ArrayBuffer, so the caller's `body` and the replay never share state.
  const replay = new Response(body.length > 0 ? body.slice() : null, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
  Object.defineProperty(replay, "url", { value: original.url });
  Object.defineProperty(replay, "redirected", { value: original.redirected });
  return replay;
}

/** The request with Signature-Agent, Signature-Input and Signature set (unchanged without a signer). */
async function sign(signer: RequestSigner | null, request: Request): Promise<Request> {
  if (!signer) return request;
  const signed = await signer.sign({ url: request.url, headers: request.headers });
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);
  return new Request(request, { headers });
}

function readBotFareUrl(explicit: string | undefined): string | null {
  const value =
    explicit ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.BOTFARE_URL;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    throw new TypeError(`botfareUrl must be an absolute URL, got ${JSON.stringify(value)}`);
  }
}

function withAgentHeader(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(AGENT_HEADER, "1");
  return { ...init, headers };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await readLimitedText(response, MAX_CONTROL_PLANE_RESPONSE_BYTES);
  } catch {
    return "";
  }
}

function isSpendControlError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("spendControls");
}

function readAgentKey(agentKey: string) {
  if (typeof agentKey !== "string" || !agentKey.startsWith("bfk_")) {
    throw new BotFareAgentKeyError("Invalid BotFare agent key: it must start with bfk_");
  }
  try {
    return decodeAgentKey(agentKey);
  } catch {
    // Deliberately vague: parse errors can quote parts of the key.
    throw new BotFareAgentKeyError(
      "Invalid BotFare agent key: could not decode it; copy the full bfk_ key from the dashboard",
    );
  }
}

function toCapCents(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new RangeError("maxPerRequestUsd must be a positive number of dollars, e.g. 0.10");
  }
  // Round down to whole cents so the cap is never looser than asked.
  const cents = Math.floor(usd * 100 + 1e-9);
  if (cents < 1) throw new RangeError("maxPerRequestUsd must be at least 0.01");
  return cents;
}
