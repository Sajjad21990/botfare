import { AGENT_HEADER, decodeAgentKey } from "@botfare/contracts";
import { PAYPAL_SANDBOX, PrepaidPayPalClient } from "@botfare/x402-paypal";
import { MAX_CONTROL_PLANE_RESPONSE_BYTES, readLimitedText } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { JWK } from "jose";
import { BotFareAgentKeyError, BotFareSpendLimitError } from "./errors";
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
}

export interface PaidResult {
  response: Response;
  /** True when the publisher settled a payment for this response. */
  paid: boolean;
  /** Decoded PAYMENT-RESPONSE (also present when settlement failed, with `success: false`). */
  receipt: SettleResponse | null;
  /** The 402 offer that was paid (or refused by the publisher); null if no 402 was seen. */
  offer: Offer | null;
  /** Why the publisher refused the payment (x402 `error` reason), when the result is still a 402. */
  failureReason?: string;
}

export interface BotFareAgent {
  keyId: string;
  maxPerRequestCents: number;
  /** One unpaid request: the offer behind a 402, or null if the URL did not ask for payment. Never pays. */
  getOffer(url: string, init?: RequestInit): Promise<Offer | null>;
  /**
   * Fetches `url`, paying automatically when the price is within `maxPerRequestUsd`.
   * Over-cap prices throw BotFareSpendLimitError before anything is signed.
   */
  fetch(url: string, init?: RequestInit): Promise<PaidResult>;
}

export const DEFAULT_MAX_PER_REQUEST_USD = 0.1;

export function createBotFareAgent(options: BotFareAgentOptions): BotFareAgent {
  const { keyId, privateJwk } = readAgentKey(options.agentKey);
  const maxPerRequestCents = toCapCents(options.maxPerRequestUsd ?? DEFAULT_MAX_PER_REQUEST_USD);
  const baseFetch = options.fetch ?? globalThis.fetch;
  const onWire = options.onWire;

  // The official x402 client with BotFare's scheme; spend controls run before the plug-in signs.
  const client = new x402Client()
    .register(PAYPAL_SANDBOX, new PrepaidPayPalClient({ keyId, privateJwk: privateJwk as JWK }))
    .setSpendControls({ maxAmountPerPayment: `$${(maxPerRequestCents / 100).toFixed(2)}` });

  async function getOffer(url: string, init?: RequestInit): Promise<Offer | null> {
    const response = await baseFetch(url, withAgentHeader(init));
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
      const request = new Request(input, innerInit);
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
    return {
      response,
      paid: receipt?.success === true,
      receipt,
      offer,
      ...(response.status === 402 && failureReason ? { failureReason } : {}),
    };
  }

  return { keyId, maxPerRequestCents, getOffer, fetch: fetchPaid };
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
