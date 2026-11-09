import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./model-client";
import { createOpenAICompatibleClient, fetchModelList } from "./openai-compatible";

/**
 * The AI providers this server can use, configured from the environment. Anthropic runs on its own
 * SDK; the others on the OpenAI-compatible adapter. Base URLs are fixed here (Ollama's comes from
 * OLLAMA_BASE_URL, which also turns it on). Keys stay on the server: nothing here returns them.
 *
 * The default provider (Fare Court, Fare Advisor, the analytics assistant and the research agent's
 * default) is AI_PROVIDER when that provider is configured, else Anthropic when ANTHROPIC_API_KEY
 * is set, else the first configured provider in PROVIDER_IDS order.
 */

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "gemini",
  "xai",
  "groq",
  "openrouter",
  "ollama",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The Anthropic default used before multiple providers (unchanged). */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/** For messages that say how to turn AI on. */
export const AI_KEY_HINT =
  "an AI key (ANTHROPIC_API_KEY, or OPENAI/GEMINI/XAI/GROQ/OPENROUTER_API_KEY, or OLLAMA_BASE_URL)";

export interface ModelInfo {
  id: string;
  /** No charge per token (OpenRouter's free models, local Ollama models). */
  free?: boolean;
}

interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** Environment variable holding the key (Ollama has none). */
  keyEnv?: string;
  modelEnv: string;
  baseUrl: (env: Env) => string | null;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  headers?: (env: Env) => Record<string, string>;
  thoughtSignatures?: boolean;
  /** Preferred defaults, used when the provider lists them (first match wins). */
  preferred: string[];
  /** The default when <P>_MODEL is unset and the model list cannot be read. */
  fallback: string;
  /** Chat models from the provider's GET /models `data`. */
  filter: (data: unknown[]) => ModelInfo[];
}

type Env = Record<string, string | undefined>;

function ids(data: unknown[]): string[] {
  return data.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (record.active === false) return [];
      const id = record.id ?? record.name ?? record.model;
      if (typeof id === "string" && id) return [id];
    }
    return [];
  });
}

function plain(list: string[]): ModelInfo[] {
  return [...new Set(list)].map((id) => ({ id }));
}

const OPENAI_NON_CHAT =
  /embed|audio|tts|whisper|dall-e|image|realtime|transcribe|moderation|search|instruct|computer-use|codex|sora|davinci|babbage/i;
const GEMINI_NON_CHAT = /embed|imagen|tts|aqa|veo|image|audio|live|robotics|computer-use/i;
const XAI_NON_CHAT = /image|imagine|embed|video/i;
const GROQ_NON_CHAT = /whisper|tts|guard|playai|orpheus|embed|distil/i;

/** Free on OpenRouter: zero prompt and completion prices, or a `:free` variant. */
export function isFreeOpenRouterModel(item: Record<string, unknown>): boolean {
  const id = typeof item.id === "string" ? item.id : "";
  if (id.endsWith(":free")) return true;
  const pricing = item.pricing as Record<string, unknown> | undefined;
  const zero = (value: unknown) => value === "0" || value === 0;
  return Boolean(pricing && zero(pricing.prompt) && zero(pricing.completion));
}

export function filterOpenRouterModels(data: unknown[]): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id) continue;
    const params = record.supported_parameters;
    if (!Array.isArray(params) || !params.includes("tools")) continue;
    models.push(isFreeOpenRouterModel(record) ? { id, free: true } : { id });
  }
  // Free first; otherwise the provider's order.
  return [...models.filter((m) => m.free), ...models.filter((m) => !m.free)];
}

const SPECS: Record<ProviderId, ProviderSpec> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    baseUrl: () => null,
    preferred: [DEFAULT_ANTHROPIC_MODEL],
    fallback: DEFAULT_ANTHROPIC_MODEL,
    filter: () => [],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    baseUrl: () => "https://api.openai.com/v1",
    maxTokensParam: "max_completion_tokens",
    preferred: ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
    fallback: "gpt-5-mini",
    filter: (data) =>
      plain(
        ids(data)
          .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !OPENAI_NON_CHAT.test(id))
          .sort(),
      ),
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai",
    thoughtSignatures: true,
    preferred: ["gemini-flash-latest", "gemini-2.5-flash"],
    fallback: "gemini-2.5-flash",
    filter: (data) =>
      plain(
        ids(data)
          .map((id) => id.replace(/^models\//, ""))
          .filter((id) => !GEMINI_NON_CHAT.test(id)),
      ),
  },
  xai: {
    id: "xai",
    label: "xAI Grok",
    keyEnv: "XAI_API_KEY",
    modelEnv: "XAI_MODEL",
    baseUrl: () => "https://api.x.ai/v1",
    preferred: ["grok-4-fast", "grok-4", "grok-3-mini"],
    fallback: "grok-4",
    filter: (data) => plain(ids(data).filter((id) => /grok/i.test(id) && !XAI_NON_CHAT.test(id))),
  },
  groq: {
    id: "groq",
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    baseUrl: () => "https://api.groq.com/openai/v1",
    preferred: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
    fallback: "llama-3.3-70b-versatile",
    filter: (data) => plain(ids(data).filter((id) => !GROQ_NON_CHAT.test(id))),
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    baseUrl: () => "https://openrouter.ai/api/v1",
    // OpenRouter's app attribution: this server's public URL and the app name.
    headers: (env) => ({
      "HTTP-Referer":
        env.BOTFARE_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || "http://localhost:3000",
      "X-Title": "BotFare",
    }),
    preferred: [],
    fallback: "openrouter/auto",
    filter: filterOpenRouterModels,
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    modelEnv: "OLLAMA_MODEL",
    baseUrl: (env) => env.OLLAMA_BASE_URL?.trim().replace(/\/+$/, "") || null,
    preferred: [],
    fallback: "llama3.2",
    filter: (data) => plain(ids(data)).map((m) => ({ ...m, free: true })),
  },
};

/** The static Anthropic list: the configured model, the default and two alternatives. */
function anthropicModels(configured: string | null): ModelInfo[] {
  return plain(
    [configured, DEFAULT_ANTHROPIC_MODEL, "claude-opus-5-5", "claude-haiku-4-5"].filter(
      (id): id is string => Boolean(id),
    ),
  );
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** Server only: never send to the browser or a model. */
  apiKey: string | null;
  baseUrl: string | null;
  /** <P>_MODEL when set. */
  configuredModel: string | null;
  /** Extra request headers (OpenRouter's app attribution). */
  headers: Record<string, string>;
}

/** Configured providers, in PROVIDER_IDS order. */
export function aiProviders(env: Env = process.env): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const id of PROVIDER_IDS) {
    const spec = SPECS[id];
    const apiKey = spec.keyEnv ? env[spec.keyEnv]?.trim() || null : null;
    const baseUrl = spec.baseUrl(env);
    if (spec.keyEnv ? !apiKey : !baseUrl) continue;
    out.push({
      id,
      label: spec.label,
      apiKey,
      baseUrl,
      configuredModel: env[spec.modelEnv]?.trim() || null,
      headers: spec.headers?.(env) ?? {},
    });
  }
  return out;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

let warnedProvider: string | null = null;

/** The server's default provider, or null when none is configured. */
export function defaultProvider(env: Env = process.env): ProviderConfig | null {
  const providers = aiProviders(env);
  const wanted = env.AI_PROVIDER?.trim().toLowerCase();
  if (wanted) {
    const match = providers.find((p) => p.id === wanted);
    if (match) return match;
    if (warnedProvider !== wanted) {
      warnedProvider = wanted;
      console.warn(`[ai] AI_PROVIDER=${wanted} is not configured; using the next available one`);
    }
  }
  return providers.find((p) => p.id === "anthropic") ?? providers[0] ?? null;
}

/** True when any provider is configured. */
export function aiAvailable(env: Env = process.env): boolean {
  return defaultProvider(env) !== null;
}

// --- Model lists ----------------------------------------------------------------------------------

const LIST_TTL_MS = 10 * 60_000;
const LIST_FAILURE_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 4_000;

interface ListEntry {
  at: number;
  ok: boolean;
  models: ModelInfo[];
  pending?: Promise<ModelInfo[]>;
}

const globalForAi = globalThis as typeof globalThis & {
  __botfareModelLists?: Map<string, ListEntry>;
};

function listCache(): Map<string, ListEntry> {
  globalForAi.__botfareModelLists ??= new Map();
  return globalForAi.__botfareModelLists;
}

/** Tests: forget cached model lists. */
export function resetModelListCache(): void {
  globalForAi.__botfareModelLists = undefined;
}

export interface AiDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

function clientOptions(config: ProviderConfig, deps: AiDeps = {}) {
  const spec = SPECS[config.id];
  return {
    label: spec.label,
    baseUrl: config.baseUrl ?? "",
    apiKey: config.apiKey,
    headers: config.headers,
    maxTokensParam: spec.maxTokensParam,
    thoughtSignatures: spec.thoughtSignatures,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
}

/**
 * The provider's chat models (cached ten minutes; a failed list is retried after a minute and
 * reads as empty). Anthropic's is a static list.
 */
export async function listProviderModels(
  config: ProviderConfig,
  deps: AiDeps = {},
): Promise<ModelInfo[]> {
  if (config.id === "anthropic") return anthropicModels(config.configuredModel);
  const now = deps.now?.() ?? Date.now();
  const key = `${config.id} ${config.baseUrl}`;
  const cache = listCache();
  const entry = cache.get(key);
  if (entry?.pending) return entry.pending;
  if (entry && now - entry.at < (entry.ok ? LIST_TTL_MS : LIST_FAILURE_TTL_MS)) {
    return entry.models;
  }
  const pending = fetchModelList(
    { ...clientOptions(config, deps), maxRetries: 0 },
    { timeout: LIST_TIMEOUT_MS },
  )
    .then((data) => {
      const models = SPECS[config.id].filter(data);
      cache.set(key, { at: now, ok: true, models });
      return models;
    })
    .catch((error: unknown) => {
      console.warn(
        `[ai] could not list ${SPECS[config.id].label} models:`,
        error instanceof Error ? error.message : "unknown error",
      );
      cache.set(key, { at: now, ok: false, models: [] });
      return [] as ModelInfo[];
    });
  cache.set(key, { at: entry?.at ?? 0, ok: false, models: entry?.models ?? [], pending });
  return pending;
}

/**
 * The provider's default model: <P>_MODEL, else a preferred model it lists, else (OpenRouter) the
 * first free tool-capable model, else the first listed, else a fixed fallback.
 */
export function pickDefaultModel(config: ProviderConfig, listed: ModelInfo[]): string {
  if (config.configuredModel) return config.configuredModel;
  const spec = SPECS[config.id];
  if (config.id === "anthropic") return spec.fallback;
  const available = new Set(listed.map((m) => m.id));
  const preferred = spec.preferred.find((id) => available.has(id));
  if (preferred) return preferred;
  if (config.id === "openrouter") {
    const free = listed.find((m) => m.free);
    if (free) return free.id;
  }
  return listed[0]?.id ?? spec.fallback;
}

export interface ProviderModels {
  provider: ProviderId;
  label: string;
  /** The default first, then the provider's other chat models. */
  models: ModelInfo[];
  default: string;
}

/** A provider's models for the picker: never its key. */
export async function providerModels(
  config: ProviderConfig,
  deps: AiDeps = {},
): Promise<ProviderModels> {
  const listed = await listProviderModels(config, deps);
  const chosen = pickDefaultModel(config, listed);
  const models = listed.some((m) => m.id === chosen)
    ? [...listed.filter((m) => m.id === chosen), ...listed.filter((m) => m.id !== chosen)]
    : [{ id: chosen, ...(config.id === "ollama" ? { free: true } : {}) }, ...listed];
  return { provider: config.id, label: config.label, models, default: chosen };
}

// --- Clients --------------------------------------------------------------------------------------

export interface ResolvedAi {
  provider: ProviderId;
  label: string;
  model: string;
  client: ModelClient;
}

export interface ClientOptions extends AiDeps {
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  maxRetries?: number;
}

export function createModelClient(
  config: ProviderConfig,
  options: ClientOptions = {},
): ModelClient {
  if (config.id === "anthropic") {
    return new Anthropic({
      apiKey: config.apiKey ?? undefined,
      maxRetries: options.maxRetries ?? 1,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
  }
  return createOpenAICompatibleClient({
    ...clientOptions(config, options),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    maxRetries: options.maxRetries ?? 1,
  });
}

/** The default provider's model name without listing models (null when it needs the list). */
export function defaultModelHint(env: Env = process.env): {
  provider: ProviderId;
  label: string;
  model: string | null;
} | null {
  const config = defaultProvider(env);
  if (!config) return null;
  return {
    provider: config.id,
    label: config.label,
    model: config.configuredModel ?? (config.id === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : null),
  };
}

/** The default provider, its default model and a client, or null when no AI is configured. */
export async function resolveDefaultAi(
  options: ClientOptions & { env?: Env } = {},
): Promise<ResolvedAi | null> {
  const config = defaultProvider(options.env);
  if (!config) return null;
  const listed =
    config.configuredModel || config.id === "anthropic"
      ? []
      : await listProviderModels(config, options);
  return {
    provider: config.id,
    label: config.label,
    model: pickDefaultModel(config, listed),
    client: createModelClient(config, options),
  };
}

export type ChoiceResult =
  | { ok: true; ai: ResolvedAi }
  | { ok: false; code: "provider_unavailable" | "model_unavailable"; message: string };

/**
 * An explicit choice, checked against the configured providers and that provider's listed models
 * (or its default). With no provider the default provider is used; with no model, its default.
 */
export async function resolveAiChoice(
  choice: { provider?: string; model?: string },
  options: ClientOptions & { env?: Env } = {},
): Promise<ChoiceResult> {
  const providers = aiProviders(options.env);
  const config = choice.provider
    ? providers.find((p) => p.id === choice.provider)
    : defaultProvider(options.env);
  if (!config) {
    return {
      ok: false,
      code: "provider_unavailable",
      message: choice.provider
        ? "That AI provider is not configured on this server."
        : `No AI provider is configured. Set ${AI_KEY_HINT}.`,
    };
  }
  const { models, default: fallback } = await providerModels(config, options);
  const model = choice.model?.trim() || fallback;
  if (!models.some((m) => m.id === model)) {
    return {
      ok: false,
      code: "model_unavailable",
      message: `That model is not available from ${config.label} on this server.`,
    };
  }
  return {
    ok: true,
    ai: {
      provider: config.id,
      label: config.label,
      model,
      client: createModelClient(config, options),
    },
  };
}

export function providerLabel(id: ProviderId): string {
  return SPECS[id].label;
}
