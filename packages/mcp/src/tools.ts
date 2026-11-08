import {
  BotFareOfferError,
  BotFareSpendLimitError,
  createBotFareAgent,
  DEFAULT_MAX_PER_REQUEST_USD,
  type Offer,
} from "@botfare/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type AgentWallet,
  type BotFareApi,
  BotFareApiError,
  createBotFareApi,
} from "./botfare-api";
import { formatUsd, htmlTitle, htmlToText, truncate, usdToCents } from "./text";

/**
 * BotFare's MCP tools: get_offer (free price + preview), fetch_paid (pay within limits and read),
 * wallet_balance and recent_receipts. The agent key never leaves this process: requests are
 * signed here (Web Bot Auth for every request, an Ed25519 JWS for each payment).
 */

export interface BotFareMcpOptions {
  /** `bfk_...` agent key from the BotFare wallet page. */
  agentKey: string;
  /** BotFare app URL (facilitator, key directory and agent API). */
  botfareUrl: string;
  /**
   * Price ceiling when fetch_paid gets no max_price_usd and the key has no per-request max.
   * Default 0.10.
   */
  defaultMaxPriceUsd?: number;
  /** Most characters of page text a tool returns; default 40,000. */
  maxTextChars?: number;
  /** Underlying fetch (tests). */
  fetch?: typeof fetch;
  /** Diagnostics; default stderr. Never receives key material. */
  log?: (message: string) => void;
}

export const SERVER_INSTRUCTIONS = `BotFare lets you read pages and APIs that charge AI agents a small fee per request (x402 over PayPal), paid from the user's prepaid BotFare balance.
Workflow: call get_offer first to see the price and a free preview; decide whether the content is worth it for the user's task; then call fetch_paid with max_price_usd set to the offered price. Never pay for something the preview shows is irrelevant. Payments are settled only after a successful response, and every payment returns a receipt ID you can cite. Use wallet_balance to check the budget and recent_receipts to review spending.`;

const MAX_BODY_BYTES = 2_000_000;

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

function checkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? null : "Only http(s) URLs";
  } catch {
    return "Not an absolute URL";
  }
}

function describeError(err: unknown): string {
  if (err instanceof BotFareApiError || err instanceof BotFareOfferError) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** The tightest limit on one payment, in cents, and the rule that sets it. */
export interface SpendCap {
  cents: number;
  reason: string;
}

/** min(max_price_usd or default, per-request max, what is left of today's cap, wallet balance). */
export function spendCap(
  wallet: AgentWallet | null,
  maxPriceUsd: number | undefined,
  defaultMaxPriceUsd: number,
): SpendCap {
  const candidates: SpendCap[] = [];
  if (maxPriceUsd !== undefined) {
    candidates.push({ cents: usdToCents(maxPriceUsd), reason: "your max_price_usd" });
  } else if (wallet?.perRequestMaxUsd == null) {
    candidates.push({
      cents: usdToCents(defaultMaxPriceUsd),
      reason: "the default price ceiling (pass max_price_usd to raise it)",
    });
  }
  if (wallet) {
    if (wallet.perRequestMaxUsd != null) {
      candidates.push({
        cents: usdToCents(wallet.perRequestMaxUsd),
        reason: `this key's per-request max (${formatUsd(wallet.perRequestMaxUsd)})`,
      });
    }
    if (wallet.dailyCapUsd != null) {
      const left = Math.max(0, wallet.dailyCapUsd - wallet.spentTodayUsd);
      candidates.push({
        cents: usdToCents(left),
        reason: `what is left of this key's daily cap (${formatUsd(left)} of ${formatUsd(wallet.dailyCapUsd)})`,
      });
    }
    candidates.push({
      cents: usdToCents(Math.max(0, wallet.balanceUsd)),
      reason: `the wallet balance (${formatUsd(wallet.balanceUsd)}); top up on the BotFare wallet page`,
    });
  }
  return candidates.reduce((tightest, next) => (next.cents < tightest.cents ? next : tightest));
}

function describeOffer(offer: Offer): string[] {
  const lines = [`Price: ${offer.priceUsd} per request (paid to site ${offer.payTo})`];
  if (offer.preview?.title) lines.push(`Title: ${offer.preview.title}`);
  else if (offer.description) lines.push(`Title: ${offer.description}`);
  if (offer.preview?.wordCount) lines.push(`Length: about ${offer.preview.wordCount} words`);
  if (offer.preview?.excerpt) lines.push(`Preview: ${offer.preview.excerpt}`);
  return lines;
}

/** Content of a successful response as text an LLM can read. */
async function readContent(response: Response, maxChars: number): Promise<string> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const textual =
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type === "";
  if (!textual) return `(${type} content, ${bytes.byteLength} bytes; not shown as text)`;
  const clipped = bytes.byteLength > MAX_BODY_BYTES ? bytes.subarray(0, MAX_BODY_BYTES) : bytes;
  const raw = new TextDecoder().decode(clipped);
  let body = raw;
  if (type.includes("html") || (type === "" && /^\s*</.test(raw))) {
    const title = htmlTitle(raw);
    const content = htmlToText(raw);
    body = title && !content.startsWith(`# ${title}`) ? `Title: ${title}\n\n${content}` : content;
  } else if (type.includes("json")) {
    try {
      body = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      body = raw;
    }
  }
  return truncate(body, maxChars);
}

export function createBotFareMcpServer(options: BotFareMcpOptions): McpServer {
  const log =
    options.log ?? ((message: string) => process.stderr.write(`[botfare-mcp] ${message}\n`));
  const defaultMax = options.defaultMaxPriceUsd ?? DEFAULT_MAX_PER_REQUEST_USD;
  const maxChars = options.maxTextChars ?? 40_000;
  const botfareUrl = new URL(options.botfareUrl).origin;
  /** An SDK agent with this per-request cap (it refuses higher prices before signing anything). */
  const agentWithCap = (capCents: number, guard?: typeof fetch) =>
    createBotFareAgent({
      agentKey: options.agentKey,
      botfareUrl,
      maxPerRequestUsd: Math.max(capCents, 1) / 100,
      ...(guard ? { fetch: guard } : options.fetch ? { fetch: options.fetch } : {}),
    });
  // Validates the key up front (with an error that never quotes it) so a bad BOTFARE_AGENT_KEY
  // fails at startup, not on first use.
  const probe = agentWithCap(1);
  const api: BotFareApi = createBotFareApi({
    agentKey: options.agentKey,
    botfareUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  async function walletOrNull(): Promise<{ wallet: AgentWallet | null; note?: string }> {
    try {
      return { wallet: await api.wallet() };
    } catch (err) {
      log(`wallet lookup failed: ${describeError(err)}`);
      return {
        wallet: null,
        note: `Could not read this key's limits from BotFare (${describeError(err)}); BotFare still enforces them when it settles.`,
      };
    }
  }

  const server = new McpServer(
    { name: "botfare", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "get_offer",
    {
      title: "Get price and preview (free)",
      description:
        "Check what a URL costs before paying. Makes one unpaid request and returns the price in USD, the publisher's site, and a free preview (title, excerpt, length) when the page charges agents through BotFare. Never pays and never signs a payment. Always call this before fetch_paid so you (and the user) can decide whether the content is worth the price.",
      inputSchema: { url: z.string().describe("Absolute http(s) URL of the page or API to price") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      const invalid = checkUrl(url);
      if (invalid) return text(`${invalid}: ${url}`, true);
      try {
        const offer = await probe.getOffer(url);
        if (!offer) {
          log(`get_offer ${url}: no payment asked`);
          return text(
            `${url} did not ask for payment (no HTTP 402). It is free to read: fetch_paid will fetch it without paying anything.`,
          );
        }
        log(`get_offer ${url}: ${offer.priceUsd}`);
        const { wallet, note } = await walletOrNull();
        const lines = [`Offer for ${url}`, ...describeOffer(offer)];
        if (wallet?.allowedSiteIds && !wallet.allowedSiteIds.includes(offer.payTo)) {
          lines.push(`This agent key may not pay site ${offer.payTo}; fetch_paid will refuse.`);
        } else {
          const cap = spendCap(wallet, offer.priceCents / 100, defaultMax);
          lines.push(
            cap.cents >= offer.priceCents
              ? `Within your limits. To buy it, call fetch_paid with url and max_price_usd ${(offer.priceCents / 100).toFixed(2)}.`
              : `Over your limits: ${cap.reason} is ${formatUsd(cap.cents / 100)}; fetch_paid will refuse.`,
          );
        }
        if (note) lines.push(note);
        return text(lines.join("\n"));
      } catch (err) {
        log(`get_offer ${url} failed: ${describeError(err)}`);
        return text(`Could not get an offer for ${url}: ${describeError(err)}`, true);
      }
    },
  );

  server.registerTool(
    "fetch_paid",
    {
      title: "Pay for and read a URL",
      description:
        "Fetch a URL, paying the publisher's BotFare price from the user's prepaid balance if it asks for one, and return the content as readable text with the receipt ID. Call get_offer first. Pays at most min(max_price_usd, this key's per-request max, what is left of its daily cap, the wallet balance); a higher price is refused before anything is signed, so no money moves. If max_price_usd is omitted, the ceiling is the key's per-request max (or $0.10). Free pages are fetched without paying.",
      inputSchema: {
        url: z.string().describe("Absolute http(s) URL to read"),
        max_price_usd: z
          .number()
          .positive()
          .max(1000)
          .optional()
          .describe("Most you agree to pay for this one request, in USD (e.g. 0.03)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, max_price_usd }) => {
      const invalid = checkUrl(url);
      if (invalid) return text(`${invalid}: ${url}`, true);
      try {
        const offer = await probe.getOffer(url);
        if (!offer) {
          // Free page: fetch it with a fetch that refuses to send any payment.
          const noPayment: typeof fetch = (input, init) => {
            const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
            if (headers.has("payment-signature")) {
              throw new Error("The page started asking for payment; call get_offer again");
            }
            return (options.fetch ?? globalThis.fetch)(input, init);
          };
          const result = await agentWithCap(1, noPayment).fetch(url);
          log(`fetch_paid ${url}: free, HTTP ${result.response.status}`);
          const content = await readContent(result.response, maxChars);
          const header = result.response.ok
            ? `No payment needed (HTTP ${result.response.status}). Nothing was charged.`
            : `HTTP ${result.response.status} ${result.response.statusText}. Nothing was charged.`;
          return text(`${header}\n\n${content}`, !result.response.ok);
        }

        const { wallet, note } = await walletOrNull();
        if (wallet?.allowedSiteIds && !wallet.allowedSiteIds.includes(offer.payTo)) {
          log(`fetch_paid ${url}: refused, site ${offer.payTo} not allowed`);
          return text(
            `Refused: this agent key may not pay site ${offer.payTo} (allowed sites are set on the BotFare wallet page). Nothing was signed or paid.`,
            true,
          );
        }
        const cap = spendCap(wallet, max_price_usd, defaultMax);
        if (offer.priceCents > cap.cents) {
          log(`fetch_paid ${url}: refused, ${offer.priceUsd} over ${formatUsd(cap.cents / 100)}`);
          return text(
            [
              `Refused: ${url} costs ${offer.priceUsd}, above ${cap.reason}: ${formatUsd(cap.cents / 100)}.`,
              "Nothing was signed or paid.",
              ...(note ? [note] : []),
            ].join("\n"),
            true,
          );
        }

        let result: Awaited<ReturnType<ReturnType<typeof agentWithCap>["fetch"]>>;
        try {
          result = await agentWithCap(cap.cents).fetch(url);
        } catch (err) {
          if (err instanceof BotFareSpendLimitError) {
            log(`fetch_paid ${url}: refused after a price change to ${err.offer.priceUsd}`);
            return text(
              `Refused: the price changed to ${err.offer.priceUsd}, above ${cap.reason}: ${formatUsd(cap.cents / 100)}. Nothing was signed or paid.`,
              true,
            );
          }
          throw err;
        }

        const { response, receipt } = result;
        if (response.status === 402) {
          const why = result.failureReason ?? receipt?.errorReason ?? "no reason given";
          log(`fetch_paid ${url}: payment refused (${why})`);
          await response.body?.cancel();
          return text(
            `The payment was not accepted (${why}). Nothing was charged. Check wallet_balance: the balance, daily cap or allowed sites may block it.`,
            true,
          );
        }
        if (!response.ok) {
          log(`fetch_paid ${url}: HTTP ${response.status}, not charged`);
          await response.body?.cancel();
          return text(
            `The publisher answered HTTP ${response.status} ${response.statusText}. Nothing was charged (BotFare settles only after a successful response).`,
            true,
          );
        }
        const content = await readContent(response, maxChars);
        const paidUsd = result.offer?.priceUsd ?? offer.priceUsd;
        const header = result.paid
          ? `Paid ${paidUsd} to site ${result.offer?.payTo ?? offer.payTo} for ${url}. Receipt: ${receipt?.transaction}`
          : `Read ${url} (HTTP ${response.status}); no payment was settled.`;
        log(
          `fetch_paid ${url}: ${result.paid ? `paid ${paidUsd}, ${receipt?.transaction}` : "not paid"}`,
        );
        return text(`${header}\n\n${content}`);
      } catch (err) {
        log(`fetch_paid ${url} failed: ${describeError(err)}`);
        return text(`Could not fetch ${url}: ${describeError(err)}`, true);
      }
    },
  );

  server.registerTool(
    "wallet_balance",
    {
      title: "Wallet balance and limits",
      description:
        "Show this agent key's budget: the prepaid wallet balance (USD, shared by the owner's keys), what the key spent today, its daily cap and per-request max, and which sites it may pay.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const wallet = await api.wallet();
        const lines = [
          `Agent key: ${wallet.keyName} (${wallet.keyId})`,
          `Wallet balance: ${formatUsd(wallet.balanceUsd)}`,
          wallet.dailyCapUsd == null
            ? `Spent today: ${formatUsd(wallet.spentTodayUsd)} (no daily cap)`
            : `Spent today: ${formatUsd(wallet.spentTodayUsd)} of a ${formatUsd(wallet.dailyCapUsd)} daily cap (${formatUsd(Math.max(0, wallet.dailyCapUsd - wallet.spentTodayUsd))} left, resets at 00:00 UTC)`,
          `Per-request max: ${wallet.perRequestMaxUsd == null ? `none set (fetch_paid defaults to ${formatUsd(defaultMax)} unless you pass max_price_usd)` : formatUsd(wallet.perRequestMaxUsd)}`,
          `Allowed sites: ${wallet.allowedSiteIds?.length ? wallet.allowedSiteIds.join(", ") : "any"}`,
        ];
        log("wallet_balance ok");
        return text(lines.join("\n"));
      } catch (err) {
        log(`wallet_balance failed: ${describeError(err)}`);
        return text(`Could not read the wallet: ${describeError(err)}`, true);
      }
    },
  );

  server.registerTool(
    "recent_receipts",
    {
      title: "Recent receipts",
      description:
        "List this agent key's most recent BotFare payments, newest first: time, site, URL, amount, status (settled or refunded) and receipt ID.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many receipts to list (1-50, default 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        const receipts = await api.receipts(limit ?? 10);
        log(`recent_receipts: ${receipts.length}`);
        if (receipts.length === 0) return text("No payments yet with this agent key.");
        const lines = receipts.map((r) => {
          const when = r.time.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");
          return `- ${when} | ${r.site} | ${formatUsd(r.amountUsd)} | ${r.status} | ${r.receiptId}${r.url ? ` | ${r.url}` : ""}`;
        });
        return text([`${receipts.length} most recent receipts:`, ...lines].join("\n"));
      } catch (err) {
        log(`recent_receipts failed: ${describeError(err)}`);
        return text(`Could not read receipts: ${describeError(err)}`, true);
      }
    },
  );

  return server;
}
