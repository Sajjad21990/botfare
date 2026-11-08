import {
  DISPUTE_POLICY,
  type DisputeOutcome,
  declineCategorySchema,
  disputeReasonSchema,
  MAX_DISPUTE_CONTENT_BYTES,
} from "@botfare/contracts/fare";
import {
  type BotFareStatement,
  decodeStatement,
  RECEIPT_KEYS_PATH,
  type ReceiptStatements,
} from "@botfare/contracts/receipts";
import {
  BotFareOfferError,
  BotFareApiError as BotFareSdkApiError,
  BotFareSpendLimitError,
  createBotFareAgent,
  DEFAULT_MAX_PER_REQUEST_USD,
  type Offer,
  type ReceiptVerification,
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
 * decline_offer (a free note on why an offer was skipped), dispute_purchase (Fare Court),
 * verify_receipt (check BotFare's signed statements offline), wallet_balance and recent_receipts. The agent key never leaves this process: requests are
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
Workflow: call get_offer first to see the price and a free preview; decide whether the content is worth it for the user's task; then either call fetch_paid with max_price_usd set to the offered price, or call decline_offer with a short, honest reason (free; it tells the publisher why, so prices and previews get better). Never pay for something the preview shows is irrelevant. Payments are settled only after a successful response, and every payment returns a receipt ID you can cite.
Buyer protection (Fare Court): if paid content clearly does not match its offer (a "subscribe to keep reading" stub, a paywall or login wall, an error page, or something unrelated to the declared title and preview), call dispute_purchase with the receipt ID within 24 hours; an AI judge compares the offer with what was delivered and confident cases are refunded in seconds. Do not dispute content that matches the offer but is merely shorter or less useful than hoped. Use wallet_balance to check the budget and recent_receipts to review spending.
Signed receipts: every payment comes with a payment statement signed by BotFare (Ed25519 JWS), and fetch_paid checks it for you. Call verify_receipt with a receipt ID to check BotFare's signed payment, delivery (the publisher's digest of the bytes it sent) and refund statements, for example before citing a paid source.`;

/** A paid read kept in memory so dispute_purchase can submit the exact bytes delivered. */
interface Purchase {
  receiptId: string;
  url: string;
  priceUsd: string;
  /** Null when the body was larger than a dispute may carry. */
  bytes: Uint8Array | null;
  /** BotFare's signed payment statement from the PAYMENT-RESPONSE, if it sent one. */
  statement?: string | null;
  /** sha-256 Content-Digest of the bytes this server read. */
  readDigest?: string | null;
  at: number;
  disputed?: DisputeOutcome;
}

/** Keeps the most recent purchases (bounded by count, bytes and the dispute window). */
export class PurchaseMemory {
  private readonly items = new Map<string, Purchase>();
  constructor(
    private readonly maxItems = 25,
    private readonly maxBytes = 8_000_000,
    private readonly ttlMs = DISPUTE_POLICY.windowHours * 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  add(purchase: Omit<Purchase, "at">): void {
    this.items.delete(purchase.receiptId);
    this.items.set(purchase.receiptId, { ...purchase, at: this.now() });
    this.prune();
  }

  get(receiptId: string): Purchase | undefined {
    this.prune();
    return this.items.get(receiptId);
  }

  get size(): number {
    return this.items.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, item] of this.items) if (item.at < cutoff) this.items.delete(id);
    let bytes = 0;
    for (const item of this.items.values()) bytes += item.bytes?.length ?? 0;
    // Map iteration is oldest first.
    for (const [id, item] of this.items) {
      if (this.items.size <= this.maxItems && bytes <= this.maxBytes) break;
      bytes -= item.bytes?.length ?? 0;
      this.items.delete(id);
    }
  }
}

function describeOutcome(outcome: DisputeOutcome): string {
  const lines: string[] = [];
  switch (outcome.status) {
    case "refunded":
      lines.push(
        `Refunded ${formatUsd(outcome.refundedCents / 100)} for receipt ${outcome.receiptId}.`,
      );
      break;
    case "denied":
      lines.push(
        `Dispute denied for receipt ${outcome.receiptId}: the judge found the content matches the offer. No refund.`,
      );
      break;
    case "pending_publisher":
      lines.push(
        `Dispute ${outcome.disputeId} is waiting for the publisher's review (the judge was not confident either way). Check recent_receipts later.`,
      );
      break;
    case "rejected_by_publisher":
      lines.push(`The publisher reviewed dispute ${outcome.disputeId} and declined the refund.`);
      break;
    case "invalid":
      lines.push(`BotFare could not accept this dispute: ${outcome.message}`);
      break;
  }
  if (outcome.status !== "invalid" && outcome.message) lines.push(outcome.message);
  if (outcome.verdict) {
    lines.push(
      `Judge: ${outcome.verdict.decision} (${Math.round(outcome.verdict.confidence * 100)}% confident, ${outcome.verdict.category}). ${outcome.verdict.rationale}`,
    );
  }
  lines.push(`Dispute ID: ${outcome.disputeId}`);
  return lines.join("\n");
}

const MAX_BODY_BYTES = 2_000_000;

function microsToUsd(micros: number): string {
  return formatUsd(micros / 1_000_000);
}

/** One line on what a verified statement says. */
function summarizeStatement(statement: BotFareStatement): string {
  switch (statement.kind) {
    case "payment": {
      const p = statement.payment;
      return `${microsToUsd(p.amountMicros)} paid to ${p.payTo}${p.resource ? ` for ${p.resource}` : ""} by ${p.payer} at ${p.settledAt} (publisher ${microsToUsd(p.publisherMicros)}, BotFare fee ${microsToUsd(p.feeMicros)})`;
    }
    case "delivery": {
      const d = statement.delivery;
      return `HTTP ${d.status}, ${d.contentLength} bytes of ${d.contentType || "unknown type"}, ${d.contentDigest}, attested at ${d.attestedAt}`;
    }
    case "refund": {
      const r = statement.refund;
      return `${microsToUsd(r.refundedMicros)} refunded via ${r.via}${r.disputeId ? ` (dispute ${r.disputeId})` : ""} at ${r.refundedAt}`;
    }
  }
}

/** "verified (BotFare key …): …" or "NOT verified (error): message". One line. */
function verificationLine(result: ReceiptVerification): string {
  return result.ok
    ? `verified, signed by BotFare key ${result.kid}: ${summarizeStatement(result.statement)}`
    : `NOT verified (${result.error}): ${result.message}`;
}
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
  if (
    err instanceof BotFareApiError ||
    err instanceof BotFareSdkApiError ||
    err instanceof BotFareOfferError
  )
    return err.message;
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

  const purchases = new PurchaseMemory();
  /** Prices seen by get_offer, so decline_offer can say what was declined without asking again. */
  const offers = new Map<string, Offer>();
  const rememberOffer = (offer: Offer) => {
    offers.delete(offer.url);
    offers.set(offer.url, offer);
    if (offers.size > 100) offers.delete(offers.keys().next().value as string);
  };

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

  /** The signed payment statement of a paid fetch and a one-line check of it. */
  async function signedReceiptLines(
    receiptId: string,
    statement: string | null,
  ): Promise<string[]> {
    if (!statement) {
      return ["Signed receipt: none (BotFare sent no payment statement with this payment)."];
    }
    const verified = await probe.verifyReceipt(statement, { kind: "payment", receiptId });
    log(`fetch_paid ${receiptId}: signed receipt ${verified.ok ? "verified" : verified.error}`);
    return [
      `Signed receipt (BotFare payment statement, Ed25519 JWS): ${statement}`,
      `Signature check: ${verificationLine(verified)}`,
    ];
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
        "Check what a URL costs before paying. Makes one unpaid request and returns the price in USD, the publisher's site, and a free preview (title, excerpt, length) when the page charges agents through BotFare. Never pays and never signs a payment. Always call this first, then decide: fetch_paid to buy it, or decline_offer to skip it with a reason.",
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
        rememberOffer(offer);
        const { wallet, note } = await walletOrNull();
        const lines = [`Offer for ${url}`, ...describeOffer(offer)];
        if (wallet?.allowedSiteIds && !wallet.allowedSiteIds.includes(offer.payTo)) {
          lines.push(`This agent key may not pay site ${offer.payTo}; fetch_paid will refuse.`);
        } else {
          const cap = spendCap(wallet, offer.priceCents / 100, defaultMax);
          lines.push(
            cap.cents >= offer.priceCents
              ? `Within your limits. To buy it, call fetch_paid with url and max_price_usd ${(offer.priceCents / 100).toFixed(2)}; to skip it, call decline_offer with a short reason.`
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
        "Fetch a URL, paying the publisher's BotFare price from the user's prepaid balance if it asks for one, and return the content as readable text with the receipt ID. Call get_offer first. If the paid content clearly does not match the offer (a stub, paywall, error page or unrelated page), call dispute_purchase with the receipt ID. Pays at most min(max_price_usd, this key's per-request max, what is left of its daily cap, the wallet balance); a higher price is refused before anything is signed, so no money moves. If max_price_usd is omitted, the ceiling is the key's per-request max (or $0.10). Free pages are fetched without paying.",
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
        let receiptLines: string[] = [];
        if (result.paid && result.receiptId) {
          const bytes = result.body;
          purchases.add({
            receiptId: result.receiptId,
            url,
            priceUsd: paidUsd,
            bytes: bytes && bytes.length <= MAX_DISPUTE_CONTENT_BYTES ? bytes : null,
            statement: result.receiptStatement,
            readDigest: result.readDigest,
          });
          receiptLines = await signedReceiptLines(result.receiptId, result.receiptStatement);
        }
        const header = result.paid
          ? [
              `Paid ${paidUsd} to site ${result.offer?.payTo ?? offer.payTo} for ${url}. Receipt: ${receipt?.transaction}`,
              ...receiptLines,
              "If this clearly is not what the offer promised (a stub, paywall, error page or unrelated content), call dispute_purchase with this receipt ID.",
            ].join("\n")
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
    "decline_offer",
    {
      title: "Skip an offer, with a reason (free)",
      description:
        "Tell the publisher, through BotFare, why you are not buying an offer you checked with get_offer: too expensive, irrelevant to the task, a preview too thin to judge, already have it, over budget, or other. Free, never pays, and helps publishers fix prices and previews. Give a short, honest, specific reason (no personal data).",
      inputSchema: {
        url: z.string().describe("The URL whose offer you are declining"),
        category: declineCategorySchema.describe("The main reason"),
        reason: z
          .string()
          .min(1)
          .max(300)
          .describe("One sentence on why, e.g. 'Thin listicle for 50¢'"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, category, reason }) => {
      const invalid = checkUrl(url);
      if (invalid) return text(`${invalid}: ${url}`, true);
      try {
        const offer = offers.get(url) ?? (await probe.getOffer(url));
        if (!offer)
          return text(`${url} does not ask for payment, so there is no offer to decline.`, true);
        const sent = await probe.decline(offer, { category, reason });
        log(`decline_offer ${url}: ${category}${sent ? "" : " (not delivered)"}`);
        return text(
          sent
            ? `Noted: told the publisher why you skipped ${url} (${offer.priceUsd}, ${category}). Nothing was paid.`
            : `Skipped ${url}; the note could not be delivered to BotFare right now (best effort). Nothing was paid.`,
        );
      } catch (err) {
        log(`decline_offer ${url} failed: ${describeError(err)}`);
        return text(`Could not decline ${url}: ${describeError(err)}`, true);
      }
    },
  );

  server.registerTool(
    "dispute_purchase",
    {
      title: "Dispute a purchase (buyer protection)",
      description: `Fare Court: ask for a refund when content bought with fetch_paid in this session clearly does not match its offer: a "subscribe to keep reading" stub or paywall (stub_or_paywall), an error or empty page (error_page), cut off far short of what was declared (truncated), a different page or spam (unrelated), or otherwise not as described (not_as_described). This server submits the exact bytes it received; BotFare checks them against the publisher's signed digest, and an AI judge compares the declared offer with what was delivered. Confident cases are refunded in seconds; unsure ones go to the publisher. Only within ${DISPUTE_POLICY.windowHours} hours and at most ${DISPUTE_POLICY.maxDisputesPerKeyPerDay} disputes per key per day; never dispute content that matches its offer.`,
      inputSchema: {
        receipt_id: z.string().describe("Receipt ID (rcpt_...) from fetch_paid"),
        reason: disputeReasonSchema.describe("What is wrong with the delivered content"),
        note: z
          .string()
          .max(500)
          .optional()
          .describe("One or two sentences of evidence, e.g. 'Only a subscribe prompt, no article'"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ receipt_id, reason, note }) => {
      const purchase = purchases.get(receipt_id);
      if (!purchase) {
        return text(
          `No content is held for receipt ${receipt_id}. This server keeps the exact bytes of its recent paid fetches (this session, last ${DISPUTE_POLICY.windowHours} hours) because a dispute must include them; it cannot dispute purchases made elsewhere.`,
          true,
        );
      }
      if (!purchase.bytes) {
        return text(
          `The content for receipt ${receipt_id} is larger than a dispute may carry (${MAX_DISPUTE_CONTENT_BYTES} bytes), so it cannot be disputed here.`,
          true,
        );
      }
      if (purchase.disputed) {
        return text(
          `Receipt ${receipt_id} was already disputed.\n\n${describeOutcome(purchase.disputed)}`,
        );
      }
      try {
        const outcome = await probe.dispute({
          receiptId: receipt_id,
          reason,
          ...(note ? { note } : {}),
          content: purchase.bytes,
        });
        if (outcome.status !== "invalid") purchase.disputed = outcome;
        log(`dispute_purchase ${receipt_id}: ${outcome.status}`);
        return text(describeOutcome(outcome), outcome.status === "invalid");
      } catch (err) {
        log(`dispute_purchase ${receipt_id} failed: ${describeError(err)}`);
        return text(`Could not file the dispute: ${describeError(err)}`, true);
      }
    },
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify a signed receipt",
      description: `Check BotFare's signed statements for a payment, offline, against the public keys BotFare publishes (${RECEIPT_KEYS_PATH}): the payment statement (who paid whom, how much, for which URL), the delivery statement (the publisher's digest of the exact bytes it sent) and a refund statement if one exists. Pass receipt_id (rcpt_...) to fetch and check every statement BotFare holds for it, or statement to check one signed statement (a JWS) you were given. For a purchase made in this session, also says whether the bytes this server read match the attested digest. Free; never pays.`,
      inputSchema: {
        receipt_id: z
          .string()
          .max(200)
          .optional()
          .describe("Receipt ID (rcpt_...) from fetch_paid or recent_receipts"),
        statement: z
          .string()
          .max(10_000)
          .optional()
          .describe("A signed BotFare statement (compact JWS) to check"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ receipt_id, statement }) => {
      const given = statement?.trim();
      if (!receipt_id?.trim() && !given) {
        return text("Pass receipt_id (rcpt_...) or statement (a signed JWS).", true);
      }
      const lines: string[] = [];
      const claims: BotFareStatement[] = [];
      let receiptId = receipt_id?.trim() || null;
      let failed = false;

      if (given) {
        const result = await probe.verifyReceipt(given, receiptId ? { receiptId } : {});
        const decoded = result.ok ? result.statement : decodeStatement(given);
        lines.push(
          `Given ${decoded?.kind ?? "statement"} statement${decoded ? ` for ${decoded.sub}` : ""}: ${verificationLine(result)}`,
        );
        if (result.ok) claims.push(result.statement);
        else {
          failed = true;
          if (decoded) {
            lines.push(
              `Claims as written (UNVERIFIED, do not rely on them): ${JSON.stringify(decoded)}`,
            );
          }
        }
        receiptId ??= decoded?.sub ?? null;
      }

      if (receiptId) {
        let held: ReceiptStatements | null = null;
        try {
          held = await probe.fetchStatements(receiptId);
          if (!held) {
            lines.push(`BotFare has no statements for ${receiptId} (unknown receipt).`);
            if (!given) failed = true;
          }
        } catch (err) {
          lines.push(`Could not read BotFare's statements for ${receiptId}: ${describeError(err)}`);
          if (!given) failed = true;
        }
        if (held) {
          lines.push(`Statements BotFare holds for ${receiptId}:`);
          let attested: string | null = null;
          for (const kind of ["payment", "delivery", "refund"] as const) {
            const token = held[kind];
            if (!token) {
              lines.push(
                `- ${kind}: none${kind === "delivery" ? " yet (the publisher attests just after delivery)" : ""}`,
              );
              continue;
            }
            const result = await probe.verifyReceipt(token, { kind, receiptId });
            lines.push(`- ${kind}: ${verificationLine(result)}`);
            if (!result.ok) {
              failed = true;
              continue;
            }
            if (!claims.some((c) => c.kind === kind && c.iat === result.statement.iat)) {
              claims.push(result.statement);
            }
            if (result.statement.kind === "delivery") {
              attested = result.statement.delivery.contentDigest;
            }
          }
          const purchase = purchases.get(receiptId);
          if (purchase?.readDigest && attested) {
            lines.push(
              purchase.readDigest === attested
                ? "The bytes this server read match the attested digest."
                : `The bytes this server read (${purchase.readDigest}) differ from the attested digest.`,
            );
          } else if (purchase?.readDigest) {
            lines.push(`Digest of the bytes this server read: ${purchase.readDigest}`);
          }
        }
      }

      if (claims.length > 0) {
        lines.push("Verified claims:", ...claims.map((c) => JSON.stringify(c)));
      }
      log(`verify_receipt ${receiptId ?? "(statement)"}: ${failed ? "not verified" : "verified"}`);
      return text(lines.join("\n"), failed);
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
