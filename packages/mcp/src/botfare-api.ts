import { AGENT_HEADER, decodeAgentKey } from "@botfare/contracts";
import { createRequestSigner, type Ed25519PrivateJwk } from "@botfare/contracts/web-bot-auth";
import { z } from "zod";

/**
 * Client for BotFare's agent API (`/api/agent/*`). Every request carries the agent's Web Bot Auth
 * HTTP Message Signature (the same one the SDK puts on publisher requests), which is how BotFare
 * knows which key is asking. No other credential is sent.
 */

const usd = z.number().finite();

export const agentWalletSchema = z.object({
  keyId: z.string(),
  keyName: z.string(),
  /** The owner's wallet, shared by all of the owner's keys. */
  balanceUsd: usd,
  /** This key's settled spend in the current UTC day. */
  spentTodayUsd: usd,
  dailyCapUsd: usd.nullable(),
  perRequestMaxUsd: usd.nullable(),
  /** Null: any site. */
  allowedSiteIds: z.array(z.string()).nullable().optional(),
});
export type AgentWallet = z.infer<typeof agentWalletSchema>;

export const agentReceiptSchema = z.object({
  receiptId: z.string(),
  time: z.string(),
  site: z.string(),
  siteId: z.string().optional(),
  url: z.string().nullable(),
  amountUsd: usd,
  status: z.string(),
});
export type AgentReceipt = z.infer<typeof agentReceiptSchema>;

const receiptsResponseSchema = z.object({ receipts: z.array(agentReceiptSchema) });

/** BotFare answered with an error (or something that is not the expected JSON). */
export class BotFareApiError extends Error {
  override readonly name = "BotFareApiError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BotFareApiOptions {
  agentKey: string;
  /** BotFare app URL, e.g. http://localhost:3000. */
  botfareUrl: string;
  fetch?: typeof fetch;
}

export interface BotFareApi {
  wallet(): Promise<AgentWallet>;
  receipts(limit: number): Promise<AgentReceipt[]>;
}

export function createBotFareApi(options: BotFareApiOptions): BotFareApi {
  const { privateJwk } = decodeAgentKey(options.agentKey);
  const base = new URL(options.botfareUrl);
  const baseFetch = options.fetch ?? globalThis.fetch;
  const signer = createRequestSigner({
    privateJwk: privateJwk as Ed25519PrivateJwk,
    signatureAgent: base.origin,
  });

  async function getJson(path: string): Promise<unknown> {
    const url = new URL(path, base);
    const headers = new Headers({ accept: "application/json", [AGENT_HEADER]: "1" });
    for (const [name, value] of Object.entries(await signer.sign({ url, headers }))) {
      headers.set(name, value);
    }
    let response: Response;
    try {
      response = await baseFetch(url, { headers });
    } catch (err) {
      throw new BotFareApiError(
        0,
        `Could not reach BotFare at ${base.origin} (${(err as Error).message}). Is BOTFARE_URL right and the app running?`,
      );
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : `HTTP ${response.status}`;
      throw new BotFareApiError(response.status, `BotFare refused ${url.pathname}: ${message}`);
    }
    return body;
  }

  return {
    async wallet() {
      const parsed = agentWalletSchema.safeParse(await getJson("/api/agent/wallet"));
      if (!parsed.success) throw new BotFareApiError(502, "BotFare sent an unexpected wallet");
      return parsed.data;
    },
    async receipts(limit) {
      const parsed = receiptsResponseSchema.safeParse(
        await getJson(`/api/agent/receipts?limit=${encodeURIComponent(String(limit))}`),
      );
      if (!parsed.success) throw new BotFareApiError(502, "BotFare sent unexpected receipts");
      return parsed.data.receipts;
    },
  };
}
