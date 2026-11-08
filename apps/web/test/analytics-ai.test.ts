import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  aiTurnRequestSchema,
  cleanSchema,
  fromAnthropicMessage,
  StreamTranslator,
  toAnthropicParams,
  unwrapJson,
} from "../src/lib/server/analytics-ai";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type StreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;

const MODEL = "claude-sonnet-5-5";

/** A turn as AG Studio's Agent Framework hands it to the adapter, mid tool loop. */
const studioTurn = {
  instructions: "You build dashboards for a publisher.",
  input: [
    {
      id: "u1",
      kind: "input",
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "text", text: "Which pages earn the most?" }],
    },
    {
      id: "thk_sig-abc",
      kind: "output",
      type: "reasoning",
      summary: [{ type: "summary", text: "Checking the schema first." }],
      content: [{ type: "text", text: "Checking the schema first." }],
    },
    {
      id: "toolu_1",
      kind: "output",
      type: "function_call",
      callId: "toolu_1",
      name: "execute_query",
      arguments: '{"fields":["receipts.path"]}',
      status: "completed",
    },
    {
      kind: "input",
      type: "function_call_output",
      callId: "toolu_1",
      output: "path,earnings\n/articles/grinders,0.57",
      status: "completed",
    },
  ],
  tools: [
    {
      name: "execute_query",
      description: "Run a query",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { limit: { anyOf: [{ type: "number" }, { not: {} }] } },
        required: [],
      },
      kind: "client",
    },
    { name: "web_search", description: "hosted", parameters: {}, kind: "provided" },
  ],
  toolChoice: "required",
  responseFormat: { type: "text" },
};

describe("AG Studio request -> Anthropic Messages request", () => {
  it("translates a mid-loop turn: system, thinking, tool_use, tool_result, tools", () => {
    const request = aiTurnRequestSchema.parse(studioTurn);
    const params = toAnthropicParams(request, { model: MODEL });

    expect(params.model).toBe(MODEL);
    expect(params.max_tokens).toBe(8192);
    expect(params.thinking).toEqual({ type: "between_tools" });
    expect(params.system).toContain("You build dashboards for a publisher.");
    expect(params.system).toContain("must call at least one of the available tools");
    // Forced tool choice is not available on current models: auto plus an instruction.
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Which pages earn the most?" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking the schema first.", signature: "sig-abc" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "execute_query",
            input: { fields: ["receipts.path"] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "path,earnings\n/articles/grinders,0.57",
          },
        ],
      },
    ]);
    // Provider-hosted tools are skipped; schemas lose $schema and Shape's undefined marker.
    expect(params.tools).toEqual([
      {
        name: "execute_query",
        description: "Run a query",
        input_schema: { type: "object", properties: { limit: { type: "number" } }, required: [] },
        eager_input_streaming: true,
      },
    ]);
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.fallbacks).toBe("default");
  });

  it("can leave thinking blocks out (retry after the API rejects them)", () => {
    const params = toAnthropicParams(aiTurnRequestSchema.parse(studioTurn), {
      model: MODEL,
      replayThinking: false,
    });
    const assistant = params.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(JSON.stringify(assistant)).not.toContain("thinking");
  });

  it("repairs a broken history: missing results, orphan results, trailing assistant", () => {
    const request = aiTurnRequestSchema.parse({
      input: [
        { type: "function_call_output", callId: "orphan", output: "x" },
        { type: "message", role: "user", content: [{ type: "text", text: "Hi" }] },
        { type: "function_call", callId: "call:1", name: "view_schema", arguments: "" },
        { type: "message", role: "assistant", content: [{ type: "text", text: "Done." }] },
      ],
      responseFormat: { type: "text" },
    });
    const params = toAnthropicParams(request, { model: "claude-opus-5-5" });
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "view_schema", input: {} },
          { type: "text", text: "Done." },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "No result was recorded for this call.",
            is_error: true,
          },
        ],
      },
    ]);
  });

  it("asks for JSON in the system prompt and folds system messages in", () => {
    const request = aiTurnRequestSchema.parse({
      input: [
        { type: "message", role: "system", content: [{ type: "text", text: "Page: overview" }] },
        { type: "message", role: "user", content: [{ type: "text", text: "Plan it" }] },
      ],
      toolChoice: { name: "add_widget" },
      tools: [{ name: "add_widget", description: "", parameters: { type: "object" } }],
      responseFormat: { type: "json", name: "plan", schema: { type: "object" } },
    });
    const params = toAnthropicParams(request, { model: MODEL });
    expect(params.system).toContain("Page: overview");
    expect(params.system).toContain("call the tool `add_widget`");
    expect(params.system).toContain('Reply with only a JSON value named "plan"');
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Plan it" }] },
    ]);
  });

  it("rejects malformed requests and bad tool names", () => {
    expect(aiTurnRequestSchema.safeParse({ input: "nope" }).success).toBe(false);
    expect(
      aiTurnRequestSchema.safeParse({
        input: [],
        tools: [{ name: "bad name!", description: "", parameters: {} }],
      }).success,
    ).toBe(false);
  });

  it("cleanSchema drops $schema and Shape's undefined sentinel", () => {
    expect(
      cleanSchema({ $schema: "x", anyOf: [{ type: "string" }, { not: {} }], description: "d" }),
    ).toEqual({ type: "string", description: "d" });
  });
});

describe("Anthropic response -> AG Studio", () => {
  const message: BetaMessage = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [
      { type: "thinking", thinking: "Looking at pages.", signature: "sig-1" },
      { type: "text", text: "Top page: /articles/grinders.", citations: null },
      { type: "tool_use", id: "toolu_2", name: "add_widget", input: { type: "bar" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
  } as unknown as BetaMessage;

  it("maps text, tool calls, signed thinking and usage", () => {
    const response = fromAnthropicMessage(message);
    expect(response).toMatchObject({ id: "msg_1", model: MODEL, status: "completed" });
    expect(response.output).toEqual([
      {
        id: "thk_sig-1",
        kind: "output",
        type: "reasoning",
        summary: [{ type: "summary", text: "Looking at pages." }],
        content: [{ type: "text", text: "Looking at pages." }],
      },
      {
        id: "msg_1_1",
        kind: "output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text: "Top page: /articles/grinders.", annotations: [] }],
      },
      {
        id: "toolu_2",
        kind: "output",
        type: "function_call",
        callId: "toolu_2",
        name: "add_widget",
        arguments: '{"type":"bar"}',
        status: "completed",
      },
    ]);
    expect(response.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      cachedInputTokens: 50,
    });
  });

  it("marks max_tokens as incomplete and unwraps fenced JSON", () => {
    const truncated = { ...message, stop_reason: "max_tokens" } as BetaMessage;
    expect(fromAnthropicMessage(truncated)).toMatchObject({
      status: "incomplete",
      incompleteDetails: { reason: "max_output_tokens" },
    });
    expect(unwrapJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("streams text and tool calls as AG-UI events; thinking arrives whole with its signature", () => {
    const translator = new StreamTranslator();
    const events: StreamEvent[] = [
      { type: "message_start", message: { ...message, content: [] } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Hmm." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-9" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "", citations: null },
      },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_3", name: "view_schema", input: {} },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"a":' },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "1}" },
      },
      { type: "content_block_stop", index: 2 },
    ] as unknown as StreamEvent[];
    expect(events.flatMap((event) => translator.translate(event))).toEqual([
      { type: "REASONING_MESSAGE_START", messageId: "thk_sig-9", role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "thk_sig-9", delta: "Hmm." },
      { type: "REASONING_MESSAGE_END", messageId: "thk_sig-9" },
      { type: "TEXT_MESSAGE_START", messageId: "msg_1_1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1_1", delta: "Hello" },
      { type: "TEXT_MESSAGE_END", messageId: "msg_1_1" },
      { type: "TOOL_CALL_START", toolCallId: "toolu_3", toolCallName: "view_schema" },
      { type: "TOOL_CALL_ARGS", toolCallId: "toolu_3", delta: '{"a":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "toolu_3", delta: "1}" },
      { type: "TOOL_CALL_END", toolCallId: "toolu_3" },
    ]);
  });

  it("holds JSON answers until the block ends, then sends them unfenced", () => {
    const translator = new StreamTranslator({ json: true });
    const events = [
      { type: "message_start", message: { ...message, content: [] } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: '```json\n{"ok":' },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "true}\n```" } },
      { type: "content_block_stop", index: 0 },
    ] as unknown as StreamEvent[];
    expect(events.flatMap((event) => translator.translate(event))).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "msg_1_0", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1_0", delta: '{"ok":true}' },
      { type: "TEXT_MESSAGE_END", messageId: "msg_1_0" },
    ]);
  });
});
