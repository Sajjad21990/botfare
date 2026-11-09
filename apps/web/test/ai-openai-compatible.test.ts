import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { BetaRawStreamEvent, ModelCreateParams } from "../src/lib/server/ai/model-client";
import {
  createOpenAICompatibleClient,
  GEMINI_SKIP_SIGNATURE,
  isReasoningModel,
  isToolCallRejection,
  type OpenAICompatibleOptions,
  rateLimitHintMs,
  ToolInputParseError,
  toChatRequest,
} from "../src/lib/server/ai/openai-compatible";
import { StreamTranslator } from "../src/lib/server/analytics-ai";
import { runResearch } from "../src/lib/server/research-agent";
import type { ResearchEvent } from "../src/lib/server/research-events";
import { fakeAgents, fakeDeps, URLS } from "./research-fakes";

vi.mock("server-only", () => ({}));

const KEY = "sk-test-secret-key-0123456789abcdef";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fake fetch answering each request with the next reply (a body, a Response, or an error). */
function fakeFetch(replies: (unknown | Response | Error)[]) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const reply = replies[seen.length - 1];
    if (reply === undefined) throw new Error(`no reply scripted for request ${seen.length}`);
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return Response.json(reply);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

function client(fetch: typeof globalThis.fetch, options: Partial<OpenAICompatibleOptions> = {}) {
  return createOpenAICompatibleClient({
    label: "TestAI",
    baseUrl: "https://ai.example/v1/",
    apiKey: KEY,
    fetch,
    maxRetries: 0,
    ...options,
  });
}

function chat(
  message: Record<string, unknown>,
  finish = "stop",
  usage = { prompt_tokens: 120, completion_tokens: 30 },
) {
  return {
    id: "chatcmpl_1",
    model: "test-model",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }],
    usage,
  };
}

const BASE: ModelCreateParams = {
  model: "test-model",
  max_tokens: 500,
  messages: [{ role: "user", content: "Hi" }],
};

describe("Messages request -> Chat Completions request", () => {
  it("translates system, tools, tool choice and a tool-use history in order", () => {
    const request = toChatRequest(
      {
        model: "m",
        max_tokens: 800,
        system: [
          { type: "text", text: "You are a test." },
          { type: "text", text: "Be brief." },
        ],
        tools: [
          {
            name: "buy",
            description: "Buy a page",
            input_schema: { type: "object", properties: { url: { type: "string" } } },
            eager_input_streaming: true,
          },
          { type: "web_search_20250305", name: "web_search" },
        ],
        tool_choice: { type: "any" },
        thinking: { type: "adaptive" },
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        messages: [
          { role: "user", content: "Find a grinder" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "sig" },
              { type: "text", text: "Looking." },
              { type: "tool_use", id: "c1", name: "buy", input: { url: "a" } },
              { type: "tool_use", id: "c2", name: "buy", input: { url: "b" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' },
              { type: "text", text: "Remaining budget: 5¢." },
              {
                type: "tool_result",
                tool_use_id: "c2",
                content: [{ type: "text", text: "refused" }],
                is_error: true,
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c3", name: "buy", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      } as ModelCreateParams,
      { maxTokensParam: "max_completion_tokens" },
    );

    expect(request).toEqual({
      model: "m",
      max_completion_tokens: 800,
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "buy",
            description: "Buy a page",
            parameters: { type: "object", properties: { url: { type: "string" } } },
          },
        },
      ],
      tool_choice: "required",
      messages: [
        { role: "system", content: "You are a test.\n\nBe brief." },
        { role: "user", content: "Find a grinder" },
        {
          role: "assistant",
          content: "Looking.",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "buy", arguments: '{"url":"a"}' } },
            { id: "c2", type: "function", function: { name: "buy", arguments: '{"url":"b"}' } },
          ],
        },
        // Tool results first (providers want them right after the call), in their order...
        { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
        { role: "tool", tool_call_id: "c2", content: "Error: refused" },
        // ...then the turn's other text as a user message.
        { role: "user", content: "Remaining budget: 5¢." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c3", type: "function", function: { name: "buy", arguments: "{}" } }],
        },
        // A call the history never answered gets a placeholder result.
        {
          role: "tool",
          tool_call_id: "c3",
          content: "Error: no result was recorded for this call.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
  });

  it("maps every tool choice and uses max_tokens by default", () => {
    const tools = [{ name: "t", input_schema: { type: "object" as const } }];
    const choice = (tool_choice: ModelCreateParams["tool_choice"]) =>
      toChatRequest({ ...BASE, tools, tool_choice }).tool_choice;
    expect(choice({ type: "auto" })).toBe("auto");
    expect(choice({ type: "none" })).toBe("none");
    expect(choice({ type: "any" })).toBe("required");
    expect(choice({ type: "tool", name: "t" })).toEqual({
      type: "function",
      function: { name: "t" },
    });
    expect(toChatRequest(BASE)).toMatchObject({ max_tokens: 500 });
    expect(toChatRequest(BASE)).not.toHaveProperty("tools");
  });

  it("asks for JSON natively, as json_object, or in the prompt", () => {
    const schema = { type: "object", properties: { decision: { type: "string" } } };
    const params: ModelCreateParams = {
      ...BASE,
      system: "Judge.",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    };
    expect(toChatRequest(params, { jsonMode: "schema" })).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "response", schema, strict: false },
      },
      messages: [{ role: "system", content: "Judge." }, { role: "user" }],
    });
    const object = toChatRequest(params, { jsonMode: "object" });
    expect(object.response_format).toEqual({ type: "json_object" });
    expect(object.messages[0]?.content).toContain(JSON.stringify(schema));
    const prompt = toChatRequest(params, { jsonMode: "prompt" });
    expect(prompt).not.toHaveProperty("response_format");
    expect(prompt.messages[0]?.content).toContain("Reply with only a JSON object");
  });

  it("sends reasoning_effort to OpenAI reasoning models only (low unless effort says more)", () => {
    for (const id of ["gpt-5-mini", "gpt-5", "gpt-5.1", "o1", "o3-mini", "o4-mini"]) {
      expect(isReasoningModel(id), id).toBe(true);
    }
    for (const id of ["gpt-4.1-mini", "gpt-4o-mini", "gpt-5-chat-latest", "llama-3.3-70b"]) {
      expect(isReasoningModel(id), id).toBe(false);
    }
    const on = { reasoningEffort: true, maxTokensParam: "max_completion_tokens" as const };
    const effort = (model: string, output_config?: ModelCreateParams["output_config"]) =>
      toChatRequest({ ...BASE, model, ...(output_config ? { output_config } : {}) }, on)
        .reasoning_effort;
    expect(effort("gpt-5-mini")).toBe("low");
    expect(effort("gpt-5-mini", { effort: "low" })).toBe("low");
    expect(effort("o4-mini", { effort: "medium" })).toBe("medium");
    expect(effort("gpt-5", { effort: "high" })).toBe("high");
    expect(effort("gpt-5", { effort: "max" })).toBe("high");
    expect(effort("gpt-4.1-mini", { effort: "high" })).toBeUndefined();
    // Other providers (no reasoningEffort option) never get it, whatever the model id.
    const groq = toChatRequest({ ...BASE, model: "gpt-5-mini", output_config: { effort: "high" } });
    expect(groq).not.toHaveProperty("reasoning_effort");
  });

  it("puts reasoning_effort on the wire for the OpenAI client", async () => {
    const { fetch, seen } = fakeFetch([chat({ content: "ok" }), chat({ content: "ok" })]);
    const openai = client(fetch, {
      reasoningEffort: true,
      maxTokensParam: "max_completion_tokens",
    });
    await openai.beta.messages.create({ ...BASE, model: "gpt-5-mini" });
    expect(seen[0]?.body).toMatchObject({
      model: "gpt-5-mini",
      max_completion_tokens: 500,
      reasoning_effort: "low",
    });
    await client(fetch).beta.messages.create({ ...BASE, model: "gpt-5-mini" });
    expect(seen[1]?.body).not.toHaveProperty("reasoning_effort");
  });
});

describe("Chat Completions response -> Messages message", () => {
  it("returns text, reasoning, tool calls, the stop reason and usage", async () => {
    const { fetch, seen } = fakeFetch([
      chat(
        {
          content: "Buying now.",
          reasoning_content: "The grinder page answers it.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "buy", arguments: '{"url":"https://a.test"}' },
            },
            { type: "function", function: { name: "skip", arguments: "" } },
          ],
        },
        "tool_calls",
      ),
    ]);
    const message = await client(fetch).beta.messages.create(BASE);
    expect(seen[0]?.url).toBe("https://ai.example/v1/chat/completions");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(message).toMatchObject({
      id: "chatcmpl_1",
      type: "message",
      role: "assistant",
      model: "test-model",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [
        { type: "thinking", thinking: "The grinder page answers it.", signature: "" },
        { type: "text", text: "Buying now." },
        { type: "tool_use", id: "call_1", name: "buy", input: { url: "https://a.test" } },
        { type: "tool_use", name: "skip", input: {} },
      ],
    });
    const generated = message.content[3];
    expect(generated?.type === "tool_use" && generated.id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it("maps finish reasons, and reads <think> tags and `reasoning`", async () => {
    const stop = async (finish: string, extra: Record<string, unknown> = {}) =>
      (
        await client(
          fakeFetch([chat({ content: "x", ...extra }, finish)]).fetch,
        ).beta.messages.create(BASE)
      ).stop_reason;
    expect(await stop("stop")).toBe("end_turn");
    expect(await stop("length")).toBe("max_tokens");
    expect(await stop("content_filter")).toBe("refusal");
    expect(await stop("tool_calls")).toBe("tool_use");
    // Some providers say "stop" for a turn that ends in tool calls.
    expect(
      await stop("stop", {
        tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: "{}" } }],
      }),
    ).toBe("tool_use");

    const tagged = await client(
      fakeFetch([chat({ content: "<think>Weighing it.</think>\n\nAnswer.", reasoning: null })])
        .fetch,
    ).beta.messages.create(BASE);
    expect(tagged.content).toMatchObject([
      { type: "thinking", thinking: "Weighing it." },
      { type: "text", text: "Answer." },
    ]);
    const openrouter = await client(
      fakeFetch([chat({ content: "A", reasoning: "R" })]).fetch,
    ).beta.messages.create(BASE);
    expect(openrouter.content).toMatchObject([
      { type: "thinking", thinking: "R" },
      { type: "text", text: "A" },
    ]);
  });

  it("throws a non-API error for tool arguments that are not JSON (so the turn is re-issued)", async () => {
    const { fetch } = fakeFetch([
      chat({ tool_calls: [{ id: "a", function: { name: "buy", arguments: '{"url": "x' } }] }),
    ]);
    const error = await client(fetch)
      .beta.messages.create(BASE)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ToolInputParseError);
    expect(error).not.toBeInstanceOf(Anthropic.APIError);
  });

  it("returns a max_tokens turn with truncated tool arguments as `{}` input and its usage", async () => {
    const { fetch } = fakeFetch([
      chat(
        {
          content: "Buying.",
          tool_calls: [
            { id: "a", function: { name: "skip", arguments: '{"url":"https://a.test"}' } },
            { id: "b", function: { name: "buy", arguments: '{"url": "https://b.te' } },
            { id: "c", function: { name: "buy", arguments: "[1, 2]" } },
          ],
        },
        "length",
        { prompt_tokens: 900, completion_tokens: 8000 },
      ),
    ]);
    const message = await client(fetch).beta.messages.create(BASE);
    expect(message).toMatchObject({
      stop_reason: "max_tokens",
      usage: { input_tokens: 900, output_tokens: 8000 },
      content: [
        { type: "text", text: "Buying." },
        { type: "tool_use", id: "a", name: "skip", input: { url: "https://a.test" } },
        { type: "tool_use", id: "b", name: "buy", input: {} },
        { type: "tool_use", id: "c", name: "buy", input: {} },
      ],
    });
  });

  it("echoes Gemini thought signatures, with a placeholder when none was kept", async () => {
    const signature = { google: { thought_signature: "sig_123" } };
    const { fetch, seen } = fakeFetch([
      chat({
        tool_calls: [
          {
            id: "a",
            function: { name: "list_sources", arguments: "{}" },
            extra_content: signature,
          },
        ],
      }),
      chat({ content: "done" }),
    ]);
    const gemini = client(fetch, { thoughtSignatures: true });
    const first = await gemini.beta.messages.create(BASE);
    await gemini.beta.messages.create({
      ...BASE,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "{}" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "b", name: "t", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "{}" }] },
      ],
    });
    const messages = seen[1]?.body.messages as { tool_calls?: { extra_content?: unknown }[] }[];
    expect(messages[1]?.tool_calls?.[0]?.extra_content).toEqual(signature);
    expect(messages[3]?.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: GEMINI_SKIP_SIGNATURE },
    });
  });
});

describe("JSON-schema output", () => {
  const schema = { type: "object", properties: { decision: { type: "string" } } };
  const params: ModelCreateParams = {
    ...BASE,
    system: "Judge.",
    output_config: { format: { type: "json_schema", schema } },
  };
  const rejected = () =>
    new Response(JSON.stringify({ error: { message: "response_format is not supported" } }), {
      status: 400,
    });

  it("falls back to json_object, then to the prompt, on a 400, and remembers what worked", async () => {
    const { fetch, seen } = fakeFetch([
      rejected(),
      rejected(),
      chat({ content: '```json\n{"decision":"refund"}\n```' }),
      chat({ content: '{"decision":"deny"}' }),
    ]);
    const judge = client(fetch);
    const message = await judge.beta.messages.create(params);
    expect(seen.map((s) => (s.body.response_format as { type: string } | undefined)?.type)).toEqual(
      ["json_schema", "json_object", undefined],
    );
    expect(
      String((seen[2]?.body.messages as { content: string }[] | undefined)?.[0]?.content),
    ).toContain(JSON.stringify(schema));
    // Code fences are stripped from a JSON answer.
    expect(message.content).toEqual([
      { type: "text", text: '{"decision":"refund"}', citations: null },
    ]);

    await judge.beta.messages.create(params);
    expect(seen).toHaveLength(4);
    expect(seen[3]?.body).not.toHaveProperty("response_format");
  });

  it("does not retry a 400 when no JSON format was asked for", async () => {
    const { fetch, seen } = fakeFetch([rejected()]);
    await expect(client(fetch).beta.messages.create(BASE)).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
    expect(seen).toHaveLength(1);
  });
});

describe("errors", () => {
  const status = (code: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: code, headers });

  it("become the Anthropic SDK's error classes, without the key", async () => {
    const cases: [number, unknown][] = [
      [401, { error: { message: `Incorrect API key provided: ${KEY}` } }],
      [429, [{ error: { message: "Quota exceeded", code: 429 } }]],
      [404, { error: "model not found" }],
      [503, { message: "overloaded" }],
    ];
    const errors: unknown[] = [];
    for (const [code, body] of cases) {
      const { fetch } = fakeFetch([status(code, body)]);
      errors.push(
        await client(fetch)
          .beta.messages.create(BASE)
          .then(
            () => null,
            (e) => e,
          ),
      );
    }
    expect(errors[0]).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(errors[1]).toBeInstanceOf(Anthropic.RateLimitError);
    expect(errors[2]).toBeInstanceOf(Anthropic.NotFoundError);
    expect(errors[3]).toBeInstanceOf(Anthropic.InternalServerError);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Anthropic.APIError);
      expect(String((error as Error).message)).not.toContain(KEY);
      expect(String((error as Error).message)).toContain("TestAI");
    }
    expect((errors[0] as Error).message).toContain("[redacted]");
    expect((errors[1] as Error).message).toContain("Quota exceeded");
  });

  it("retries a 429 once, honouring Retry-After", async () => {
    const { fetch, seen } = fakeFetch([
      status(429, { error: { message: "slow down" } }, { "retry-after": "0" }),
      chat({ content: "ok" }),
    ]);
    const message = await client(fetch, { maxRetries: 1 }).beta.messages.create(BASE);
    expect(seen).toHaveLength(2);
    expect(message.content).toMatchObject([{ type: "text", text: "ok" }]);
  });

  it("waits out a free tier's per-minute limit from the message, up to three times", async () => {
    const limited = () =>
      status(429, {
        error: {
          message: "Rate limit reached on tokens per minute (TPM). Please try again in 5ms.",
        },
      });
    const { fetch, seen } = fakeFetch([limited(), limited(), limited(), chat({ content: "ok" })]);
    const message = await client(fetch, { maxRetries: 1 }).beta.messages.create(BASE);
    expect(seen).toHaveLength(4);
    expect(message.content).toMatchObject([{ type: "text", text: "ok" }]);
  });

  it("fails at once when the provider asks for a wait longer than a minute window", async () => {
    const { fetch, seen } = fakeFetch([
      status(
        429,
        { error: { message: "Daily limit reached. Please try again in 7m12s." } },
        {
          "retry-after": "432",
        },
      ),
      chat({ content: "never" }),
    ]);
    const error = await client(fetch, { maxRetries: 1 })
      .beta.messages.create(BASE)
      .then(
        () => null,
        (e) => e,
      );
    expect(error).toBeInstanceOf(Anthropic.RateLimitError);
    expect(seen).toHaveLength(1);
  });

  it("asks again when the provider rejects a made-up tool call, at most twice", async () => {
    const rejected = () =>
      status(400, {
        error: {
          message:
            "Tool call validation failed: attempted to call tool 'commentary' which was not in request.tools",
          code: "tool_use_failed",
        },
      });
    const { fetch, seen } = fakeFetch([rejected(), chat({ content: "ok" })]);
    const message = await client(fetch, { maxRetries: 0 }).beta.messages.create(BASE);
    expect(seen).toHaveLength(2);
    expect(message.content).toMatchObject([{ type: "text", text: "ok" }]);

    const stuck = fakeFetch([rejected(), rejected(), rejected(), chat({ content: "never" })]);
    const error = await client(stuck.fetch, { maxRetries: 0 })
      .beta.messages.create(BASE)
      .then(
        () => null,
        (e) => e,
      );
    expect(error).toBeInstanceOf(Anthropic.BadRequestError);
    expect(stuck.seen).toHaveLength(3);
    expect(isToolCallRejection(error)).toBe(true);
    const malformed = Anthropic.APIError.generate(
      400,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Groq: Failed to parse tool call arguments as JSON",
        },
      },
      undefined,
      new Headers(),
    );
    expect(isToolCallRejection(malformed)).toBe(true);
  });

  it("reads rate-limit hints in seconds and milliseconds", () => {
    const err = (message: string, headers: Record<string, string> = {}) =>
      Anthropic.APIError.generate(
        429,
        { type: "error", error: { type: "rate_limit_error", message } },
        undefined,
        new Headers(headers),
      );
    expect(rateLimitHintMs(err("Please try again in 22.904999999s."))).toBeCloseTo(22_905, 0);
    expect(rateLimitHintMs(err("try again in 850ms"))).toBe(850);
    expect(rateLimitHintMs(err("slow down", { "retry-after": "3" }))).toBe(3_000);
    expect(rateLimitHintMs(err("slow down"))).toBeNull();
  });

  it("maps network failures, timeouts and aborts", async () => {
    const network = await client(fakeFetch([new TypeError("fetch failed")]).fetch)
      .beta.messages.create(BASE)
      .then(
        () => null,
        (e) => e,
      );
    expect(network).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(network).not.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);

    const hanging = (async (_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof globalThis.fetch;
    const timedOut = await client(hanging)
      .beta.messages.create(BASE, { timeout: 20 })
      .then(
        () => null,
        (e) => e,
      );
    expect(timedOut).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);

    const abort = new AbortController();
    const pending = client(hanging).beta.messages.create(BASE, { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
  });
});

describe("stream()", () => {
  it("replays the answer as Messages stream events, and finalMessage returns it", async () => {
    const { fetch, seen } = fakeFetch([
      chat(
        {
          content: "Let me look.",
          reasoning_content: "Plan.",
          tool_calls: [{ id: "c1", function: { name: "get_offer", arguments: '{"url":"u"}' } }],
        },
        "tool_calls",
      ),
    ]);
    const stream = client(fetch).beta.messages.stream(BASE);
    const events: BetaRawStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events.filter((e) => e.type === "content_block_delta").map((e) => e.delta)).toEqual([
      { type: "thinking_delta", thinking: "Plan.", estimated_tokens: null },
      { type: "text_delta", text: "Let me look." },
      { type: "input_json_delta", partial_json: '{"url":"u"}' },
    ]);
    expect(events.at(-2)).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 30 },
    });
    const final = await stream.finalMessage();
    expect(final.content).toHaveLength(3);
    expect(seen).toHaveLength(1);
  });

  it("feeds the analytics assistant's AG Studio translator", async () => {
    const { fetch } = fakeFetch([
      chat(
        {
          content: "Revenue is up.",
          reasoning_content: "Unsigned reasoning is not replayed.",
          tool_calls: [{ id: "q1", function: { name: "query", arguments: '{"sql":"x"}' } }],
        },
        "tool_calls",
      ),
    ]);
    const translator = new StreamTranslator();
    const out = [];
    for await (const event of client(fetch).beta.messages.stream(BASE)) {
      out.push(...translator.translate(event));
    }
    expect(out.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
    ]);
    expect(out[4]).toMatchObject({ toolCallId: "q1", delta: '{"sql":"x"}' });
  });

  it("stops when the signal is aborted", async () => {
    const abort = new AbortController();
    const { fetch } = fakeFetch([chat({ content: "x" })]);
    const stream = client(fetch).beta.messages.stream(BASE, { signal: abort.signal });
    abort.abort();
    const consume = async () => {
      for await (const _event of stream) {
        // drain
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
  });
});

describe("the research agent on an OpenAI-compatible provider", () => {
  /** A Chat Completions server that runs list_sources, buys one page, then finishes with it. */
  function scriptedProvider() {
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string | null; tool_call_id?: string }[];
      };
      requests.push(body);
      const call = (id: string, name: string, args: unknown) => ({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
      switch (requests.length) {
        case 1:
          return Response.json(
            chat(
              { content: "Checking the catalogs.", tool_calls: [call("c1", "list_sources", {})] },
              "tool_calls",
            ),
          );
        case 2:
          return Response.json(
            chat(
              {
                reasoning_content: "The grinder guide answers the question.",
                tool_calls: [
                  call("c2", "buy", { url: URLS.grinders, reason: "Answers the question" }),
                ],
              },
              "tool_calls",
            ),
          );
        default: {
          const result = body.messages.find((m) => m.role === "tool" && m.tool_call_id === "c2");
          const receiptId = JSON.parse(String(result?.content)).receiptId as string;
          return Response.json(
            chat(
              {
                content: null,
                tool_calls: [
                  call("c3", "finish", {
                    answer: "Get the Burrwell 60 [1].",
                    citations: [{ url: URLS.grinders, receiptId, claim: "It is the pick" }],
                  }),
                ],
              },
              "tool_calls",
            ),
          );
        }
      }
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
  }

  it("runs a full buy -> finish run from synthesized stream events", async () => {
    const provider = scriptedProvider();
    const agents = fakeAgents();
    const deps = {
      ...fakeDeps(client(provider.fetch), agents),
      model: "llama-test",
      provider: "groq" as const,
    };
    const events: ResearchEvent[] = [];
    const summary = await runResearch(deps, { question: "Which grinder?", budgetCents: 25 }, (e) =>
      events.push(e),
    );

    expect(summary).toMatchObject({ status: "finished", spentCents: 3, receipts: 1, toolCalls: 3 });
    expect(events[0]).toMatchObject({ type: "run-started", model: "llama-test", provider: "groq" });
    expect(
      events.filter((e) => e.type === "thinking").map((e) => e.type === "thinking" && e.delta),
    ).toEqual(["The grinder guide answers the question."]);
    expect(events.find((e) => e.type === "text")).toMatchObject({
      delta: "Checking the catalogs.",
    });
    expect(events.find((e) => e.type === "answer")).toMatchObject({
      answer: "Get the Burrwell 60 [1].",
      citations: [{ url: URLS.grinders, receiptId: "rcpt_test1" }],
    });
    expect(agents.calls.fetch.map((f) => f.url)).toEqual([URLS.grinders]);

    // Plain Chat Completions requests: no Anthropic params, the tool results as tool messages.
    const first = provider.requests[0] as Record<string, unknown>;
    expect(first).toMatchObject({ model: "llama-test", max_tokens: 8000, tool_choice: "auto" });
    for (const key of ["thinking", "cache_control", "betas", "fallbacks", "output_config"]) {
      expect(first).not.toHaveProperty(key);
    }
    const third = provider.requests[2] as { messages: { role: string; tool_call_id?: string }[] };
    expect(third.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(JSON.stringify(provider.requests)).not.toContain("bfk_");
  });

  it("re-issues a turn whose tool arguments were not JSON", async () => {
    let n = 0;
    const fetch = (async () => {
      n += 1;
      if (n === 1) {
        return Response.json(
          chat({ tool_calls: [{ id: "x", function: { name: "buy", arguments: "{oops" } }] }),
        );
      }
      return Response.json(chat({ content: "No answer." }));
    }) as unknown as typeof globalThis.fetch;
    const events: ResearchEvent[] = [];
    await runResearch(fakeDeps(client(fetch)), { question: "q", budgetCents: 25 }, (e) =>
      events.push(e),
    );
    // The bad turn was asked again (not reported as an API error).
    expect(n).toBe(3);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "no_answer" });
  });

  it("counts a turn cut off mid tool call, never runs its input, and asks again", async () => {
    const requests: { messages: { role: string; content: string | null }[] }[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return Response.json(
          chat(
            {
              tool_calls: [{ id: "x", function: { name: "buy", arguments: '{"url": "https://' } }],
            },
            "length",
            { prompt_tokens: 100, completion_tokens: 7000 },
          ),
        );
      }
      return Response.json(chat({ content: "No answer." }));
    }) as unknown as typeof globalThis.fetch;
    const agents = fakeAgents();
    const events: ResearchEvent[] = [];
    const summary = await runResearch(
      fakeDeps(client(fetch), agents),
      { question: "q", budgetCents: 25 },
      (e) => events.push(e),
    );
    // One request for the cut-off turn (not re-issued blindly), then the follow-up turns.
    expect(requests).toHaveLength(3);
    expect(agents.calls.fetch).toEqual([]);
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
    // The cut-off call was answered with an error asking the model to call it again.
    const second = requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(second[3]?.content).toMatch(/cut off/);
    // Its tokens were counted.
    expect(summary.weightedTokens).toBeGreaterThanOrEqual(7_100);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "no_answer" });
  });
});
