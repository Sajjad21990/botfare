import type Anthropic from "@anthropic-ai/sdk";
import {
  type DisputeOutcome,
  declineCategorySchema,
  disputeReasonSchema,
} from "@botfare/contracts/fare";
import {
  type AnswerManifest,
  type AnswerSource,
  answerManifestSchema,
  answerSourceSchema,
} from "@botfare/contracts/receipts";
import {
  type BotFareAgent,
  BotFareApiError,
  BotFareSpendLimitError,
  type Offer,
  type WireEvent,
  type WireListener,
} from "@botfare/sdk";
import { decodeProtectedHeader } from "jose";
import { z } from "zod";
import {
  MAX_DISPUTES_PER_RUN,
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
  | "keyId"
  | "maxPerRequestCents"
  | "getOffer"
  | "fetch"
  | "dispute"
  | "decline"
  | "reportCitations"
  | "fetchStatements"
>;

/** A BotFare site as the research agent sees it: from the sites table. */
export interface ResearchSite {
  id: string;
  name: string;
  origin: string;
}

/** Characters of page text returned to the model per purchase. */
export const MAX_CONTENT_CHARS = 8_000;
/**
 * Page text per purchase on providers other than Anthropic, whose free tiers cap one request at a
 * few thousand tokens (Groq: 8,000 per minute, history included).
 */
export const COMPACT_CONTENT_CHARS = 3_000;
/** Bytes read from a catalog or a page before giving up. */
export const MAX_FETCH_BYTES = 1_000_000;
const MAX_EXCERPT_CHARS = 300;
const MAX_ARTICLES_PER_SITE = 40;
/** Longest wait for a best-effort Fare Advisor note (decline, citations) before the run moves on. */
const NOTE_TIMEOUT_MS = 3_000;
/**
 * Waits between lookups of a cited receipt's statements while its delivery statement is missing:
 * the publisher attests the delivered bytes just after the response, so it can trail the purchase.
 */
export const DELIVERY_RETRY_MS = [300, 600, 900];
/** Longest wait for one source's statements before the answer goes out without its delivery. */
const MANIFEST_TIMEOUT_MS = 4_000;

// --- Tool definitions -----------------------------------------------------------------------------

const urlField = z.string().trim().min(1).max(2048);
const reasonField = z.string().trim().min(1).max(400);

export const listSourcesInput = z.object({}).strict();
export const getOfferInput = z.object({ url: urlField }).strict();
export const buyInput = z.object({ url: urlField, reason: reasonField }).strict();
export const skipInput = z
  .object({ url: urlField, reason: reasonField, category: declineCategorySchema.optional() })
  .strict();
export const disputeInput = z
  .object({
    receipt_id: z.string().trim().min(1).max(200),
    reason: disputeReasonSchema,
    note: z.string().trim().min(1).max(500),
  })
  .strict();
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
export type ToolName = "list_sources" | "get_offer" | "buy" | "skip" | "dispute" | "finish";

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
      "Record a decision not to buy a page, with the reason (for example: off-topic, or not worth the price). Free. The reason and category also go to the publisher as an anonymous note, so they can fix prices and previews: be specific and fair.",
    input_schema: {
      type: "object",
      properties: {
        url: string("Full URL of the page you are not buying", 2048),
        reason: string("Why you are not buying it (one sentence)", 400),
        category: {
          type: "string",
          enum: declineCategorySchema.options,
          description:
            "The main reason: too_expensive, irrelevant, low_quality_preview, already_have, over_budget or other",
        },
      },
      required: ["url", "reason"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "dispute",
    description:
      "Fare Court buyer protection: dispute a page you bought in this run when the delivered text clearly does not match its offer (a 'subscribe to keep reading' stub or paywall, an error or empty page, cut off far short of what was declared, or unrelated to the title and preview). BotFare checks the delivered bytes against the publisher's digest and an AI judge compares offer and delivery; confident cases are refunded in seconds. Free (no budget used). Never dispute a page that matches its offer but is less useful than hoped, and do not cite a disputed page.",
    input_schema: {
      type: "object",
      properties: {
        receipt_id: string("The receipt ID buy returned for the page", 200),
        reason: {
          type: "string",
          enum: disputeReasonSchema.options,
          description:
            "stub_or_paywall, error_page, truncated, unrelated, not_as_described or other",
        },
        note: string(
          "One or two sentences of evidence: what the offer promised and what arrived",
          500,
        ),
      },
      required: ["receipt_id", "reason", "note"],
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
  /** The exact bytes delivered (for a dispute); null when too large to keep. */
  delivered: Uint8Array | null;
  /** BotFare's signed payment statement from the PAYMENT-RESPONSE; null if it sent none. */
  paymentStatement: string | null;
  /** sha-256 Content-Digest of the bytes the agent read; null when they were too large to keep. */
  readDigest: string | null;
  /** Set once the page was disputed: the outcome, or "failed" when BotFare could not take it. */
  dispute?: DisputeOutcome["status"] | "failed";
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
  /**
   * Pages served after a payment was signed but without a receipt (PAYMENT-RESPONSE missing):
   * the amount may have been settled, so it counts against the budget and is never bought again.
   */
  unconfirmed: Map<string, number>;
  sources: CatalogSource[] | null;
  /** Disputes filed in this run (at most MAX_DISPUTES_PER_RUN). */
  disputes: number;
  /** URLs a decline note was sent for (one note per page per run). */
  declined: Set<string>;
}

export function createRunState(budgetCents: number): RunState {
  return {
    budgetCents,
    spentCents: 0,
    currentToolCallId: null,
    offers: new Map(),
    titles: new Map(),
    receipts: new Map(),
    unconfirmed: new Map(),
    sources: null,
    disputes: 0,
    declined: new Set(),
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
  /**
   * Set by a valid `finish`: the signed sources manifest for the answer (one source per citation
   * with a signed payment statement), or null when the answer cites nothing.
   */
  manifest?: AnswerManifest | null;
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
  /** ID of this run's answer for the citation report and the manifest (8-64 characters, e.g. the run ID). */
  answerId?: string;
  /** Waits between statement lookups while a delivery statement is missing (default DELIVERY_RETRY_MS). */
  deliveryRetryMs?: number[];
  /**
   * Characters of page text a buy returns (default MAX_CONTENT_CHARS). Only the model's copy is
   * cut: disputes and the manifest use the delivered bytes.
   */
  maxPageChars?: number;
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
  // Bounded entity lengths keep this linear on long runs of "&" and letters.
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (match, entity: string) => {
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

/** Elements dropped with everything inside them. */
const SKIPPED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "nav",
  "footer",
  "form",
]);
/** Closing tags that end a line. */
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "tr",
  "table",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "figure",
  "dl",
  "dd",
  "dt",
]);
/** Raw text gathered from a page before whitespace is collapsed (the model gets 8,000 chars). */
const MAX_RAW_TEXT_CHARS = 200_000;
const TAG_NAME = /^(\/?)([a-z][a-z0-9]*)/i;

/** ASCII-only lower case: the same length as the input, so indexes line up with the original. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
}

/** Index of the first `<name` opening tag (followed by a non-name character), or -1. */
function openTagIndex(lower: string, name: string, from = 0): number {
  for (let at = lower.indexOf(`<${name}`, from); at >= 0; at = lower.indexOf(`<${name}`, at + 1)) {
    const next = lower.charCodeAt(at + name.length + 1);
    // Not a letter, digit or underscore (or the end of the string): a whole tag name.
    if (!(next >= 97 && next <= 122) && !(next >= 48 && next <= 57) && next !== 95) return at;
  }
  return -1;
}

/**
 * Readable text from an HTML page: the <article> (or <main>, or <body>) without scripts, styles
 * and navigation, with headings, paragraphs and list items on their own lines.
 *
 * Page bodies are untrusted (up to MAX_FETCH_BYTES) and this runs on the server's event loop, so it
 * is one forward scan with indexOf, never a backtracking regex: linear in the input, whatever the
 * markup (unclosed tags, comments or elements included).
 */
export function htmlToText(html: string): string {
  const lowerHtml = asciiLower(html);
  let start = 0;
  let end = html.length;
  for (const name of ["article", "main", "body"]) {
    const open = openTagIndex(lowerHtml, name);
    if (open < 0) continue;
    const close = lowerHtml.indexOf(`</${name}>`, open);
    if (close < 0) continue;
    start = open;
    end = close + name.length + 3;
    break;
  }
  const source = html.slice(start, end);
  const lower = lowerHtml.slice(start, end);

  const out: string[] = [];
  let length = 0;
  const push = (piece: string) => {
    out.push(piece);
    length += piece.length;
  };
  // Elements known to have no closing tag past some point: never searched for again.
  const unclosed = new Set<string>();
  let at = 0;
  while (at < source.length && length < MAX_RAW_TEXT_CHARS) {
    const lt = source.indexOf("<", at);
    if (lt < 0) {
      push(source.slice(at));
      break;
    }
    push(source.slice(at, lt));
    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      if (close < 0) break;
      push(" ");
      at = close + 3;
      continue;
    }
    const gt = source.indexOf(">", lt + 1);
    // No ">" anywhere after this: there are no more tags, and a stray "<..." is not text.
    if (gt < 0) break;
    at = gt + 1;
    const tag = TAG_NAME.exec(source.slice(lt + 1, Math.min(gt, lt + 40)));
    if (!tag) continue;
    const closing = tag[1] === "/";
    const name = (tag[2] ?? "").toLowerCase();
    if (closing) {
      if (BLOCK_ELEMENTS.has(name)) push("\n");
      continue;
    }
    if (SKIPPED_ELEMENTS.has(name) && source[gt - 1] !== "/" && !unclosed.has(name)) {
      const close = lower.indexOf(`</${name}>`, gt + 1);
      if (close >= 0) {
        push(" ");
        at = close + name.length + 3;
      } else {
        unclosed.add(name);
      }
      continue;
    }
    const heading = /^h([1-6])$/.exec(name);
    if (heading) push(`\n\n${"#".repeat(Number(heading[1]))} `);
    else if (name === "li") push("\n- ");
    else if (name === "br" || name === "hr") push("\n");
  }

  return decodeEntities(out.join(""))
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
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
export async function readableContent(
  response: Response,
  maxChars = MAX_CONTENT_CHARS,
): Promise<string> {
  const body = await readTextLimited(response);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return truncate(JSON.stringify(JSON.parse(body)), maxChars);
    } catch {
      return truncate(body, maxChars);
    }
  }
  if (type.includes("html") || /<html|<body|<article/i.test(body)) {
    return truncate(htmlToText(body), maxChars);
  }
  return truncate(body.trim(), maxChars);
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
        return await skip(ctx, input, toolCallId);
      case "dispute":
        return await dispute(ctx, input, toolCallId);
      case "finish":
        return await finish(ctx, input);
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

/** Facilitator refusals caused by the agent's own key or wallet, explained for the owner. */
const KEY_LIMIT_REFUSALS: Record<string, string> = {
  invalid_prepaid_over_daily_cap:
    "the agent key has reached its daily cap, which resets at 00:00 UTC",
  insufficient_funds: "the agent's wallet balance is too low; top it up with PayPal",
};

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
  if (state.unconfirmed.has(url)) {
    return toolError("Already paid for in this run (without a receipt); it is not bought again.");
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
  if (remaining < 1) {
    return refuse("budget", "The research budget is used up; nothing was paid");
  }
  // Over the per-request cap: let the SDK's spend controls refuse it, before anything is signed.
  const overCap = priceCents > ctx.agent.maxPerRequestCents;
  if (!overCap && priceCents > remaining) {
    return refuse(
      "budget",
      `${url} costs ${priceCents}¢ but only ${remaining}¢ of the ${state.budgetCents}¢ budget is left; nothing was paid`,
    );
  }
  // The SDK pays whatever the paid request's own 402 asks, not the price get_offer saw, so its
  // per-request limit is always the smaller of the cap and the remaining budget: a price that
  // changed since the offer (or a publisher quoting differently) can never take the run over.
  const cap = Math.min(remaining, ctx.agent.maxPerRequestCents);
  const agent = cap < ctx.agent.maxPerRequestCents ? ctx.agentWithCap(cap) : ctx.agent;

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
    const keyLimit = result.failureReason ? KEY_LIMIT_REFUSALS[result.failureReason] : undefined;
    if (keyLimit) {
      return refuse(
        "spend-limit",
        `The payment was refused: ${keyLimit} (${result.failureReason}); nothing was charged`,
      );
    }
    return refuse(
      "publisher",
      `The payment was refused${result.failureReason ? `: ${result.failureReason}` : ""}; nothing was charged`,
    );
  }
  if (!result.response.ok && !result.paid) {
    await result.response.body?.cancel().catch(() => {});
    return toolError(`${url} answered HTTP ${result.response.status}; nothing was charged`);
  }

  // A 402 was answered with a signed payment, but the publisher sent no PAYMENT-RESPONSE: the
  // payment may still have settled, so it counts against the budget (and the page is not bought
  // again), but there is no receipt to cite.
  if (result.offer && !result.receipt) {
    await result.response.body?.cancel().catch(() => {});
    const amount = result.offer.priceCents;
    state.spentCents += amount;
    state.unconfirmed.set(url, amount);
    return toolError(
      `${url} was served after a ${amount}¢ payment was signed, but the publisher sent no receipt. The ${amount}¢ counts against the budget (${remainingCents(state)}¢ left); the page cannot be cited.`,
    );
  }

  const content = await readableContent(result.response, ctx.maxPageChars);
  if (!result.paid || !result.receiptId) {
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
    receiptId: result.receiptId,
    amountCents,
    siteId: paidSite.id,
    siteName: paidSite.name,
    delivered: result.body,
    paymentStatement: result.receiptStatement ?? null,
    readDigest: result.readDigest ?? null,
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
  const status = result.response.status;
  return {
    content: json({
      url,
      title,
      receiptId: page.receiptId,
      paidCents: amountCents,
      budget: budgetLine(state),
      ...(status >= 300 && status < 400
        ? {
            note: `Paid, but the publisher answered HTTP ${status} (a redirect, not followed) instead of the page. If the offer promised content, this purchase can be disputed.`,
          }
        : {}),
      text: content,
    }),
  };
}

/** Waits for a best-effort note at most NOTE_TIMEOUT_MS; false on timeout or failure. */
async function bestEffort(note: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), NOTE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([note.catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function skip(
  ctx: ResearchToolContext,
  input: unknown,
  toolCallId: string,
): Promise<ToolOutcome> {
  const parsed = skipInput.safeParse(input);
  if (!parsed.success) return invalidInput("skip", parsed.error);
  const url = normalizeUrl(parsed.data.url);
  if (!url) return toolError("url must be an absolute http(s) URL");
  const { state } = ctx;
  const offer = state.offers.get(url);
  ctx.emit({
    type: "decision",
    toolCallId,
    action: "skip",
    url,
    title: offer?.preview?.title ?? state.titles.get(url) ?? null,
    priceCents: offer ? offer.priceCents : null,
    reason: parsed.data.reason,
  });
  // Fare Advisor: tell the publisher why (free, best effort), once per page, only for an offer
  // this run actually saw and did not buy.
  const bought = [...state.receipts.values()].some((page) => page.url === url);
  let noted = false;
  if (offer && !bought && !state.declined.has(url) && siteForUrl(ctx.sites, url)) {
    state.declined.add(url);
    noted = await bestEffort(
      ctx.agent.decline(offer, {
        category: parsed.data.category ?? "other",
        reason: parsed.data.reason,
      }),
    );
  }
  return { content: json({ recorded: true, publisherNoted: noted, budget: budgetLine(state) }) };
}

async function dispute(
  ctx: ResearchToolContext,
  input: unknown,
  toolCallId: string,
): Promise<ToolOutcome> {
  const parsed = disputeInput.safeParse(input);
  if (!parsed.success) return invalidInput("dispute", parsed.error);
  const { state } = ctx;
  const { receipt_id: receiptId, reason, note } = parsed.data;
  const page = state.receipts.get(receiptId);
  if (!page) {
    return toolError(
      `Receipt ${JSON.stringify(receiptId).slice(0, 80)} was not obtained in this run; only pages bought in this run can be disputed.`,
    );
  }
  if (page.dispute)
    return toolError(`Receipt ${receiptId} was already disputed (${page.dispute}).`);
  if (state.disputes >= MAX_DISPUTES_PER_RUN) {
    return toolError(`At most ${MAX_DISPUTES_PER_RUN} disputes per run.`);
  }
  if (!page.delivered) {
    return toolError("The delivered content was too large to keep, so it cannot be disputed.");
  }
  state.disputes += 1;
  ctx.emit({
    type: "dispute-filed",
    toolCallId,
    receiptId,
    url: page.url,
    title: page.title,
    amountCents: page.amountCents,
    reason,
    note,
  });
  const started = Date.now();
  const outcomeEvent = (
    fields: Pick<
      Extract<ResearchEvent, { type: "dispute-outcome" }>,
      "status" | "refundedCents" | "message" | "verdict"
    >,
  ) =>
    ctx.emit({
      type: "dispute-outcome",
      toolCallId,
      receiptId,
      url: page.url,
      ...fields,
      elapsedMs: Date.now() - started,
      spentCents: state.spentCents,
      remainingCents: remainingCents(state),
    });

  let outcome: DisputeOutcome;
  try {
    outcome = await ctx.agent.dispute({ receiptId, reason, note, content: page.delivered });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    page.dispute = "failed";
    const message =
      err instanceof BotFareApiError
        ? err.message
        : `The dispute could not be filed (${describe(err)})`;
    outcomeEvent({
      status: "failed",
      refundedCents: 0,
      message: truncate(message, 300),
      verdict: null,
    });
    return toolError(`${truncate(message, 300)}. Do not cite this page.`);
  }

  page.dispute = outcome.status;
  // Money moved back to the wallet: the run may spend it again (never more than was paid).
  const refundedCents = Math.min(Math.max(outcome.refundedCents, 0), page.amountCents);
  if (outcome.status === "refunded")
    state.spentCents = Math.max(0, state.spentCents - refundedCents);
  const verdict = outcome.verdict
    ? {
        decision: outcome.verdict.decision,
        confidence: outcome.verdict.confidence,
        category: outcome.verdict.category,
        rationale: truncate(outcome.verdict.rationale, 600),
      }
    : null;
  outcomeEvent({
    status: outcome.status,
    refundedCents: outcome.status === "refunded" ? refundedCents : 0,
    message: truncate(outcome.message, 300),
    verdict,
  });
  return {
    content: json({
      receiptId,
      status: outcome.status,
      refundedCents: outcome.status === "refunded" ? refundedCents : 0,
      message: truncate(outcome.message, 300),
      verdict: verdict ? { decision: verdict.decision, rationale: verdict.rationale } : null,
      // Only a denied dispute (the judge found the content matched) leaves the page citable.
      citable: outcome.status === "denied",
      budget: budgetLine(state),
    }),
    ...(outcome.status === "invalid" ? { isError: true } : {}),
  };
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
    if (page.dispute && page.dispute !== "denied") {
      return {
        ok: false,
        message: `citations[${index}]: receipt ${page.receiptId} was disputed (${page.dispute}); do not cite a page whose content you disputed.`,
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

async function finish(ctx: ResearchToolContext, input: unknown): Promise<ToolOutcome> {
  const result = validateFinish(ctx.state, input);
  if (!result.ok) return toolError(result.message);
  const [manifest] = await Promise.all([
    buildAnswerManifest(ctx, result.citations),
    // Fare Advisor, "citations are the new clicks": which paid reads the answer used (best effort).
    result.citations.length > 0 && ctx.answerId
      ? bestEffort(
          ctx.agent.reportCitations({
            answerId: ctx.answerId,
            citations: result.citations.map((c) => ({ receiptId: c.receiptId, claim: c.claim })),
          }),
        )
      : Promise.resolve(false),
  ]);
  return {
    content: json({ finished: true }),
    finished: { answer: result.answer, citations: result.citations },
    manifest,
  };
}

// --- Sources manifest (signed receipts) ------------------------------------------------------------

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * BotFare's statements for a cited receipt, asking again (DELIVERY_RETRY_MS) while the delivery
 * statement is missing. An error (BotFare unreachable, no BotFare URL) ends the lookup.
 */
async function lookUpStatements(
  ctx: ResearchToolContext,
  receiptId: string,
): Promise<{ payment: string | null; delivery: string | null }> {
  const delays = ctx.deliveryRetryMs ?? DELIVERY_RETRY_MS;
  let payment: string | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const held = await ctx.agent.fetchStatements(receiptId);
      payment = held?.payment ?? payment;
      if (held?.delivery) return { payment, delivery: held.delivery };
    } catch (err) {
      console.error("[research] statements lookup failed", receiptId, (err as Error)?.message);
      return { payment, delivery: null };
    }
    const delay = delays[attempt];
    if (delay === undefined || ctx.signal.aborted) return { payment, delivery: null };
    await pause(delay, ctx.signal);
  }
}

/** `promise`, or `fallback` once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The answer's sources manifest: for each citation, BotFare's signed payment statement (from the
 * buy), its signed delivery statement (null if the publisher has not attested yet) and the digest
 * of the bytes the agent read, so anyone can check offline that each source was paid for and that
 * the bytes read are the bytes delivered. A citation without a signed payment statement is left
 * out. Null when the answer cites nothing. Never throws.
 */
export async function buildAnswerManifest(
  ctx: ResearchToolContext,
  citations: ResearchCitation[],
): Promise<AnswerManifest | null> {
  if (citations.length === 0) return null;
  const sources = await Promise.all(
    citations.map(async (citation): Promise<AnswerSource | null> => {
      const page = ctx.state.receipts.get(citation.receiptId);
      const held = await within(lookUpStatements(ctx, citation.receiptId), MANIFEST_TIMEOUT_MS, {
        payment: null,
        delivery: null,
      });
      const payment = page?.paymentStatement ?? held.payment;
      if (!payment) return null;
      const source = answerSourceSchema.safeParse({
        url: citation.url,
        receiptId: citation.receiptId,
        claim: citation.claim.slice(0, 300),
        payment,
        delivery: held.delivery,
        readDigest: page?.readDigest ?? null,
      });
      if (!source.success) {
        console.error("[research] source left out of the manifest", citation.receiptId);
        return null;
      }
      return source.data;
    }),
  );
  const manifest = answerManifestSchema.safeParse({
    answerId:
      ctx.answerId && ctx.answerId.length >= 8 ? ctx.answerId.slice(0, 64) : crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sources: sources.filter((source): source is AnswerSource => source !== null),
  });
  if (!manifest.success) {
    console.error("[research] invalid sources manifest", manifest.error.issues[0]?.message);
    return null;
  }
  return manifest.data;
}
