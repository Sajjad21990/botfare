import Anthropic from "@anthropic-ai/sdk";
import type { AgAiEvent, AgAiOutputItem, AgLlmResponse } from "ag-studio";
import { z } from "zod";

/**
 * The AG Studio assistant's model call. AG Studio's Agent Framework runs its agent loop in the
 * browser and hands each turn to an adapter as an `AgLlmRequest` (conversation items, instructions,
 * tool schemas, tool choice, response format). The browser adapter posts that request here; this
 * module validates it, translates it to an Anthropic Messages request, and translates the streamed
 * answer back into AG Studio's events (AG-UI vocabulary) and its final `AgLlmResponse`.
 * The API key never leaves the server, and the browser cannot pick the model or the token cap.
 */

export type AnthropicTurnParams = Omit<
  Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  "stream"
>;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

export const DEFAULT_MODEL = "claude-sonnet-5-5";
/** Hard cap on the answer for one turn; the browser cannot raise it. */
export const MAX_OUTPUT_TOKENS = 8192;
/**
 * Bodies larger than this are refused while reading. A first turn from AG Studio is about 19 KB
 * (13 KB of instructions, 5 KB of tool schemas); a long conversation with query results stays well
 * under this, and it caps one call at roughly 130k input tokens.
 */
export const MAX_BODY_BYTES = 512_000;

/** Longer tool results are cut to this many characters before they reach the model. */
export const MAX_TOOL_OUTPUT_CHARS = 60_000;

/**
 * Prepended to every system prompt, ahead of AG Studio's instructions, so the server's key only
 * ever runs the analytics assistant.
 */
export const ANALYTICS_SYSTEM_PROMPT = [
  "You are the analytics assistant inside the BotFare publisher dashboard, built with AG Studio.",
  "Help the publisher understand and arrange their own BotFare data: paid AI-agent requests,",
  "revenue, pages, agents, fees and payouts, and the dashboard's widgets and layout.",
  "Politely decline anything unrelated to this dashboard or its data in one short sentence.",
].join(" ");

/** Prefix of a reasoning item ID that carries an Anthropic thinking-block signature. */
const THINKING_ID_PREFIX = "thk_";

// --- Request validation -------------------------------------------------------------------------

const text = z.string().max(100_000);
const inputContent = z.union([
  z.looseObject({ type: z.literal("text"), text }),
  z.looseObject({ type: z.literal("image"), imageUrl: z.string().max(200_000).optional() }),
  z.looseObject({ type: z.literal("file") }),
]);
const outputContent = z.union([
  z.looseObject({ type: z.literal("text"), text }),
  z.looseObject({ type: z.literal("refusal"), refusal: text }),
]);

const conversationItem = z.union([
  z.looseObject({
    type: z.literal("message"),
    role: z.enum(["user", "system"]),
    content: z.array(inputContent).max(20),
  }),
  z.looseObject({
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z.array(outputContent).max(20),
  }),
  z.looseObject({
    type: z.literal("function_call"),
    callId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    arguments: z.string().max(50_000),
  }),
  z.looseObject({
    type: z.literal("function_call_output"),
    callId: z.string().min(1).max(200),
    // Query results can be long; keep the start rather than failing the whole turn.
    output: z
      .string()
      .max(MAX_BODY_BYTES)
      .transform((output) =>
        output.length > MAX_TOOL_OUTPUT_CHARS
          ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[truncated: ${output.length - MAX_TOOL_OUTPUT_CHARS} more characters]`
          : output,
      ),
  }),
  z.looseObject({
    type: z.literal("reasoning"),
    id: z.string().max(20_000),
    summary: z.array(z.looseObject({ text: z.string().max(50_000) })).max(20),
    content: z
      .array(z.looseObject({ text: z.string().max(50_000) }))
      .max(20)
      .optional(),
  }),
]);

const jsonSchema = z.record(z.string(), z.unknown());

export const aiTurnRequestSchema = z.object({
  input: z.array(conversationItem).max(200),
  instructions: z.string().max(50_000).optional(),
  tools: z
    .array(
      z.looseObject({
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
        description: z.string().max(8_000).default(""),
        parameters: jsonSchema,
        kind: z.enum(["client", "server", "provided"]).optional(),
      }),
    )
    .max(32)
    .optional(),
  toolChoice: z
    .union([z.enum(["auto", "none", "required"]), z.object({ name: z.string().min(1).max(128) })])
    .optional(),
  responseFormat: z
    .union([
      z.object({ type: z.literal("text") }),
      z.object({
        type: z.literal("json"),
        name: z.string().max(200),
        description: z.string().max(2000).optional(),
        schema: jsonSchema,
      }),
    ])
    .default({ type: "text" }),
});

export type AiTurnRequest = z.output<typeof aiTurnRequestSchema>;
type ConversationItem = AiTurnRequest["input"][number];

// --- AG Studio request -> Anthropic request -----------------------------------------------------

export interface TranslateOptions {
  model: string;
  maxTokens?: number;
  /** Send thinking blocks carried by reasoning items back unchanged (default true). */
  replayThinking?: boolean;
}

/** Tool-use IDs must match ^[a-zA-Z0-9_-]+$; Studio's own IDs may not, so map them consistently. */
function toolUseId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200) || "call";
}

/** Drops JSON Schema details the Messages API does not need (and Shape's `{ not: {} }` marker). */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      const branches = value.filter(
        (branch) =>
          !(
            branch &&
            typeof branch === "object" &&
            Object.keys(branch).length === 1 &&
            "not" in branch &&
            JSON.stringify((branch as { not: unknown }).not) === "{}"
          ),
      );
      if (branches.length === 1 && typeof branches[0] === "object") {
        Object.assign(out, cleanSchema(branches[0]));
        continue;
      }
      out[key] = branches.map(cleanSchema);
      continue;
    }
    out[key] = cleanSchema(value);
  }
  return out;
}

function toTool(tool: NonNullable<AiTurnRequest["tools"]>[number]): ToolUnion {
  const schema = cleanSchema(tool.parameters) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...schema, type: "object" } as Anthropic.Beta.Messages.BetaTool.InputSchema,
    eager_input_streaming: true,
  };
}

function parseArguments(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return {};
  }
}

function inputBlocks(
  item: Extract<ConversationItem, { role: "user" | "system" }>,
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of item.content) {
    if (part.type === "text" && part.text.trim()) blocks.push({ type: "text", text: part.text });
    if (part.type === "image" && typeof part.imageUrl === "string") {
      const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(part.imageUrl);
      if (data?.[1] && data[2]) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: data[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: data[2],
          },
        });
      } else if (/^https:\/\//.test(part.imageUrl)) {
        blocks.push({ type: "image", source: { type: "url", url: part.imageUrl } });
      }
    }
  }
  return blocks;
}

/**
 * Builds the Messages API request for one AG Studio turn.
 * - The fixed ANALYTICS_SYSTEM_PROMPT comes first; `instructions` and system messages follow it.
 * - Assistant text, tool calls and (signed) reasoning become assistant blocks; tool results become
 *   `tool_result` blocks in the following user turn. Consecutive same-role turns are merged.
 * - Every `tool_use` gets a `tool_result` (an error result if Studio sent none), and results
 *   without a matching call are dropped, so the request is always well-formed.
 * - Forced tool choice (`required` / a named tool) is not available on current models, so it is
 *   asked for in the system prompt with `tool_choice: auto`; JSON output likewise.
 */
export function toAnthropicParams(
  request: AiTurnRequest,
  options: TranslateOptions,
): AnthropicTurnParams {
  const replayThinking = options.replayThinking ?? true;
  const system: string[] = [ANALYTICS_SYSTEM_PROMPT];
  if (request.instructions?.trim()) system.push(request.instructions.trim());

  const turns: { role: "user" | "assistant"; content: ContentBlockParam[] }[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };

  for (const item of request.input) {
    switch (item.type) {
      case "message":
        if (item.role === "system") {
          const note = inputBlocks(item)
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n")
            .trim();
          if (note) system.push(note);
        } else if (item.role === "user") {
          push("user", inputBlocks(item));
        } else {
          push(
            "assistant",
            item.content
              .map((part) => String(part.type === "text" ? part.text : part.refusal))
              .filter((value) => value.trim())
              .map((value) => ({ type: "text" as const, text: value })),
          );
        }
        break;
      case "reasoning":
        if (replayThinking && item.id.startsWith(THINKING_ID_PREFIX)) {
          const thinking = (item.content ?? item.summary).map((part) => part.text).join("");
          push("assistant", [
            { type: "thinking", thinking, signature: item.id.slice(THINKING_ID_PREFIX.length) },
          ]);
        }
        break;
      case "function_call":
        push("assistant", [
          {
            type: "tool_use",
            id: toolUseId(item.callId),
            name: item.name,
            input: parseArguments(item.arguments),
          },
        ]);
        break;
      case "function_call_output":
        push("user", [
          {
            type: "tool_result",
            tool_use_id: toolUseId(item.callId),
            content: item.output || "(empty)",
          },
        ]);
        break;
    }
  }

  // Pair every tool_use with a tool_result in the very next user turn, results first.
  const messages: MessageParam[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!turn) continue;
    if (turn.role === "assistant") {
      // A thinking block may not end a turn on its own; drop assistant turns with nothing else.
      if (!turn.content.some((block) => block.type !== "thinking")) continue;
      messages.push({ role: "assistant", content: turn.content });
      const calls = turn.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
      if (calls.length === 0) continue;
      const next = turns[i + 1]?.role === "user" ? turns[i + 1] : undefined;
      const results = new Map<string, ContentBlockParam>();
      const rest: ContentBlockParam[] = [];
      for (const block of next?.content ?? []) {
        if (block.type === "tool_result" && calls.includes(block.tool_use_id))
          results.set(block.tool_use_id, block);
        else if (block.type !== "tool_result") rest.push(block);
      }
      const paired: ContentBlockParam[] = calls.map(
        (id) =>
          results.get(id) ?? {
            type: "tool_result",
            tool_use_id: id,
            content: "No result was recorded for this call.",
            is_error: true,
          },
      );
      messages.push({ role: "user", content: [...paired, ...rest] });
      if (next) i += 1;
    } else {
      const content = turn.content.filter((block) => block.type !== "tool_result");
      if (content.length) messages.push({ role: "user", content });
    }
  }
  // Merge user turns that ended up adjacent, start with a user turn, and never end on the
  // assistant (current models do not accept prefill).
  const merged: MessageParam[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (
      last &&
      last.role === message.role &&
      Array.isArray(last.content) &&
      Array.isArray(message.content)
    ) {
      last.content = [...last.content, ...message.content];
    } else merged.push(message);
  }
  if (merged[0]?.role !== "user")
    merged.unshift({ role: "user", content: "(The conversation continues.)" });
  if (merged.at(-1)?.role === "assistant") merged.push({ role: "user", content: "Continue." });

  const tools = (request.tools ?? []).filter((tool) => tool.kind !== "provided").map(toTool);
  const choice = request.toolChoice;
  if (tools.length && choice === "required") {
    system.push("For this turn you must call at least one of the available tools.");
  } else if (tools.length && choice && typeof choice === "object") {
    system.push(`For this turn you must call the tool \`${choice.name}\`.`);
  }
  if (request.responseFormat.type === "json") {
    const format = request.responseFormat;
    system.push(
      [
        `Reply with only a JSON value named "${format.name}"${format.description ? ` (${format.description})` : ""}.`,
        "No prose and no code fences. It must match this JSON Schema:",
        JSON.stringify(cleanSchema(format.schema)),
      ].join("\n"),
    );
  }

  const params: AnthropicTurnParams = {
    model: options.model,
    max_tokens: Math.min(options.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    messages: merged,
    cache_control: { type: "ephemeral" },
    ...thinkingFor(options.model),
  };
  params.system = system.join("\n\n");
  if (tools.length) {
    params.tools = tools;
    params.tool_choice = choice === "none" ? { type: "none" } : { type: "auto" };
  }
  if (supportsServerFallback(options.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

/** Sonnet 5.5's lowest thinking setting keeps an interactive assistant quick. */
function thinkingFor(
  model: string,
): Partial<Pick<AnthropicTurnParams, "thinking" | "output_config">> {
  if (model.startsWith("claude-sonnet-5-5")) {
    return { thinking: { type: "between_tools" }, output_config: { effort: "medium" } };
  }
  if (model.startsWith("claude-haiku-4") || model.startsWith("claude-3")) return {};
  return { output_config: { effort: "medium" } };
}

/** Models that take the server-side refusal fallback (`fallbacks: "default"`). */
function supportsServerFallback(model: string): boolean {
  return ["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1"].some(
    (prefix) => model === prefix,
  );
}

// --- Anthropic response -> AG Studio ------------------------------------------------------------

/** Strips the code fences a model may wrap JSON in. */
export function unwrapJson(value: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(value);
  return fenced?.[1] ?? value.trim();
}

function blockId(messageId: string, index: number): string {
  return `${messageId}_${index}`;
}

/** The final `AgLlmResponse` for a complete Anthropic message. */
export function fromAnthropicMessage(
  message: Anthropic.Beta.Messages.BetaMessage,
  options: { json?: boolean } = {},
): AgLlmResponse {
  const output: AgAiOutputItem[] = [];
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      const value = options.json ? unwrapJson(block.text) : block.text;
      if (!value) return;
      output.push({
        id: blockId(message.id, index),
        kind: "output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text: value, annotations: [] }],
      });
    } else if (block.type === "tool_use") {
      output.push({
        id: block.id,
        kind: "output",
        type: "function_call",
        callId: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
        status: "completed",
      });
    } else if (block.type === "thinking" && block.signature) {
      output.push({
        id: `${THINKING_ID_PREFIX}${block.signature}`,
        kind: "output",
        type: "reasoning",
        summary: block.thinking ? [{ type: "summary", text: block.thinking }] : [],
        content: block.thinking ? [{ type: "text", text: block.thinking }] : [],
      });
    }
  });

  if (message.stop_reason === "refusal") {
    output.push({
      id: blockId(message.id, message.content.length),
      kind: "output",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "I can't help with that request." }],
    });
  }

  const usage = message.usage;
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cached + written;
  return {
    id: message.id,
    createdAt: Date.now(),
    model: message.model,
    status: message.stop_reason === "max_tokens" ? "incomplete" : "completed",
    incompleteDetails:
      message.stop_reason === "max_tokens" ? { reason: "max_output_tokens" } : undefined,
    output,
    usage: {
      inputTokens,
      outputTokens: usage.output_tokens,
      totalTokens: inputTokens + usage.output_tokens,
      cachedInputTokens: cached || undefined,
      cacheWriteTokens: written || undefined,
    },
  };
}

/**
 * Translates the Messages stream into AG Studio content events. Text and tool calls stream as they
 * arrive; a thinking block is sent whole when it closes, because its ID carries the signature that
 * lets the next turn send it back unchanged.
 */
export class StreamTranslator {
  private messageId = "msg";
  private readonly open = new Map<
    number,
    {
      kind: "text" | "tool" | "thinking";
      id: string;
      thinking?: string;
      signature?: string;
    }
  >();

  constructor(private readonly options: { json?: boolean } = {}) {}

  translate(event: Anthropic.Beta.Messages.BetaRawMessageStreamEvent): AgAiEvent[] {
    switch (event.type) {
      case "message_start":
        this.messageId = event.message.id;
        return [];
      case "content_block_start": {
        const block = event.content_block;
        const id = blockId(this.messageId, event.index);
        if (block.type === "text") {
          this.open.set(event.index, { kind: "text", id });
          // JSON answers are sent whole at the end (fences stripped), not streamed.
          if (this.options.json) return [];
          const events: AgAiEvent[] = [
            { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
          ];
          if (block.text)
            events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: block.text });
          return events;
        }
        if (block.type === "tool_use") {
          this.open.set(event.index, { kind: "tool", id: block.id });
          return [{ type: "TOOL_CALL_START", toolCallId: block.id, toolCallName: block.name }];
        }
        if (block.type === "thinking") {
          this.open.set(event.index, {
            kind: "thinking",
            id,
            thinking: block.thinking ?? "",
            signature: block.signature ?? "",
          });
        }
        return [];
      }
      case "content_block_delta": {
        const open = this.open.get(event.index);
        if (!open) return [];
        const delta = event.delta;
        if (delta.type === "text_delta" && open.kind === "text") {
          if (this.options.json) {
            open.thinking = (open.thinking ?? "") + delta.text;
            return [];
          }
          return delta.text
            ? [{ type: "TEXT_MESSAGE_CONTENT", messageId: open.id, delta: delta.text }]
            : [];
        }
        if (delta.type === "input_json_delta" && open.kind === "tool") {
          return delta.partial_json
            ? [{ type: "TOOL_CALL_ARGS", toolCallId: open.id, delta: delta.partial_json }]
            : [];
        }
        if (delta.type === "thinking_delta" && open.kind === "thinking") {
          open.thinking = (open.thinking ?? "") + delta.thinking;
        }
        if (delta.type === "signature_delta" && open.kind === "thinking") {
          open.signature = (open.signature ?? "") + delta.signature;
        }
        return [];
      }
      case "content_block_stop": {
        const open = this.open.get(event.index);
        this.open.delete(event.index);
        if (!open) return [];
        if (open.kind === "text") {
          if (!this.options.json) return [{ type: "TEXT_MESSAGE_END", messageId: open.id }];
          const value = unwrapJson(open.thinking ?? "");
          return value
            ? [
                { type: "TEXT_MESSAGE_START", messageId: open.id, role: "assistant" },
                { type: "TEXT_MESSAGE_CONTENT", messageId: open.id, delta: value },
                { type: "TEXT_MESSAGE_END", messageId: open.id },
              ]
            : [];
        }
        if (open.kind === "tool") return [{ type: "TOOL_CALL_END", toolCallId: open.id }];
        if (!open.signature || !open.thinking) return [];
        const id = `${THINKING_ID_PREFIX}${open.signature}`;
        return [
          { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" },
          { type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: open.thinking },
          { type: "REASONING_MESSAGE_END", messageId: id },
        ];
      }
      default:
        return [];
    }
  }
}

// --- Running a turn -----------------------------------------------------------------------------

/** One line of the NDJSON stream the route sends the browser adapter. */
export type AiStreamLine =
  | { event: AgAiEvent }
  | { complete: AgLlmResponse }
  | { error: { code: string; message: string } };

export function anthropicConfig(): { apiKey: string; model: string } | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL };
}

/** True when the API rejected replayed thinking blocks (stale signature, edited history). */
function isThinkingRejection(error: unknown): boolean {
  return error instanceof Anthropic.BadRequestError && /thinking|signature/i.test(error.message);
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof Anthropic.AuthenticationError) {
    return { code: "ai_auth", message: "The Anthropic API key was rejected." };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { code: "ai_rate_limited", message: "The AI assistant is busy. Try again in a moment." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { code: "ai_bad_request", message: "The assistant could not process this request." };
  }
  if (error instanceof Anthropic.APIError) {
    return { code: "ai_upstream", message: "The AI service is unavailable. Try again shortly." };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "ai_cancelled", message: "Cancelled." };
  }
  return { code: "ai_error", message: "The assistant failed unexpectedly." };
}

/**
 * Runs one turn and yields NDJSON lines: content events as they stream, then the final response.
 * If the API rejects replayed thinking blocks before anything streamed, the turn is retried once
 * without them.
 */
export async function* runAiTurn(
  client: Anthropic,
  request: AiTurnRequest,
  options: { model: string; signal?: AbortSignal },
): AsyncGenerator<AiStreamLine> {
  const json = request.responseFormat.type === "json";
  for (const replayThinking of [true, false]) {
    const params = toAnthropicParams(request, { model: options.model, replayThinking });
    const translator = new StreamTranslator({ json });
    let streamed = false;
    try {
      const stream = client.beta.messages.stream(params, { signal: options.signal });
      for await (const event of stream) {
        for (const agEvent of translator.translate(event)) {
          streamed = true;
          yield { event: agEvent };
        }
      }
      yield { complete: fromAnthropicMessage(await stream.finalMessage(), { json }) };
      return;
    } catch (error) {
      if (replayThinking && !streamed && isThinkingRejection(error)) continue;
      console.error(
        "[analytics-ai] turn failed",
        describeError(error).code,
        (error as Error)?.message,
      );
      yield { error: describeError(error) };
      return;
    }
  }
}
