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
  type ProviderConfig,
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
    const xai = config({ XAI_API_KEY: "k" }, "xai");
    expect(pickDefaultModel(xai, [{ id: "grok-x" }, { id: "grok-y" }])).toBe("grok-x");
    expect(pickDefaultModel(xai, [])).toBe("grok-4");
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

describe("explicit choices", () => {
  it("accepts a configured provider's listed model or its default, and nothing else", async () => {
    const env = { ANTHROPIC_API_KEY: "a", GROQ_API_KEY: "g" };
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

  it("creates the Anthropic SDK for Anthropic and the adapter for the rest", () => {
    expect(createModelClient(config({ ANTHROPIC_API_KEY: "a" }, "anthropic"))).toBeInstanceOf(
      Anthropic,
    );
    const adapter = createModelClient(config({ XAI_API_KEY: "x" }, "xai"));
    expect(adapter).not.toBeInstanceOf(Anthropic);
    expect(typeof adapter.beta.messages.stream).toBe("function");
  });
});
