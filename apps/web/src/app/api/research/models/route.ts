import { aiProviders, defaultProvider, providerModels } from "../../../../lib/server/ai/providers";
import { requireApiUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The AI providers configured on this server and their chat models, for the research agent's
 * picker: `{ providers: [{ provider, label, models: [{ id, free? }], default }], default }`.
 * Never keys. Model lists are cached for ten minutes; a provider whose list cannot be read shows
 * only its default model.
 */
export async function GET(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const configs = aiProviders();
  const providers = await Promise.all(configs.map((config) => providerModels(config)));
  const fallback = defaultProvider();
  const chosen = providers.find((p) => p.provider === fallback?.id);
  return Response.json(
    {
      providers,
      default: chosen ? { provider: chosen.provider, model: chosen.default } : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
