/**
 * Fare Court and Fare Advisor, agent side: disputes, decline notes and citation reports, sent to
 * BotFare signed with the agent's key (Web Bot Auth, the same signature as every other agent API
 * call: BotFare finds the key by its thumbprint and checks the signed `@authority` is its own).
 */
import { AGENT_HEADER } from "@botfare/contracts";
import {
  CITATIONS_PATH,
  citationReportSchema,
  DECLINES_PATH,
  type DeclineCategory,
  type DeclineNote,
  DISPUTES_PATH,
  type DisputeOutcome,
  type DisputeReason,
  declineNoteSchema,
  disputeRequestSchema,
  disputeStatusSchema,
  disputeVerdictSchema,
  MAX_DISPUTE_CONTENT_BYTES,
} from "@botfare/contracts/fare";
import type { RequestSigner } from "@botfare/contracts/web-bot-auth";
import { z } from "zod";
import { BotFareApiError } from "./errors";

export interface DisputeInput {
  /** The receipt (`rcpt_…`) from the paid fetch's PAYMENT-RESPONSE (`PaidResult.receiptId`). */
  receiptId: string;
  reason: DisputeReason;
  /** A short note for the judge, e.g. "a subscribe prompt instead of the article". */
  note?: string;
  /** The exact bytes delivered (`PaidResult.body`); BotFare checks them against the publisher's digest. */
  content: Uint8Array | string;
}

/** A citation report as the caller writes it (`claim` is optional). */
export type CitationReportInput = z.input<typeof citationReportSchema>;

export interface DeclineInput {
  category: DeclineCategory;
  /** Why the offer was not bought, in a sentence (at most 300 characters are sent). */
  reason: string;
}

/** Validates BotFare's answer to a dispute; the outcome decides nothing on the agent side. */
export const disputeOutcomeSchema = z.object({
  disputeId: z.string(),
  receiptId: z.string(),
  status: disputeStatusSchema,
  refundedCents: z.number().int().nonnegative(),
  verdict: disputeVerdictSchema.nullable(),
  message: z.string(),
}) satisfies z.ZodType<DisputeOutcome>;

export interface FareApiOptions {
  /** BotFare's origin; null when the agent was created without one. */
  botfareUrl: string | null;
  signer: RequestSigner;
  fetch: typeof fetch;
  /** Waits before re-filing a dispute BotFare refused as "not_attested" (tests). */
  notAttestedRetryMs?: number[];
}

/** Re-file a dispute refused because the publisher's attestation has not landed yet. */
const NOT_ATTESTED_RETRY_MS = [1_000, 2_000];

function isNotAttested(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const { error, reason } = body as { error?: unknown; reason?: unknown };
  return error === "not_attested" || reason === "not_attested";
}

/** Base64 of bytes, in chunks (no Buffer, so it also runs in the browser). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createFareApi(options: FareApiOptions) {
  const requireBase = (): string => {
    if (!options.botfareUrl) {
      throw new BotFareApiError(
        0,
        "This agent has no BotFare URL: pass botfareUrl to createBotFareAgent or set BOTFARE_URL",
      );
    }
    return options.botfareUrl;
  };

  /** POSTs JSON to BotFare, signed. Returns the status and parsed body (null if not JSON). */
  async function post(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
    const url = new URL(path, requireBase());
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
      [AGENT_HEADER]: "1",
    });
    for (const [name, value] of Object.entries(await options.signer.sign({ url, headers }))) {
      headers.set(name, value);
    }
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new BotFareApiError(
        0,
        `Could not reach BotFare at ${url.origin} (${(err as Error).message})`,
      );
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body };
  }

  function errorMessage(path: string, status: number, body: unknown): string {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `HTTP ${status}`;
    return `BotFare refused ${path}: ${message}`;
  }

  return {
    /**
     * Opens a Fare Court dispute on a receipt. Resolves with BotFare's outcome (refunded, denied,
     * pending publisher review, or invalid); throws BotFareApiError when BotFare cannot take it
     * (unreachable, unauthorized, rate limited) and RangeError when the content is too large.
     */
    async dispute(input: DisputeInput): Promise<DisputeOutcome> {
      const bytes =
        typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content;
      if (bytes.length > MAX_DISPUTE_CONTENT_BYTES) {
        throw new RangeError(
          `Dispute content is ${bytes.length} bytes; BotFare accepts at most ${MAX_DISPUTE_CONTENT_BYTES}`,
        );
      }
      const request = disputeRequestSchema.parse({
        receiptId: input.receiptId,
        reason: input.reason,
        ...(input.note ? { note: input.note.slice(0, 500) } : {}),
        contentBase64: bytesToBase64(bytes),
      });
      let { status, body } = await post(DISPUTES_PATH, request);
      // The publisher attests its digest just after the response is sent; a dispute filed within
      // the same moment can arrive first. Wait briefly for it (each retry is freshly signed).
      for (const delay of options.notAttestedRetryMs ?? NOT_ATTESTED_RETRY_MS) {
        if (!isNotAttested(body)) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        ({ status, body } = await post(DISPUTES_PATH, request));
      }
      // An outcome is an answer even when the status is 4xx (e.g. an invalid dispute).
      const outcome = disputeOutcomeSchema.safeParse(body);
      if (outcome.success) return outcome.data;
      throw new BotFareApiError(
        status === 200 ? 502 : status,
        errorMessage(DISPUTES_PATH, status, body),
      );
    },

    /**
     * Tells the publisher (through BotFare) why an offer was not bought. Free and best effort:
     * resolves true when BotFare took the note, false otherwise; never throws.
     */
    async decline(
      offer: { url: string; priceCents: number },
      input: DeclineInput,
    ): Promise<boolean> {
      const note = declineNoteSchema.safeParse({
        url: offer.url,
        priceCents: offer.priceCents,
        category: input.category,
        reason: input.reason.trim().slice(0, 300),
      } satisfies DeclineNote);
      if (!note.success) return false;
      try {
        const { status } = await post(DECLINES_PATH, note.data);
        return status >= 200 && status < 300;
      } catch {
        return false;
      }
    },

    /**
     * Reports which paid reads an answer actually used ("citations are the new clicks"). Best
     * effort: resolves true when BotFare took the report, false otherwise; never throws.
     */
    async reportCitations(report: CitationReportInput): Promise<boolean> {
      const parsed = citationReportSchema.safeParse(report);
      if (!parsed.success) return false;
      try {
        const { status } = await post(CITATIONS_PATH, parsed.data);
        return status >= 200 && status < 300;
      } catch {
        return false;
      }
    },
  };
}

export type FareApi = ReturnType<typeof createFareApi>;
