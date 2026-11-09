import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawStreamEvent,
  BetaStopReason,
  BetaUsage,
  ModelClient,
  ModelCreateParams,
  ModelRequestOptions,
  ModelStream,
  ModelStreamParams,
} from "./model-client";

/**
 * The Anthropic `beta.messages.create` / `beta.messages.stream` slice on top of any OpenAI-
 * compatible Chat Completions API (OpenAI, Gemini, xAI, Groq, OpenRouter, Ollama), with plain
 * fetch. Requests are translated from Messages params, answers come back as Anthropic-shaped
 * messages, and HTTP failures become the Anthropic SDK's error classes, so the AI modules keep
 * their logic and their `instanceof` checks.
 *
 * - Anthropic-only params are ignored: thinking, output_config.effort, cache_control, betas,
 *   fallbacks, metadata. Thinking blocks in the history are dropped. Exception: on OpenAI's own
 *   API (`reasoningEffort`), reasoning models get `output_config.effort` as `reasoning_effort`
 *   ("low" when absent), so reasoning tokens do not eat the whole `max_completion_tokens`.
 * - `output_config.format` (JSON schema) becomes `response_format: json_schema`; a provider that
 *   rejects it with a 400 is asked again with `json_object` and the schema in the system prompt,
 *   then with the schema in the prompt alone (remembered per model).
 * - `stream()` makes one non-streaming request and replays it as Messages stream events.
 * - API keys never appear in errors or logs.
 */

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider extras echoed back on the next turn (Gemini's thought signatures). */
  extra_content?: unknown;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: {
    type: "function";
    function: { name: string; description?: string; parameters: unknown };
  }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  response_format?:
    | { type: "json_schema"; json_schema: { name: string; schema: unknown; strict: false } }
    | { type: "json_object" };
  stop?: string[];
  reasoning_effort?: ReasoningEffort;
  stream: false;
}

export type ReasoningEffort = "low" | "medium" | "high";

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null | { type?: string; text?: string }[];
      reasoning_content?: string | null;
      reasoning?: string | null;
      refusal?: string | null;
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string | Record<string, unknown> };
        extra_content?: unknown;
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
}

/** How a JSON-schema answer is asked for: natively, as json_object, or in the prompt only. */
export type JsonMode = "schema" | "object" | "prompt";
const JSON_MODES: JsonMode[] = ["schema", "object", "prompt"];

/** Key on a tool_use block that carries the provider's `extra_content` to the next turn. */
export const EXTRA_CONTENT_KEY = "extra_content";
/** Gemini accepts this in place of a thought signature that was not kept. */
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

export interface TranslateOptions {
  /** OpenAI's own API wants `max_completion_tokens`; the others take `max_tokens`. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  jsonMode?: JsonMode;
  /** Gemini: every assistant step with tool calls carries a thought signature. */
  thoughtSignatures?: boolean;
  /** OpenAI: send `reasoning_effort` to reasoning models (see isReasoningModel). */
  reasoningEffort?: boolean;
}

/** OpenAI reasoning models (gpt-5*, o1/o3/o4…), not the gpt-5 chat models. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model) && !/-chat/.test(model);
}

/** Anthropic's effort as OpenAI's `reasoning_effort` ("low" when none was asked for). */
export function reasoningEffortFor(params: ModelStreamParams): ReasoningEffort {
  const effort = params.output_config?.effort;
  if (effort === "medium") return "medium";
  if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
  return "low";
}

/** The model's tool input was not valid JSON: the caller may re-issue the turn. */
export class ToolInputParseError extends Error {
  constructor(toolName: string) {
    super(`The model sent unparseable arguments for tool ${toolName}`);
    this.name = "ToolInputParseError";
  }
}

// --- Messages params -> Chat Completions request --------------------------------------------------

type ParamMessage = Extract<ModelCreateParams["messages"][number], { role: "user" | "assistant" }>;
type ParamBlock = Exclude<ParamMessage["content"], string>[number];

function jsonFormat(params: ModelStreamParams): Record<string, unknown> | null {
  const format = params.output_config?.format;
  return format?.type === "json_schema" ? format.schema : null;
}

function systemText(params: ModelStreamParams): string {
  const { system } = params;
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

export function jsonInstruction(schema: unknown): string {
  return [
    "Reply with only a JSON object: no prose and no code fences. It must match this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

function imageUrl(block: Extract<ParamBlock, { type: "image" }>): string | null {
  const source = block.source;
  if (source.type === "base64") return `data:${source.media_type};base64,${source.data}`;
  if (source.type === "url") return source.url;
  return null;
}

function toolResultText(block: Extract<ParamBlock, { type: "tool_result" }>): string {
  const { content } = block;
  let text: string;
  if (content === undefined) text = "";
  else if (typeof content === "string") text = content;
  else {
    text = content
      .map((part) => (part.type === "text" ? part.text : `[${part.type} omitted]`))
      .join("\n");
  }
  if (!text) text = "(empty)";
  return block.is_error && !/error/i.test(text) ? `Error: ${text}` : text;
}

function userMessages(content: ParamBlock[]): ChatMessage[] {
  const tools: ChatMessage[] = [];
  const parts: ChatContentPart[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      tools.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block) });
    } else if (block.type === "text") {
      if (block.text) parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const url = imageUrl(block);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  const out = [...tools];
  if (parts.length > 0) {
    const textOnly = parts.every((part) => part.type === "text");
    out.push({
      role: "user",
      content: textOnly
        ? parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n")
        : parts,
    });
  }
  return out;
}

function assistantMessage(content: ParamBlock[], options: TranslateOptions): ChatMessage | null {
  const texts: string[] = [];
  const calls: ChatToolCall[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text) texts.push(block.text);
    } else if (block.type === "tool_use") {
      const call: ChatToolCall = {
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      };
      const extra = (block as unknown as Record<string, unknown>)[EXTRA_CONTENT_KEY];
      if (extra !== undefined) call.extra_content = extra;
      calls.push(call);
    }
    // thinking and redacted_thinking blocks belong to Anthropic: dropped.
  }
  if (texts.length === 0 && calls.length === 0) return null;
  const first = calls[0];
  if (options.thoughtSignatures && first && !calls.some((c) => c.extra_content !== undefined)) {
    first.extra_content = { google: { thought_signature: GEMINI_SKIP_SIGNATURE } };
  }
  return {
    role: "assistant",
    content: texts.length ? texts.join("\n\n") : null,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

/**
 * Every assistant tool call is answered by a tool message right after it (a placeholder when the
 * history has none), and tool messages that answer nothing are dropped: providers reject both.
 */
function pairToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as ChatMessage;
    if (message.role === "tool") continue; // consumed below, or unanswerable
    out.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const results = new Map<string, ChatMessage>();
    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j] as ChatMessage;
      if (next.role !== "tool") break;
      if (!results.has(next.tool_call_id)) results.set(next.tool_call_id, next);
    }
    for (const call of message.tool_calls) {
      out.push(
        results.get(call.id) ?? {
          role: "tool",
          tool_call_id: call.id,
          content: "Error: no result was recorded for this call.",
        },
      );
    }
    i = j - 1;
  }
  return out;
}

export function toChatRequest(
  params: ModelStreamParams,
  options: TranslateOptions = {},
): ChatRequest {
  const format = jsonFormat(params);
  const mode = options.jsonMode ?? "schema";
  let system = systemText(params);
  if (format && mode !== "schema") {
    system = system ? `${system}\n\n${jsonInstruction(format)}` : jsonInstruction(format);
  }

  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  for (const message of params.messages) {
    if (message.role === "system") {
      // Mid-conversation system text; tool additions and removals are Anthropic-only.
      const text =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .flatMap((b) => (b.type === "text" ? [b.text] : []))
              .join("\n\n");
      if (text) messages.push({ role: "system", content: text });
      continue;
    }
    if (typeof message.content === "string") {
      if (message.role === "user") messages.push({ role: "user", content: message.content });
      else if (message.content) messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.role === "user") messages.push(...userMessages(message.content));
    else {
      const assistant = assistantMessage(message.content, options);
      if (assistant) messages.push(assistant);
    }
  }

  const request: ChatRequest = {
    model: params.model,
    messages: pairToolMessages(messages),
    stream: false,
  };
  if (options.maxTokensParam === "max_completion_tokens") {
    request.max_completion_tokens = params.max_tokens;
  } else {
    request.max_tokens = params.max_tokens;
  }

  const tools = (params.tools ?? []).flatMap((tool) => {
    if (!("input_schema" in tool)) return [];
    const type = (tool as { type?: string | null }).type;
    if (type && type !== "custom") return [];
    return [
      {
        type: "function" as const,
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.input_schema,
        },
      },
    ];
  });
  if (tools.length > 0) {
    request.tools = tools;
    const choice = params.tool_choice;
    if (choice?.type === "none") request.tool_choice = "none";
    else if (choice?.type === "any") request.tool_choice = "required";
    else if (choice?.type === "tool") {
      request.tool_choice = { type: "function", function: { name: choice.name } };
    } else if (choice?.type === "auto") request.tool_choice = "auto";
    if (choice && "disable_parallel_tool_use" in choice && choice.disable_parallel_tool_use) {
      request.parallel_tool_calls = false;
    }
  }

  if (format && mode === "schema") {
    request.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: format, strict: false },
    };
  } else if (format && mode === "object") {
    request.response_format = { type: "json_object" };
  }
  if (params.stop_sequences?.length) request.stop = params.stop_sequences.slice(0, 4);
  if (options.reasoningEffort && isReasoningModel(params.model)) {
    request.reasoning_effort = reasoningEffortFor(params);
  }
  return request;
}

// --- Chat Completions response -> Messages message ------------------------------------------------

function stopReason(finish: string | null | undefined, hasToolUse: boolean): BetaStopReason {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      // Some providers say "stop" even when the turn ends in tool calls.
      return hasToolUse ? "tool_use" : "end_turn";
  }
}

/** Strips the code fences a model may wrap a JSON answer in. */
export function unwrapJsonFence(value: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(value);
  return fenced?.[1] ?? value;
}

function contentText(content: NonNullable<ChatResponse["choices"]>[number]["message"]): string {
  const value = content?.content;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function usageFrom(response: ChatResponse): BetaUsage {
  return {
    input_tokens: Math.max(0, Math.trunc(response.usage?.prompt_tokens ?? 0)),
    output_tokens: Math.max(0, Math.trunc(response.usage?.completion_tokens ?? 0)),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    fallback_credit: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

export function fromChatResponse(
  response: ChatResponse,
  options: { model: string; json?: boolean },
): BetaMessage {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const content: BetaContentBlock[] = [];

  let text = contentText(message);
  let reasoning =
    (typeof message?.reasoning_content === "string" && message.reasoning_content) ||
    (typeof message?.reasoning === "string" && message.reasoning) ||
    "";
  // Open models served raw put their reasoning in <think> tags at the start of the text.
  const think = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(text);
  if (think) {
    reasoning = reasoning || (think[1] ?? "").trim();
    text = text.slice(think[0].length);
  }
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (options.json) text = unwrapJsonFence(text).trim();
  if (text) content.push({ type: "text", text, citations: null });

  // A turn cut off by the token limit may end in half-written tool arguments: keep the call with
  // `{}` input and stop_reason max_tokens (callers never run tool input from such a turn) instead of
  // throwing, so the turn's usage is still counted and the caller sees why it stopped.
  const truncated = choice?.finish_reason === "length";
  const seen = new Set<string>();
  for (const call of message?.tool_calls ?? []) {
    const name = call.function?.name ?? "";
    if (!name) continue;
    const raw = call.function?.arguments;
    let input: unknown;
    if (raw && typeof raw === "object") input = raw;
    else if (!raw || !String(raw).trim()) input = {};
    else {
      try {
        input = JSON.parse(String(raw));
      } catch {
        if (!truncated) throw new ToolInputParseError(name);
        input = {};
      }
    }
    if (input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) {
      if (!truncated) throw new ToolInputParseError(name);
      input = {};
    }
    let id = typeof call.id === "string" && call.id ? call.id : randomId("call_");
    if (seen.has(id)) id = randomId("call_");
    seen.add(id);
    const block: BetaContentBlock = { type: "tool_use", id, name, input };
    if (call.extra_content !== undefined) {
      (block as unknown as Record<string, unknown>)[EXTRA_CONTENT_KEY] = call.extra_content;
    }
    content.push(block);
  }

  const hasToolUse = content.some((block) => block.type === "tool_use");
  let stop = stopReason(choice?.finish_reason, hasToolUse);
  if (typeof message?.refusal === "string" && message.refusal && !text && !hasToolUse) {
    stop = "refusal";
  }
  return {
    id: typeof response.id === "string" && response.id ? response.id : randomId("msg_"),
    type: "message",
    role: "assistant",
    model: typeof response.model === "string" && response.model ? response.model : options.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: usageFrom(response),
  };
}

/** The raw Messages stream events for a complete message, as a streamed turn would send them. */
export function messageToStreamEvents(message: BetaMessage): BetaRawStreamEvent[] {
  const events: BetaRawStreamEvent[] = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    },
  ];
  message.content.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking, estimated_tokens: null },
      });
    } else if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
    } else {
      return;
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
      stop_details: null,
      container: null,
    },
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
    },
    context_management: null,
  });
  events.push({ type: "message_stop" });
  return events;
}

// --- HTTP -----------------------------------------------------------------------------------------

export interface OpenAICompatibleOptions {
  /** Shown in error messages, e.g. "Groq". */
  label: string;
  /** Up to and including the version path, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  thoughtSignatures?: boolean;
  /** OpenAI's own API: `reasoning_effort` for reasoning models. */
  reasoningEffort?: boolean;
  /** Default per-request timeout (60 s). */
  timeoutMs?: number;
  /** Retries for 408/409/429/5xx and connection failures (default 1). */
  maxRetries?: number;
  fetch?: typeof fetch;
}

const MAX_RESPONSE_CHARS = 8_000_000;
const MAX_RETRY_DELAY_MS = 4_000;

/** Replaces the key and anything shaped like a provider key or bearer token. */
export function redactSecrets(value: string, secrets: (string | null | undefined)[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|gsk|xai|sk-or|AIza)[-_][-_A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\bAIza[-_A-Za-z0-9]{20,}/g, "[redacted]");
}

function errorType(status: number): string {
  if (status === 400 || status === 422) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
      if (typeof record.message === "string") return record.message;
      if (typeof record.detail === "string") return record.detail;
    }
  } catch {
    // Not JSON: use the text.
  }
  return body.trim();
}

/** An Anthropic SDK error class for an HTTP failure from the provider (no secrets inside). */
export function providerError(
  status: number,
  body: string,
  responseHeaders: Headers | undefined,
  options: Pick<OpenAICompatibleOptions, "label" | "apiKey">,
): InstanceType<typeof Anthropic.APIError> {
  const message =
    redactSecrets(providerMessage(body), [options.apiKey]).slice(0, 400) || `HTTP ${status}`;
  const headers = new Headers();
  const retryAfter = responseHeaders?.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  const requestId = responseHeaders?.get("x-request-id");
  if (requestId) headers.set("request-id", requestId);
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type: errorType(status), message: `${options.label}: ${message}` } },
    undefined,
    headers,
  );
}

function retryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIUserAbortError) return false;
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    return [408, 409, 429].includes(error.status) || error.status >= 500;
  }
  return false;
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof Anthropic.APIError) {
    const header = error.headers?.get("retry-after");
    const seconds = header ? Number(header) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(500 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Anthropic.APIUserAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Anthropic.APIUserAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function headersFor(options: OpenAICompatibleOptions, json: boolean): Record<string, string> {
  return {
    accept: "application/json",
    ...(json ? { "content-type": "application/json" } : {}),
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.headers,
  };
}

function baseUrlOf(options: OpenAICompatibleOptions): string {
  return options.baseUrl.replace(/\/+$/, "");
}

/** One HTTP request with the timeout and abort mapped to the SDK's error classes. */
async function request(
  options: OpenAICompatibleOptions,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
  requestOptions: ModelRequestOptions,
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(requestOptions.timeout ?? options.timeoutMs ?? 60_000);
  const signal = requestOptions.signal
    ? AbortSignal.any([requestOptions.signal, timeout])
    : timeout;
  const failed = (cause: unknown) => {
    if (requestOptions.signal?.aborted) return new Anthropic.APIUserAbortError();
    if (timeout.aborted) {
      return new Anthropic.APIConnectionTimeoutError({
        message: `${options.label}: the request timed out`,
      });
    }
    return new Anthropic.APIConnectionError({
      message: `${options.label}: could not reach the API`,
      cause: cause instanceof Error ? cause : undefined,
    });
  };
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(`${baseUrlOf(options)}${path}`, {
      method: init.method,
      headers: headersFor(options, init.body !== undefined),
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: "error",
      signal,
    });
    text = await response.text();
  } catch (error) {
    throw failed(error);
  }
  if (!response.ok) throw providerError(response.status, text, response.headers, options);
  if (text.length > MAX_RESPONSE_CHARS) {
    throw providerError(502, "The response was too large", undefined, options);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw providerError(502, "The response was not JSON", undefined, options);
  }
  // Some gateways answer 200 with an error object and no choices.
  if (parsed && typeof parsed === "object" && "error" in parsed && !("choices" in parsed)) {
    const error = (parsed as { error: unknown }).error;
    const code =
      error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
    const status = typeof code === "number" && code >= 400 && code < 600 ? code : 502;
    throw providerError(status, text, response.headers, options);
  }
  return parsed;
}

async function withRetries<T>(
  options: OpenAICompatibleOptions,
  requestOptions: ModelRequestOptions,
  run: () => Promise<T>,
): Promise<T> {
  const maxRetries = options.maxRetries ?? 1;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= maxRetries || !retryable(error) || requestOptions.signal?.aborted) {
        throw error;
      }
      await sleep(retryDelay(error, attempt), requestOptions.signal);
    }
  }
}

function rejectsFormat(error: unknown): boolean {
  return (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.UnprocessableEntityError
  );
}

/** A ModelClient for an OpenAI-compatible Chat Completions API. */
export function createOpenAICompatibleClient(options: OpenAICompatibleOptions): ModelClient {
  /** Per model: the first JSON mode that did not get a 400. */
  const jsonModeByModel = new Map<string, number>();

  async function create(
    params: ModelStreamParams,
    requestOptions: ModelRequestOptions = {},
  ): Promise<BetaMessage> {
    const format = jsonFormat(params);
    let index = format ? (jsonModeByModel.get(params.model) ?? 0) : 0;
    for (;;) {
      const body = toChatRequest(params, {
        maxTokensParam: options.maxTokensParam,
        thoughtSignatures: options.thoughtSignatures,
        reasoningEffort: options.reasoningEffort,
        jsonMode: JSON_MODES[index],
      });
      try {
        const response = await withRetries(options, requestOptions, () =>
          request(
            options,
            "/chat/completions",
            { method: "POST", body: JSON.stringify(body) },
            requestOptions,
          ),
        );
        if (format && index > 0) jsonModeByModel.set(params.model, index);
        return fromChatResponse(response as ChatResponse, {
          model: params.model,
          json: Boolean(format),
        });
      } catch (error) {
        if (format && index < JSON_MODES.length - 1 && rejectsFormat(error)) {
          index += 1;
          continue;
        }
        throw error;
      }
    }
  }

  function stream(
    params: ModelStreamParams,
    requestOptions: ModelRequestOptions = {},
  ): ModelStream {
    let pending: Promise<BetaMessage> | undefined;
    const run = () => {
      pending ??= create(params, requestOptions);
      return pending;
    };
    return {
      async *[Symbol.asyncIterator]() {
        const message = await run();
        for (const event of messageToStreamEvents(message)) {
          if (requestOptions.signal?.aborted) throw new Anthropic.APIUserAbortError();
          yield event;
        }
      },
      finalMessage: run,
    };
  }

  return { beta: { messages: { create, stream } } };
}

/** GET <baseUrl>/models: the `data` array (or the body when it is an array). */
export async function fetchModelList(
  options: OpenAICompatibleOptions,
  requestOptions: ModelRequestOptions = {},
): Promise<unknown[]> {
  const body = await request(options, "/models", { method: "GET" }, requestOptions);
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.models)) return record.models;
  }
  return [];
}
