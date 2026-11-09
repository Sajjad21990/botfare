import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aiAvailable,
  aiProviders,
  createModelClient,
  defaultModelHint,
  defaultProvider,
  filterOpenRouterModels,
  listProviderModels,
  OLLAMA_NON_CHAT,
  offeredModels,
  type ProviderConfig,
  parseModelList,
  pickDefaultModel,
  providerModels,
  resetModelListCache,
  resolveAiChoice,
  resolveDefaultAi,
} from "../src/lib/server/ai/providers";

beforeEach(() => resetModelListCache());
afterEach(() => vi.restoreAllMocks());

function config(env: Record<string, string>, id: ProviderConfig["id"]): ProviderConfig {
  const found = aiProviders(env).find((p) => p.id === id);
  if (!found) throw new Error(`${id} is not configured`);
  return found;
}

/** A /models endpoint answering with `data`, counting calls. */
function modelsFetch(data: unknown[], status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return status === 200
      ? Response.json({ object: "list", data })
      : new Response("{}", { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("configured providers", () => {
  it("reads keys from the environment, in order, and Ollama only with a base URL", () => {
    expect(aiProviders({})).toEqual([]);
    expect(aiAvailable({})).toBe(false);
    const env = {
      OLLAMA_MODEL: "qwen3",
      GROQ_API_KEY: " gsk_x ",
      OPENAI_API_KEY: "sk-x",
      OPENAI_MODEL: " gpt-test ",
      XAI_API_KEY: "",
    };
    expect(aiProviders(env).map((p) => [p.id, p.apiKey, p.configuredModel])).toEqual([
      ["openai", "sk-x", "gpt-test"],
      ["groq", "gsk_x", null],
    ]);
    expect(
      aiProviders({ ...env, OPENAI_MODELS: " gpt-5, ,o3 ,gpt-5 ", GROQ_MODELS: "" }).map(
        (p) => p.allowedModels,
      ),
    ).toEqual([["gpt-5", "o3"], []]);
    expect(parseModelList(undefined)).toEqual([]);
    const local = aiProviders({ OLLAMA_BASE_URL: "http://localhost:11434/v1/" });
    expect(local).toMatchObject([
      { id: "ollama", apiKey: null, baseUrl: "http://localhost:11434/v1" },
    ]);
  });

  it("picks AI_PROVIDER when configured, else Anthropic, else the first configured", () => {
    const keys = { ANTHROPIC_API_KEY: "a", GROQ_API_KEY: "g", GEMINI_API_KEY: "m" };
    expect(defaultProvider(keys)?.id).toBe("anthropic");
    expect(defaultProvider({ ...keys, AI_PROVIDER: "groq" })?.id).toBe("groq");
    expect(defaultProvider({ GROQ_API_KEY: "g", GEMINI_API_KEY: "m" })?.id).toBe("gemini");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(defaultProvider({ ...keys, AI_PROVIDER: "openrouter" })?.id).toBe("anthropic");
    expect(defaultProvider({})).toBeNull();
  });

  it("keeps Anthropic's model behaviour: ANTHROPIC_MODEL or claude-sonnet-5-5", async () => {
    expect(defaultModelHint({ ANTHROPIC_API_KEY: "a" })).toEqual({
      provider: "anthropic",
      label: "Anthropic",
      model: "claude-sonnet-5-5",
    });
    const ai = await resolveDefaultAi({
      env: { ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "claude-opus-5-5" },
    });
    expect(ai).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(ai?.client).toBeInstanceOf(Anthropic);
  });

  it("sends OpenRouter's attribution headers", async () => {
    const env = { OPENROUTER_API_KEY: "sk-or-x", BOTFARE_URL: "https://botfare.test" };
    const { fetch, calls } = modelsFetch([]);
    await listProviderModels(config(env, "openrouter"), { fetch });
    expect(calls[0]).toMatchObject({
      url: "https://openrouter.ai/api/v1/models",
      headers: {
        authorization: "Bearer sk-or-x",
        "HTTP-Referer": "https://botfare.test",
        "X-Title": "BotFare",
      },
    });
  });
});

describe("model lists", () => {
  it("keeps OpenAI's chat models only", async () => {
    const { fetch, calls } = modelsFetch(
      [
        "gpt-5-mini",
        "text-embedding-3-small",
        "whisper-1",
        "tts-1",
        "dall-e-3",
        "gpt-4o-realtime-preview",
        "gpt-4o-transcribe",
        "omni-moderation-latest",
        "gpt-image-1",
        "o4-mini",
        "gpt-4.1-mini",
        "babbage-002",
      ].map((id) => ({ id, object: "model" })),
    );
    const openai = config({ OPENAI_API_KEY: "sk" }, "openai");
    expect(await listProviderModels(openai, { fetch })).toEqual([
      { id: "gpt-4.1-mini" },
      { id: "gpt-5-mini" },
      { id: "o4-mini" },
    ]);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
  });

  it("strips Gemini's models/ prefix and drops embedding, image and speech models", async () => {
    const { fetch, calls } = modelsFetch(
      [
        "models/gemini-2.5-flash",
        "models/text-embedding-004",
        "models/imagen-4.0-generate-001",
        "models/gemini-2.5-flash-preview-tts",
        "models/aqa",
        "models/gemini-flash-latest",
      ].map((id) => ({ id })),
    );
    const gemini = config({ GEMINI_API_KEY: "k" }, "gemini");
    const listed = await listProviderModels(gemini, { fetch });
    expect(listed).toEqual([{ id: "gemini-2.5-flash" }, { id: "gemini-flash-latest" }]);
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
    expect(pickDefaultModel(gemini, listed)).toBe("gemini-flash-latest");
  });

  it("keeps OpenRouter's tool-capable models, free ones first", () => {
    expect(
      filterOpenRouterModels([
        {
          id: "a/paid",
          pricing: { prompt: "0.1", completion: "0.2" },
          supported_parameters: ["tools"],
        },
        { id: "b/no-tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
        {
          id: "c/zero",
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: ["tools"],
        },
        {
          id: "d/model:free",
          pricing: { prompt: "1", completion: "1" },
          supported_parameters: ["tools"],
        },
      ]),
    ).toEqual([{ id: "c/zero", free: true }, { id: "d/model:free", free: true }, { id: "a/paid" }]);
  });

  it("drops Groq's speech and guard models and flags Ollama's local models as free", async () => {
    const groq = config({ GROQ_API_KEY: "g" }, "groq");
    const { fetch } = modelsFetch([
      { id: "whisper-large-v3" },
      { id: "meta-llama/llama-guard-4-12b" },
      { id: "llama-3.3-70b-versatile" },
      { id: "old-model", active: false },
      { id: "openai/gpt-oss-20b" },
    ]);
    const listed = await listProviderModels(groq, { fetch });
    expect(listed).toEqual([{ id: "llama-3.3-70b-versatile" }, { id: "openai/gpt-oss-20b" }]);
    expect(pickDefaultModel(groq, listed)).toBe("llama-3.3-70b-versatile");

    const ollama = config({ OLLAMA_BASE_URL: "http://localhost:11434/v1" }, "ollama");
    const local = await listProviderModels(ollama, {
      fetch: modelsFetch([{ id: "qwen3:8b" }]).fetch,
    });
    expect(local).toEqual([{ id: "qwen3:8b", free: true }]);
  });

  it("picks <P>_MODEL, then a preferred model, then OpenRouter's first free one, then the first", () => {
    const groq = config({ GROQ_API_KEY: "g", GROQ_MODEL: "pinned" }, "groq");
    expect(pickDefaultModel(groq, [{ id: "x" }])).toBe("pinned");
    const openrouter = config({ OPENROUTER_API_KEY: "k" }, "openrouter");
    expect(pickDefaultModel(openrouter, [{ id: "paid" }, { id: "free:free", free: true }])).toBe(
      "free:free",
    );
    // OpenRouter's free router beats tiny listed free models, and is the fallback (never the paid auto router).
    expect(
      pickDefaultModel(openrouter, [
        { id: "tiny-1.7b:free", free: true },
        { id: "openrouter/free", free: true },
      ]),
    ).toBe("openrouter/free");
    expect(pickDefaultModel(openrouter, [])).toBe("openrouter/free");
    const groqDefault = config({ GROQ_API_KEY: "g" }, "groq");
    expect(
      pickDefaultModel(groqDefault, [
        { id: "llama-3.3-70b-versatile" },
        { id: "openai/gpt-oss-120b" },
      ]),
    ).toBe("openai/gpt-oss-120b");
    const xai = config({ XAI_API_KEY: "k" }, "xai");
    expect(pickDefaultModel(xai, [{ id: "grok-x" }, { id: "grok-y" }])).toBe("grok-x");
    expect(pickDefaultModel(xai, [])).toBe("grok-4");
  });

  it("drops Ollama's embedding and rerank models and prefers qwen3/llama3.x for the default", async () => {
    for (const id of [
      "nomic-embed-text:latest",
      "mxbai-embed-large",
      "bge-m3:latest",
      "all-minilm:l6-v2",
      "snowflake-arctic-embed2",
      "jeffh/intfloat-multilingual-e5-large:f16",
      "e5-mistral:7b",
      "qllama/bge-reranker-v2-m3",
      "dengcao/qwen3-reranker-0.6b",
    ]) {
      expect(OLLAMA_NON_CHAT.test(id), id).toBe(true);
    }
    for (const id of ["qwen3:8b", "llama3.2:latest", "gemma3:4b", "mistral-nemo", "deepseek-r1"]) {
      expect(OLLAMA_NON_CHAT.test(id), id).toBe(false);
    }
    const ollama = config({ OLLAMA_BASE_URL: "http://localhost:11434/v1" }, "ollama");
    const listed = await listProviderModels(ollama, {
      fetch: modelsFetch([
        { id: "nomic-embed-text:latest" },
        { id: "gemma3:4b" },
        { id: "llama3.2:latest" },
        { id: "qwen3:8b" },
      ]).fetch,
    });
    expect(listed.map((m) => m.id)).toEqual(["gemma3:4b", "llama3.2:latest", "qwen3:8b"]);
    // Families in order: qwen3 before llama3.2, whatever Ollama's order.
    expect(pickDefaultModel(ollama, listed)).toBe("qwen3:8b");
    expect(pickDefaultModel(ollama, [{ id: "llama3.1" }, { id: "gemma3:4b" }])).toBe("llama3.1");
    // `qwen3` is a family name, not a prefix of other names.
    expect(pickDefaultModel(ollama, [{ id: "qwen3-coder:30b" }, { id: "gemma3:4b" }])).toBe(
      "qwen3-coder:30b",
    );
    expect(pickDefaultModel(ollama, [{ id: "gemma3:4b" }, { id: "qwen3-coder:30b" }])).toBe(
      "gemma3:4b",
    );
    // Only embedding models: the fixed fallback, not an embedding model.
    const embedOnly = await providerModels(
      config({ OLLAMA_BASE_URL: "http://other:11434/v1" }, "ollama"),
      { fetch: modelsFetch([{ id: "nomic-embed-text" }]).fetch },
    );
    expect(embedOnly).toMatchObject({
      default: "llama3.2",
      models: [{ id: "llama3.2", free: true }],
    });
  });

  it("keeps the last good list when a refetch fails, for every waiter, and retries after a minute", async () => {
    let now = 1_000_000;
    const groq = config({ GROQ_API_KEY: "g" }, "groq");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = false;
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return failing
        ? new Response("{}", { status: 503 })
        : Response.json({ data: [{ id: "llama-a" }, { id: "llama-b" }] });
    }) as unknown as typeof globalThis.fetch;
    const good = await listProviderModels(groq, { fetch, now: () => now });
    expect(good).toEqual([{ id: "llama-a" }, { id: "llama-b" }]);

    now += 11 * 60_000;
    failing = true;
    const [first, second] = await Promise.all([
      listProviderModels(groq, { fetch, now: () => now }),
      listProviderModels(groq, { fetch, now: () => now }),
    ]);
    expect(calls).toBe(2);
    expect(first).toEqual(good);
    expect(second).toEqual(good);
    // The default picked from the good list stays valid (an empty list would mean another default).
    const env = { GROQ_API_KEY: "g" };
    expect(
      await resolveAiChoice({ provider: "groq", model: "llama-a" }, { env, fetch, now: () => now }),
    ).toMatchObject({ ok: true, ai: { model: "llama-a" } });
    expect(calls).toBe(2);

    // Retried after the failure TTL (a minute), not the ten-minute one.
    now += 61_000;
    failing = false;
    await listProviderModels(groq, { fetch, now: () => now });
    expect(calls).toBe(3);
  });

  it("caches lists for ten minutes, and a failed list reads as just the default", async () => {
    let now = 1_000_000;
    const groq = config({ GROQ_API_KEY: "g" }, "groq");
    const ok = modelsFetch([{ id: "m1" }]);
    await listProviderModels(groq, { fetch: ok.fetch, now: () => now });
    await listProviderModels(groq, { fetch: ok.fetch, now: () => now + 60_000 });
    expect(ok.calls).toHaveLength(1);
    now += 11 * 60_000;
    await listProviderModels(groq, { fetch: ok.fetch, now: () => now });
    expect(ok.calls).toHaveLength(2);

    resetModelListCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = modelsFetch([], 500);
    const models = await providerModels(groq, { fetch: failing.fetch });
    expect(models).toEqual({
      provider: "groq",
      label: "Groq",
      models: [{ id: "llama-3.3-70b-versatile" }],
      default: "llama-3.3-70b-versatile",
    });
  });
});

describe("offered models", () => {
  const OPENROUTER_LIST = [
    {
      id: "openai/o1-pro",
      pricing: { prompt: "0.00015", completion: "0.0006" },
      supported_parameters: ["tools"],
    },
    {
      id: "anthropic/claude-opus-5",
      pricing: { prompt: "0.000015", completion: "0.000075" },
      supported_parameters: ["tools"],
    },
    {
      id: "vendor/cheap",
      pricing: { prompt: "0.0000001", completion: "0.0000002" },
      supported_parameters: ["tools"],
    },
    {
      id: "meta-llama/llama-test:free",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
    },
  ];

  it("offers only the default, <P>_MODEL, free models and <P>_MODELS", async () => {
    const env = { OPENROUTER_API_KEY: "k" };
    const plainList = await providerModels(config(env, "openrouter"), {
      fetch: modelsFetch(OPENROUTER_LIST).fetch,
    });
    expect(plainList.models).toEqual([{ id: "meta-llama/llama-test:free", free: true }]);
    for (const premium of ["openai/o1-pro", "anthropic/claude-opus-5", "vendor/cheap"]) {
      expect(
        await resolveAiChoice(
          { provider: "openrouter", model: premium },
          { env, fetch: modelsFetch(OPENROUTER_LIST).fetch },
        ),
      ).toMatchObject({ ok: false, code: "model_unavailable" });
    }

    resetModelListCache();
    const allowed = {
      ...env,
      OPENROUTER_MODEL: "vendor/cheap",
      OPENROUTER_MODELS: "anthropic/claude-opus-5, vendor/unlisted",
    };
    const withAllowlist = await providerModels(config(allowed, "openrouter"), {
      fetch: modelsFetch(OPENROUTER_LIST).fetch,
    });
    expect(withAllowlist).toMatchObject({
      default: "vendor/cheap",
      models: [
        { id: "vendor/cheap" },
        { id: "meta-llama/llama-test:free", free: true },
        { id: "anthropic/claude-opus-5" },
        { id: "vendor/unlisted" },
      ],
    });
    expect(
      await resolveAiChoice(
        { provider: "openrouter", model: "anthropic/claude-opus-5" },
        { env: allowed, fetch: modelsFetch(OPENROUTER_LIST).fetch },
      ),
    ).toMatchObject({ ok: true, ai: { model: "anthropic/claude-opus-5" } });
    expect(
      await resolveAiChoice(
        { provider: "openrouter", model: "openai/o1-pro" },
        { env: allowed, fetch: modelsFetch(OPENROUTER_LIST).fetch },
      ),
    ).toMatchObject({ ok: false, code: "model_unavailable" });
  });

  it("keeps OpenAI's pro and o1 models off unless allowlisted", async () => {
    const list = ["gpt-5-mini", "gpt-5-pro", "o1-pro", "o1", "gpt-4.1-mini"].map((id) => ({ id }));
    const openai = config({ OPENAI_API_KEY: "sk" }, "openai");
    expect(await providerModels(openai, { fetch: modelsFetch(list).fetch })).toMatchObject({
      default: "gpt-5-mini",
      models: [{ id: "gpt-5-mini" }],
    });
    const env = { OPENAI_API_KEY: "sk", OPENAI_MODELS: "gpt-4.1-mini" };
    resetModelListCache();
    expect(
      (await providerModels(config(env, "openai"), { fetch: modelsFetch(list).fetch })).models,
    ).toEqual([{ id: "gpt-5-mini" }, { id: "gpt-4.1-mini" }]);
    expect(
      await resolveAiChoice(
        { provider: "openai", model: "o1-pro" },
        { env, fetch: modelsFetch(list).fetch },
      ),
    ).toMatchObject({ ok: false, code: "model_unavailable" });
  });

  it("offers Claude's default and Haiku, and Opus only when configured or allowlisted", async () => {
    const models = async (env: Record<string, string>) =>
      (await providerModels(config(env, "anthropic"))).models.map((m) => m.id);
    expect(await models({ ANTHROPIC_API_KEY: "a" })).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
    expect(
      await resolveAiChoice(
        { provider: "anthropic", model: "claude-opus-5-5" },
        { env: { ANTHROPIC_API_KEY: "a" } },
      ),
    ).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(await models({ ANTHROPIC_API_KEY: "a", ANTHROPIC_MODELS: "claude-opus-5-5" })).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
      "claude-opus-5-5",
    ]);
    expect(await models({ ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "claude-opus-5-5" })).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
  });

  it("offers every listed Ollama model (all local and free)", () => {
    const ollama = config({ OLLAMA_BASE_URL: "http://localhost:11434/v1" }, "ollama");
    const listed = [
      { id: "gemma3:4b", free: true },
      { id: "qwen3:8b", free: true },
    ];
    expect(offeredModels(ollama, listed, "qwen3:8b")).toEqual([
      { id: "qwen3:8b", free: true },
      { id: "gemma3:4b", free: true },
    ]);
  });
});

describe("explicit choices", () => {
  it("accepts a configured provider's offered model or its default, and nothing else", async () => {
    const env = { ANTHROPIC_API_KEY: "a", GROQ_API_KEY: "g", GROQ_MODELS: "llama-b" };
    const { fetch } = modelsFetch([{ id: "llama-a" }, { id: "llama-b" }]);
    const ok = await resolveAiChoice({ provider: "groq", model: "llama-b" }, { env, fetch });
    expect(ok).toMatchObject({ ok: true, ai: { provider: "groq", model: "llama-b" } });
    expect(ok.ok && ok.ai.client).not.toBeInstanceOf(Anthropic);

    expect(await resolveAiChoice({ provider: "groq" }, { env, fetch })).toMatchObject({
      ok: true,
      ai: { model: "llama-a" },
    });
    expect(await resolveAiChoice({}, { env, fetch })).toMatchObject({
      ok: true,
      ai: { provider: "anthropic", model: "claude-sonnet-5-5" },
    });
    expect(
      await resolveAiChoice({ provider: "groq", model: "nope" }, { env, fetch }),
    ).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(await resolveAiChoice({ provider: "xai" }, { env, fetch })).toMatchObject({
      ok: false,
      code: "provider_unavailable",
    });
    expect(await resolveAiChoice({}, { env: {} })).toMatchObject({
      ok: false,
      code: "provider_unavailable",
    });
  });

  it("sends reasoning_effort for OpenAI's reasoning models, and only on OpenAI", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    }) as unknown as typeof globalThis.fetch;
    const params = {
      model: "gpt-5-mini",
      max_tokens: 100,
      messages: [{ role: "user" as const, content: "Hi" }],
    };
    await createModelClient(config({ OPENAI_API_KEY: "sk" }, "openai"), {
      fetch,
    }).beta.messages.create(params);
    await createModelClient(config({ OPENROUTER_API_KEY: "k" }, "openrouter"), {
      fetch,
    }).beta.messages.create(params);
    expect(bodies[0]).toMatchObject({ reasoning_effort: "low", max_completion_tokens: 100 });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("creates the Anthropic SDK for Anthropic and the adapter for the rest", () => {
    expect(createModelClient(config({ ANTHROPIC_API_KEY: "a" }, "anthropic"))).toBeInstanceOf(
      Anthropic,
    );
    const adapter = createModelClient(config({ XAI_API_KEY: "x" }, "xai"));
    expect(adapter).not.toBeInstanceOf(Anthropic);
    expect(typeof adapter.beta.messages.stream).toBe("function");
  });
});
