import type Anthropic from "@anthropic-ai/sdk";
import type { DeclineInput, DisputeInput, DisputeOutcome } from "@botfare/sdk";
import { BotFareSpendLimitError, type Offer, type WireListener } from "@botfare/sdk";
import type { ResearchDeps, ResearchModelClient } from "../src/lib/server/research-agent";
import type { ResearchAgent, ResearchSite } from "../src/lib/server/research-tools";

/** Fakes for the research agent tests: a Crema Notes-like site, a BotFare agent and a model. */

export const ORIGIN = "http://crema.test";
export const SITE: ResearchSite = { id: "site_crema", name: "Crema Notes", origin: ORIGIN };
export const URLS = {
  grinders: `${ORIGIN}/articles/grinders-under-200`,
  espresso: `${ORIGIN}/articles/dialing-in-espresso`,
  premium: `${ORIGIN}/articles/premium-grinder-roundup`,
  latte: `${ORIGIN}/articles/latte-art-hearts`,
  burrs: `${ORIGIN}/articles/burr-basics`,
  refused: `${ORIGIN}/articles/over-daily-cap`,
  stub: `${ORIGIN}/articles/grinder-maintenance`,
};

/** What the Fare Court demo page serves once paid: a subscribe stub, not the promised article. */
export const STUB_HTML =
  "<article><h1>Keep your grinder in shape</h1><p>This article is for subscribers. Subscribe to keep reading.</p></article>";

export interface FakePage {
  title: string;
  priceCents: number;
  html?: string;
  /** The facilitator refuses the payment (e.g. the key's daily cap). */
  refuse?: string;
  /** The price the free (unpaid) probe quotes, when the publisher quotes differently there. */
  offerPriceCents?: number;
  /** The publisher settles but leaves PAYMENT-RESPONSE out. */
  noReceipt?: boolean;
}

export const PAGES: Record<string, FakePage> = {
  [URLS.grinders]: {
    title: "Choosing a home grinder under $200",
    priceCents: 3,
    html: `<html><head><title>x</title><style>p{}</style></head><body><nav>Home</nav><article><h1>Choosing a home grinder</h1><p>The Burrwell 60 is the pick &amp; it steps finely.</p><script>alert(1)</script></article><footer>f</footer></body></html>`,
  },
  [URLS.espresso]: {
    title: "Dialing in espresso at home",
    priceCents: 5,
    html: "<article><h1>Dialing in</h1><p>Start at 18 g in, 36 g out, 28 s.</p></article>",
  },
  [URLS.premium]: { title: "The premium grinder roundup", priceCents: 50 },
  [URLS.latte]: { title: "Pouring your first latte-art heart", priceCents: 3 },
  [URLS.burrs]: {
    title: "Burr grinders, explained",
    priceCents: 3,
    html: "<article><p>Flat vs conical.</p></article>",
  },
  [URLS.refused]: { title: "Over the daily cap", priceCents: 2, refuse: "daily_cap_exceeded" },
  [URLS.stub]: { title: "Grinder maintenance, step by step", priceCents: 3, html: STUB_HTML },
};

export const CATALOG = {
  site: { name: "Crema Notes", description: "Field notes on grinders and espresso." },
  articles: Object.entries(PAGES).map(([url, page]) => ({
    slug: url.split("/").pop(),
    url,
    title: page.title,
    excerpt: `${page.title}: an excerpt.`,
    priceCents: page.priceCents,
  })),
  api: [{ url: `${ORIGIN}/api/brew-ratio`, description: "Brew ratios", priceCents: 1 }],
};

export function fakeOffer(url: string, page: FakePage): Offer {
  return {
    url,
    priceCents: page.priceCents,
    priceUsd: `$${(page.priceCents / 100).toFixed(2)}`,
    payTo: SITE.id,
    requirements: {} as Offer["requirements"],
    paymentRequired: {} as Offer["paymentRequired"],
    preview: { title: page.title, excerpt: `${page.title}: the free preview.`, wordCount: 600 },
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWS = `${b64({ alg: "EdDSA", typ: "x402-prepaid+jwt", kid: "key_demo" })}.${b64({ amount: "3" })}.sig`;

/** A fake BotFare agent per cap that behaves like the SDK: over-cap prices throw before signing. */
export function fakeAgents(
  pages: Record<string, FakePage> = PAGES,
  fare: {
    /** BotFare's answer to a dispute (default: a confident refund of the whole fare). */
    dispute?: (input: DisputeInput) => Promise<DisputeOutcome>;
    /** Whether BotFare takes decline notes and citation reports (default true). */
    notesAccepted?: boolean;
  } = {},
) {
  const calls = {
    created: [] as number[],
    getOffer: [] as string[],
    fetch: [] as { url: string; cap: number }[],
    disputes: [] as DisputeInput[],
    declines: [] as { url: string; priceCents: number; input: DeclineInput }[],
    citations: [] as { answerId: string; citations: { receiptId: string; claim?: string }[] }[],
  };
  const paidCents = new Map<string, number>();
  let receipts = 0;
  const create = (options: {
    maxPerRequestCents: number;
    onWire?: WireListener;
  }): ResearchAgent => {
    const { maxPerRequestCents, onWire } = options;
    calls.created.push(maxPerRequestCents);
    const required = (url: string, page: FakePage) =>
      onWire?.({
        stage: "payment-required",
        url,
        header: "eyJ4NDAyVmVyc2lvbiI6Mn0".repeat(6),
        decoded: {
          x402Version: 2,
          resource: { url },
          accepts: [
            {
              scheme: "prepaid",
              network: "paypal:sandbox",
              asset: "USD",
              amount: String(page.priceCents),
              payTo: SITE.id,
            },
          ],
        },
      } as never);
    return {
      keyId: "key_demo",
      maxPerRequestCents,
      async getOffer(url) {
        calls.getOffer.push(url);
        const page = pages[url];
        if (!page) throw new Error(`no such page ${url}`);
        const quoted = { ...page, priceCents: page.offerPriceCents ?? page.priceCents };
        if (quoted.priceCents === 0) return null;
        required(url, quoted);
        return fakeOffer(url, quoted);
      },
      async fetch(url) {
        calls.fetch.push({ url, cap: maxPerRequestCents });
        const page = pages[url];
        if (!page) throw new Error(`no such page ${url}`);
        const offer = fakeOffer(url, page);
        if (page.priceCents > 0) required(url, page);
        if (page.priceCents > maxPerRequestCents) {
          throw new BotFareSpendLimitError(offer, maxPerRequestCents);
        }
        if (page.refuse) {
          return {
            response: new Response("{}", { status: 402 }),
            paid: false,
            receipt: null,
            receiptId: null,
            body: null,
            offer,
            failureReason: page.refuse,
          };
        }
        const html = page.html ?? `<article><p>${page.title} full text.</p></article>`;
        const response = new Response(html, { headers: { "content-type": "text/html" } });
        const none = { paid: false, receipt: null, receiptId: null, body: null } as const;
        if (page.priceCents === 0) return { response, ...none, offer: null };
        onWire?.({
          stage: "payment-signature",
          url,
          header: "eyJwYXlsb2FkIjp7fX0".repeat(8),
          decoded: { x402Version: 2, accepted: {}, payload: { authorization: JWS } },
          authorizationClaims: {
            scheme: "prepaid",
            network: "paypal:sandbox",
            asset: "USD",
            amount: String(page.priceCents),
            payTo: SITE.id,
            nonce: "nonce-0123456789abcdef",
            iat: 1_700_000_000,
            exp: 1_700_000_060,
          },
        } as never);
        if (page.noReceipt) return { response, ...none, offer };
        receipts += 1;
        const receipt = {
          success: true,
          transaction: `rcpt_test${receipts}`,
          network: "paypal:sandbox" as const,
          payer: "key_demo",
        };
        onWire?.({
          stage: "payment-response",
          url,
          header: "eyJzdWNjZXNzIjp0cnVlfQ",
          decoded: receipt,
        } as never);
        paidCents.set(receipt.transaction, page.priceCents);
        return {
          response,
          paid: true,
          receipt,
          receiptId: receipt.transaction,
          body: new TextEncoder().encode(html),
          offer,
        };
      },
      async dispute(input) {
        calls.disputes.push(input);
        if (fare.dispute) return fare.dispute(input);
        const refundedCents = paidCents.get(input.receiptId) ?? 0;
        return {
          disputeId: `dsp_${calls.disputes.length}`,
          receiptId: input.receiptId,
          status: "refunded",
          refundedCents,
          verdict: {
            decision: "refund",
            confidence: 0.94,
            category: "stub_or_paywall",
            rationale:
              "The offer promised a step-by-step maintenance guide; a subscribe prompt arrived.",
            evidence: [],
          },
          message: `Refunded $${(refundedCents / 100).toFixed(2)} to the wallet.`,
        };
      },
      async decline(offer, input) {
        calls.declines.push({ url: offer.url, priceCents: offer.priceCents, input });
        return fare.notesAccepted ?? true;
      },
      async reportCitations(report) {
        calls.citations.push(report);
        return fare.notesAccepted ?? true;
      },
    };
  };
  return { create, calls };
}

type Block = Anthropic.Beta.Messages.BetaContentBlock;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

export function toolUse(id: string, name: string, input: unknown): Block {
  return { type: "tool_use", id, name, input } as Block;
}

export function text(value: string): Block {
  return { type: "text", text: value, citations: null } as Block;
}

/** The parsed tool_result contents of the last user message, by tool_use_id. */
export function lastToolResults(messages: MessageParam[]): Record<string, Record<string, unknown>> {
  const last = messages[messages.length - 1];
  const out: Record<string, Record<string, unknown>> = {};
  if (!last?.content || typeof last.content === "string") return out;
  for (const block of last.content) {
    if (block.type === "tool_result" && typeof block.content === "string") {
      out[block.tool_use_id] = JSON.parse(block.content);
    }
  }
  return out;
}

export type ScriptedTurn =
  | ((messages: MessageParam[]) => Block[])
  | ((messages: MessageParam[]) => { content: Block[]; stop_reason: string });

/** A model that plays back one scripted turn per request and records every request. */
export function scriptedClient(turns: ScriptedTurn[]) {
  const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) {
          requests.push(structuredClone(params));
          const turn = turns[requests.length - 1];
          if (!turn) throw new Error(`script has no turn ${requests.length}`);
          const result = turn(params.messages);
          const content = Array.isArray(result) ? result : result.content;
          const stopReason = Array.isArray(result)
            ? content.some((block) => block.type === "tool_use")
              ? "tool_use"
              : "end_turn"
            : result.stop_reason;
          const message = {
            id: `msg_${requests.length}`,
            type: "message",
            role: "assistant",
            model: params.model,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
              input_tokens: 1_000,
              output_tokens: 200,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          };
          const events = [
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "thinking_delta",
                thinking: `Turn ${requests.length}: weighing pages.`,
              },
            },
            ...content.flatMap((block, index) =>
              block.type === "text"
                ? [
                    {
                      type: "content_block_delta",
                      index,
                      delta: { type: "text_delta", text: block.text },
                    },
                  ]
                : [],
            ),
          ];
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  } as unknown as ResearchModelClient;
  return { client, requests };
}

export function fakeDeps(
  client: ResearchModelClient,
  agents = fakeAgents(),
  sites: ResearchSite[] = [SITE],
): ResearchDeps {
  return {
    client,
    model: "claude-sonnet-5-5",
    createAgent: agents.create,
    loadSites: async () => sites,
    fetchCatalog: async () => CATALOG,
  };
}
