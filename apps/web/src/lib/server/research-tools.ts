import type Anthropic from "@anthropic-ai/sdk";
import {
  type BotFareAgent,
  BotFareSpendLimitError,
  type Offer,
  type WireEvent,
  type WireListener,
} from "@botfare/sdk";
import { decodeProtectedHeader } from "jose";
import { z } from "zod";
import {
  MAX_PER_REQUEST_CENTS,
  type ResearchCitation,
  type ResearchEvent,
  type SourceSummary,
  type WireStage,
} from "./research-events";

/**
 * The research agent's tools and their handlers. The model only ever sees tool inputs and
 * results; the agent key, the wallet and the budget stay here. Every input is validated with zod,
 * every limit is enforced in code, and page content goes back to the model as data.
 */

/** The parts of a BotFare agent the tools use (a fake one in tests). */
export type ResearchAgent = Pick<
  BotFareAgent,
  "keyId" | "maxPerRequestCents" | "getOffer" | "fetch"
>;

/** A BotFare site as the research agent sees it: from the sites table. */
export interface ResearchSite {
  id: string;
  name: string;
  origin: string;
}

/** Characters of page text returned to the model per purchase. */
export const MAX_CONTENT_CHARS = 8_000;
/** Bytes read from a catalog or a page before giving up. */
export const MAX_FETCH_BYTES = 1_000_000;
const MAX_EXCERPT_CHARS = 300;
const MAX_ARTICLES_PER_SITE = 40;

// --- Tool definitions -----------------------------------------------------------------------------

const urlField = z.string().trim().min(1).max(2048);
const reasonField = z.string().trim().min(1).max(400);

export const listSourcesInput = z.object({}).strict();
export const getOfferInput = z.object({ url: urlField }).strict();
export const buyInput = z.object({ url: urlField, reason: reasonField }).strict();
export const skipInput = z.object({ url: urlField, reason: reasonField }).strict();
export const finishInput = z
  .object({
    answer: z.string().trim().min(1).max(4_000),
    citations: z
      .array(
        z
          .object({
            url: urlField,
            receiptId: z.string().trim().min(1).max(200),
            claim: z.string().trim().min(1).max(400),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export type FinishInput = z.infer<typeof finishInput>;
export type ToolName = "list_sources" | "get_offer" | "buy" | "skip" | "finish";

const string = (description: string, maxLength?: number) => ({
  type: "string" as const,
  description,
  ...(maxLength ? { maxLength } : {}),
});

/** Tool definitions for the Messages API. Inputs are small; they are validated before running. */
export const RESEARCH_TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "list_sources",
    description:
      "List the BotFare-enabled sites and their free catalogs: each article's title, URL, price in US cents and a short excerpt, plus any paid APIs. Free; call it first.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    eager_input_streaming: true,
  },
  {
    name: "get_offer",
    description:
      "Read a page's offer without paying: its price, title and a free preview of the opening. Free (no money moves). Use it before deciding to buy.",
    input_schema: {
      type: "object",
      properties: { url: string("Full URL of a page or API from list_sources", 2048) },
      required: ["url"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "buy",
    description:
      "Pay the page's price from the research budget and get its full text and a receipt ID. Spends real (sandbox) money. Give a short reason the owner will see.",
    input_schema: {
      type: "object",
      properties: {
        url: string("Full URL of the page to buy", 2048),
        reason: string("Why this page is worth its price for the question (one sentence)", 400),
      },
      required: ["url", "reason"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "skip",
    description:
      "Record a decision not to buy a page, with the reason (for example: off-topic, or not worth the price). Free.",
    input_schema: {
      type: "object",
      properties: {
        url: string("Full URL of the page you are not buying", 2048),
        reason: string("Why you are not buying it (one sentence)", 400),
      },
      required: ["url", "reason"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "finish",
    description:
      "End the run with the final answer. Cite only pages bought in this run, each with the receipt ID that buy returned; refer to them in the answer as [1], [2], ... in the order of the citations list.",
    input_schema: {
      type: "object",
      properties: {
        answer: string("The answer for the owner, at most about 200 words, with [n] markers", 4000),
        citations: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              url: string("URL of a page bought in this run", 2048),
              receiptId: string("The receipt ID buy returned for that page", 200),
              claim: string("What this source supports in the answer (one sentence)", 400),
            },
            required: ["url", "receiptId", "claim"],
            additionalProperties: false,
          },
        },
      },
      required: ["answer", "citations"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];

// --- Run state ------------------------------------------------------------------------------------

export interface PurchasedPage {
  url: string;
  title: string | null;
  receiptId: string;
  amountCents: number;
  siteId: string;
  siteName: string;
}

export interface RunState {
  budgetCents: number;
  spentCents: number;
  /** Tool call the agent is working on, so wire events land on the right timeline entry. */
  currentToolCallId: string | null;
  /** Latest offer seen per normalized URL. */
  offers: Map<string, Offer | null>;
  /** Catalog titles per normalized URL. */
  titles: Map<string, string>;
  /** Purchases by receipt ID. */
  receipts: Map<string, PurchasedPage>;
  sources: CatalogSource[] | null;
}

export function createRunState(budgetCents: number): RunState {
  return {
    budgetCents,
    spentCents: 0,
    currentToolCallId: null,
    offers: new Map(),
    titles: new Map(),
    receipts: new Map(),
    sources: null,
  };
}

export function remainingCents(state: RunState): number {
  return Math.max(0, state.budgetCents - state.spentCents);
}

export interface ToolOutcome {
  /** Sent back to the model as the tool_result content. */
  content: string;
  isError?: boolean;
  /** The purchase was refused (cap, budget or publisher); reported as a refusal event. */
  refused?: boolean;
  /** Set by a valid `finish`: the run ends with this answer. */
  finished?: { answer: string; citations: ResearchCitation[] };
}

export interface ResearchToolContext {
  state: RunState;
  sites: ResearchSite[];
  /** The agent with the demo's per-request cap (MAX_PER_REQUEST_CENTS). */
  agent: ResearchAgent;
  /** The same key with a tighter per-request cap, so the SDK never signs past the budget. */
  agentWithCap: (maxPerRequestCents: number) => ResearchAgent;
  /** GET <origin>/catalog.json, parsed. */
  fetchCatalog: (site: ResearchSite, signal: AbortSignal) => Promise<unknown>;
  emit: (event: ResearchEvent) => void;
  signal: AbortSignal;
}

// --- Helpers --------------------------------------------------------------------------------------

/** An absolute http(s) URL without its fragment, or null. */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function siteForUrl(sites: ResearchSite[], url: string): ResearchSite | null {
  const origin = new URL(url).origin;
  return sites.find((site) => originOf(site.origin) === origin) ?? null;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function toolError(message: string): ToolOutcome {
  return { content: json({ error: message }), isError: true };
}

/** Cuts text to `max` characters, marking the cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} … [truncated]`;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Readable text from an HTML page: the <article> (or <main>, or <body>) without scripts, styles
 * and navigation, with headings, paragraphs and list items on their own lines.
 */
export function htmlToText(html: string): string {
  const region =
    /<article\b[\s\S]*?<\/article>/i.exec(html)?.[0] ??
    /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ??
    /<body\b[\s\S]*?<\/body>/i.exec(html)?.[0] ??
    html;
  const text = region
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|h[1-6]|li|ul|ol|tr|table|blockquote|pre|section|article|header|figure|dl|dd|dt)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reads at most `maxBytes` of a response body as text. */
export async function readTextLimited(response: Response, maxBytes = MAX_FETCH_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Page text for the model: readable text from HTML, compact JSON from APIs. */
export async function readableContent(response: Response): Promise<string> {
  const body = await readTextLimited(response);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return truncate(JSON.stringify(JSON.parse(body)), MAX_CONTENT_CHARS);
    } catch {
      return truncate(body, MAX_CONTENT_CHARS);
    }
  }
  if (type.includes("html") || /<html|<body|<article/i.test(body)) {
    return truncate(htmlToText(body), MAX_CONTENT_CHARS);
  }
  return truncate(body.trim(), MAX_CONTENT_CHARS);
}

// --- Catalogs -------------------------------------------------------------------------------------

const catalogSchema = z.object({
  site: z
    .object({ name: z.string().optional(), description: z.string().optional() })
    .partial()
    .optional(),
  articles: z
    .array(
      z.object({
        url: z.string(),
        title: z.string(),
        priceCents: z.number().int().nonnegative().optional(),
        excerpt: z.string().optional(),
        wordCount: z.number().int().nonnegative().optional(),
      }),
    )
    .max(500)
    .optional(),
  api: z
    .array(
      z.object({
        url: z.string(),
        description: z.string().optional(),
        priceCents: z.number().int().nonnegative().optional(),
        example: z.string().optional(),
      }),
    )
    .max(50)
    .optional(),
});

export interface CatalogSource {
  siteId: string;
  siteName: string;
  origin: string;
  description?: string;
  articles: {
    title: string;
    url: string;
    priceCents: number | null;
    excerpt: string;
    wordCount?: number;
  }[];
  api: { url: string; description: string; priceCents: number | null; example?: string }[];
  error?: string;
}

/** A site's catalog with every URL kept on the site's own origin. */
export function toCatalogSource(site: ResearchSite, raw: unknown): CatalogSource {
  const base = { siteId: site.id, siteName: site.name, origin: site.origin, articles: [], api: [] };
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) return { ...base, error: "catalog.json is not in the expected shape" };
  const origin = originOf(site.origin);
  const onSite = (value: string) => {
    const url = normalizeUrl(value);
    return url && new URL(url).origin === origin ? url : null;
  };
  const articles = (parsed.data.articles ?? []).slice(0, MAX_ARTICLES_PER_SITE).flatMap((a) => {
    const url = onSite(a.url);
    return url
      ? [
          {
            title: truncate(a.title, 200),
            url,
            priceCents: a.priceCents ?? null,
            excerpt: truncate(a.excerpt ?? "", MAX_EXCERPT_CHARS),
            ...(a.wordCount !== undefined ? { wordCount: a.wordCount } : {}),
          },
        ]
      : [];
  });
  const api = (parsed.data.api ?? []).slice(0, 10).flatMap((entry) => {
    const url = onSite(entry.url);
    const example = entry.example ? onSite(entry.example) : null;
    return url
      ? [
          {
            url,
            description: truncate(entry.description ?? "", MAX_EXCERPT_CHARS),
            priceCents: entry.priceCents ?? null,
            ...(example ? { example } : {}),
          },
        ]
      : [];
  });
  const description = parsed.data.site?.description;
  return {
    ...base,
    ...(description ? { description: truncate(description, MAX_EXCERPT_CHARS) } : {}),
    articles,
    api,
  };
}

// --- Wire events ----------------------------------------------------------------------------------

function shortHeader(header: string): string {
  return header.length > 96 ? `${header.slice(0, 96)}…` : header;
}

/** The SDK's wire event, decoded for display; the JWS itself is shortened. */
export function toWireStage(event: WireEvent): WireStage {
  const base = { header: shortHeader(event.header), headerLength: event.header.length };
  if (event.stage === "payment-signature") {
    const authorization = (event.decoded.payload as { authorization?: unknown }).authorization;
    let jwsHeader: Record<string, unknown> | null = null;
    if (typeof authorization === "string") {
      try {
        jwsHeader = decodeProtectedHeader(authorization) as Record<string, unknown>;
      } catch {
        jwsHeader = null;
      }
    }
    const decoded = {
      ...event.decoded,
      payload: {
        ...event.decoded.payload,
        ...(typeof authorization === "string" ? { authorization: shortHeader(authorization) } : {}),
      },
    };
    return {
      stage: "payment-signature",
      ...base,
      decoded,
      jwsHeader,
      claims: { ...event.authorizationClaims },
    };
  }
  return { stage: event.stage, ...base, decoded: event.decoded };
}

/** An onWire listener that tags each step with the tool call in progress. */
export function wireListener(state: RunState, emit: (event: ResearchEvent) => void): WireListener {
  return (event) =>
    emit({
      type: "wire",
      toolCallId: state.currentToolCallId,
      url: event.url,
      step: toWireStage(event),
    });
}

// --- Handlers -------------------------------------------------------------------------------------

/** Runs one tool call. Never throws: failures go back to the model as error results. */
export async function runTool(
  ctx: ResearchToolContext,
  name: string,
  input: unknown,
  toolCallId: string,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "list_sources":
        return await listSources(ctx, input, toolCallId);
      case "get_offer":
        return await getOffer(ctx, input, toolCallId);
      case "buy":
        return await buy(ctx, input, toolCallId);
      case "skip":
        return skip(ctx, input, toolCallId);
      case "finish":
        return finish(ctx, input);
      default:
        return toolError(`Unknown tool ${JSON.stringify(name).slice(0, 60)}`);
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    console.error("[research] tool failed", name, (err as Error)?.message);
    return toolError(`${name} failed: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return truncate(message.replace(/bfk_[A-Za-z0-9_-]+/g, "bfk_…"), 300);
}

function invalidInput(name: string, error: z.ZodError): ToolOutcome {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return toolError(`Invalid input for ${name}: ${where}${issue?.message ?? "bad shape"}`);
}

/** Validates a URL argument: absolute http(s) and on a BotFare site from list_sources. */
function siteUrl(
  ctx: ResearchToolContext,
  raw: string,
): { url: string; site: ResearchSite } | string {
  const url = normalizeUrl(raw);
  if (!url) return "url must be an absolute http(s) URL";
  const site = siteForUrl(ctx.sites, url);
  if (!site) return "url is not on a BotFare site from list_sources";
  return { url, site };
}

async function listSources(
  ctx: ResearchToolContext,
  input: unknown,
  toolCallId: string,
): Promise<ToolOutcome> {
  const parsed = listSourcesInput.safeParse(input ?? {});
  if (!parsed.success) return invalidInput("list_sources", parsed.error);
  if (!ctx.state.sources) {
    ctx.state.sources = await Promise.all(
      ctx.sites.map(async (site) => {
        try {
          return toCatalogSource(site, await ctx.fetchCatalog(site, ctx.signal));
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return {
            siteId: site.id,
            siteName: site.name,
            origin: site.origin,
            articles: [],
            api: [],
            error: `catalog.json unavailable (${describe(err)})`,
          } satisfies CatalogSource;
        }
      }),
    );
    for (const source of ctx.state.sources) {
      for (const article of source.articles) ctx.state.titles.set(article.url, article.title);
    }
  }
  const sources = ctx.state.sources;
  ctx.emit({
    type: "sources",
    toolCallId,
    sources: sources.map(
      (source): SourceSummary => ({
        siteId: source.siteId,
        siteName: source.siteName,
        origin: source.origin,
        available: !source.error,
        articleCount: source.articles.length,
        ...(source.error ? { error: source.error } : {}),
      }),
    ),
  });
  const available = sources.filter((source) => !source.error);
  return {
    content: json({
      budget: budgetLine(ctx.state),
      sites: available.map(({ error: _error, ...source }) => source),
      unavailable: sources
        .filter((source) => source.error)
        .map((source) => ({ siteName: source.siteName, reason: source.error })),
    }),
  };
}

function budgetLine(state: RunState) {
  return {
    budgetCents: state.budgetCents,
    spentCents: state.spentCents,
    remainingCents: remainingCents(state),
    maxPerRequestCents: MAX_PER_REQUEST_CENTS,
  };
}

function offerEvent(
  ctx: ResearchToolContext,
  toolCallId: string,
  url: string,
  site: ResearchSite,
  offer: Offer | null,
): void {
  const offerSite = offer ? (ctx.sites.find((s) => s.id === offer.payTo) ?? site) : site;
  ctx.emit({
    type: "offer",
    toolCallId,
    url,
    free: !offer,
    priceCents: offer?.priceCents ?? 0,
    title: offer?.preview?.title ?? ctx.state.titles.get(url) ?? null,
    excerpt: offer?.preview?.excerpt ?? null,
    wordCount: offer?.preview?.wordCount ?? null,
    siteId: offerSite.id,
    siteName: offerSite.name,
  });
}

async function getOffer(
  ctx: ResearchToolContext,
  input: unknown,
  toolCallId: string,
): Promise<ToolOutcome> {
  const parsed = getOfferInput.safeParse(input);
  if (!parsed.success) return invalidInput("get_offer", parsed.error);
  const target = siteUrl(ctx, parsed.data.url);
  if (typeof target === "string") return toolError(target);
  const offer = await ctx.agent.getOffer(target.url, { signal: ctx.signal });
  ctx.state.offers.set(target.url, offer);
  offerEvent(ctx, toolCallId, target.url, target.site, offer);
  if (offer?.preview?.title) ctx.state.titles.set(target.url, offer.preview.title);
  return {
    content: json(
      offer
        ? {
            url: target.url,
            priceCents: offer.priceCents,
            price: offer.priceUsd,
            title: offer.preview?.title ?? ctx.state.titles.get(target.url) ?? null,
            preview: offer.preview?.excerpt ?? null,
            wordCount: offer.preview?.wordCount ?? null,
            description: offer.description ?? null,
            budget: budgetLine(ctx.state),
          }
        : { url: target.url, priceCents: 0, free: true, budget: budgetLine(ctx.state) },
    ),
  };
}

async function buy(
  ctx: ResearchToolContext,
  input: unknown,
  toolCallId: string,
): Promise<ToolOutcome> {
  const parsed = buyInput.safeParse(input);
  if (!parsed.success) return invalidInput("buy", parsed.error);
  const target = siteUrl(ctx, parsed.data.url);
  if (typeof target === "string") return toolError(target);
  const { url, site } = target;
  const { state } = ctx;

  const already = [...state.receipts.values()].find((page) => page.url === url);
  if (already) {
    return toolError(`Already bought in this run (receipt ${already.receiptId}); use that text.`);
  }

  // The price, read free of charge if get_offer has not been called for this URL.
  let offer = state.offers.get(url);
  if (offer === undefined) {
    offer = await ctx.agent.getOffer(url, { signal: ctx.signal });
    state.offers.set(url, offer);
    offerEvent(ctx, toolCallId, url, site, offer);
  }
  const title = offer?.preview?.title ?? state.titles.get(url) ?? null;
  const priceCents = offer?.priceCents ?? 0;
  ctx.emit({
    type: "decision",
    toolCallId,
    action: "buy",
    url,
    title,
    priceCents: offer ? priceCents : null,
    reason: parsed.data.reason,
  });

  const refuse = (by: "spend-limit" | "budget" | "publisher", message: string): ToolOutcome => {
    ctx.emit({
      type: "refusal",
      toolCallId,
      url,
      by,
      priceCents: offer ? priceCents : null,
      message,
    });
    return {
      content: json({ refused: true, by, message, budget: budgetLine(state) }),
      isError: true,
      refused: true,
    };
  };

  const remaining = remainingCents(state);
  // Over the per-request cap: let the SDK's spend controls refuse it, before anything is signed.
  const overCap = priceCents > ctx.agent.maxPerRequestCents;
  if (!overCap && priceCents > remaining) {
    return refuse(
      "budget",
      `${url} costs ${priceCents}¢ but only ${remaining}¢ of the ${state.budgetCents}¢ budget is left; nothing was paid`,
    );
  }
  if (!overCap && remaining < 1) {
    return refuse("budget", "The research budget is used up; nothing was paid");
  }
  // Within the cap, the SDK's per-request limit is also the remaining budget, so a price that
  // changed since the offer can never take the run over budget.
  const agent = overCap
    ? ctx.agent
    : remaining < ctx.agent.maxPerRequestCents
      ? ctx.agentWithCap(remaining)
      : ctx.agent;

  let result: Awaited<ReturnType<ResearchAgent["fetch"]>>;
  try {
    result = await agent.fetch(url, { signal: ctx.signal });
  } catch (err) {
    if (err instanceof BotFareSpendLimitError) {
      const by = err.maxPerRequestCents < ctx.agent.maxPerRequestCents ? "budget" : "spend-limit";
      return refuse(by, err.message);
    }
    throw err;
  }

  if (result.response.status === 402) {
    await result.response.body?.cancel().catch(() => {});
    return refuse(
      "publisher",
      `The payment was refused${result.failureReason ? `: ${result.failureReason}` : ""}; nothing was charged`,
    );
  }
  if (!result.response.ok) {
    await result.response.body?.cancel().catch(() => {});
    return toolError(`${url} answered HTTP ${result.response.status}; nothing was charged`);
  }

  const content = await readableContent(result.response);
  if (!result.paid || !result.receipt?.transaction) {
    return {
      content: json({
        url,
        free: true,
        note: "This page was free; there is no receipt, so it cannot be cited.",
        title,
        text: content,
        budget: budgetLine(state),
      }),
    };
  }

  const amountCents = result.offer?.priceCents ?? priceCents;
  const paidSite = ctx.sites.find((s) => s.id === (result.offer?.payTo ?? offer?.payTo)) ?? site;
  const page: PurchasedPage = {
    url,
    title,
    receiptId: result.receipt.transaction,
    amountCents,
    siteId: paidSite.id,
    siteName: paidSite.name,
  };
  state.spentCents += amountCents;
  state.receipts.set(page.receiptId, page);
  ctx.emit({
    type: "payment",
    toolCallId,
    url,
    title,
    receiptId: page.receiptId,
    amountCents,
    siteId: page.siteId,
    siteName: page.siteName,
    spentCents: state.spentCents,
    remainingCents: remainingCents(state),
  });
  return {
    content: json({
      url,
      title,
      receiptId: page.receiptId,
      paidCents: amountCents,
      budget: budgetLine(state),
      text: content,
    }),
  };
}

function skip(ctx: ResearchToolContext, input: unknown, toolCallId: string): ToolOutcome {
  const parsed = skipInput.safeParse(input);
  if (!parsed.success) return invalidInput("skip", parsed.error);
  const url = normalizeUrl(parsed.data.url);
  if (!url) return toolError("url must be an absolute http(s) URL");
  const offer = ctx.state.offers.get(url);
  ctx.emit({
    type: "decision",
    toolCallId,
    action: "skip",
    url,
    title: offer?.preview?.title ?? ctx.state.titles.get(url) ?? null,
    priceCents: offer ? offer.priceCents : null,
    reason: parsed.data.reason,
  });
  return { content: json({ recorded: true, budget: budgetLine(ctx.state) }) };
}

/** Checks the final answer: every citation must name a receipt this run obtained, for its URL. */
export function validateFinish(
  state: RunState,
  input: unknown,
): { ok: true; answer: string; citations: ResearchCitation[] } | { ok: false; message: string } {
  const parsed = finishInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, message: `Invalid input for finish: ${where}${issue?.message}` };
  }
  const citations: ResearchCitation[] = [];
  for (const [index, citation] of parsed.data.citations.entries()) {
    const page = state.receipts.get(citation.receiptId);
    if (!page) {
      return {
        ok: false,
        message: `citations[${index}]: receipt ${JSON.stringify(citation.receiptId).slice(0, 80)} was not obtained in this run. Cite only pages you bought, with the receipt ID buy returned.`,
      };
    }
    if (normalizeUrl(citation.url) !== page.url) {
      return {
        ok: false,
        message: `citations[${index}]: receipt ${page.receiptId} is for ${page.url}, not ${truncate(citation.url, 200)}`,
      };
    }
    citations.push({
      n: index + 1,
      url: page.url,
      title: page.title,
      claim: citation.claim,
      receiptId: page.receiptId,
      amountCents: page.amountCents,
      siteId: page.siteId,
      siteName: page.siteName,
    });
  }
  return { ok: true, answer: parsed.data.answer, citations };
}

function finish(ctx: ResearchToolContext, input: unknown): ToolOutcome {
  const result = validateFinish(ctx.state, input);
  if (!result.ok) return toolError(result.message);
  return {
    content: json({ finished: true }),
    finished: { answer: result.answer, citations: result.citations },
  };
}
