import "server-only";
import { isDemoPersonaEmail } from "@botfare/contracts";
import { schema } from "@botfare/core";
import { createBotFareAgent } from "@botfare/sdk";
import { AI_KEY_HINT, defaultModelHint, type ProviderId, type ResolvedAi } from "./ai/providers";
import { getDb } from "./db";
import { createRewritingFetch, demoOriginRewrite, demoPublicOrigin } from "./demo-origin";
import { refillDemoAgentWallet } from "./judge";
import { createGuardedFetch, isPrivateHostname } from "./outbound-guard";
import type { ResearchDeps } from "./research-agent";
import { normalizeUrl, type ResearchSite, readTextLimited } from "./research-tools";

/**
 * Wiring for the research agent on this server: the model client (./ai/providers: Claude by
 * default, or the provider and model the owner picked), the demo agent key
 * (BOTFARE_AGENT_KEY, seeded for the agent-owner persona; it never reaches the model or the
 * browser) and the BotFare sites it may read (the demo publisher, plus a real user's own sites).
 * Requests for the demo's public origin go to DEMO_INTERNAL_URL when it is set
 * (lib/server/demo-origin: the judge Docker stack); every request goes through the outbound guard.
 *
 * Fare Court disputes, decline notes and citation reports go to this app's own agent API
 * (BOTFARE_URL, else RENDER_EXTERNAL_URL), signed with the same key, through the plain fetch: that
 * URL comes from configuration, never from the model or a publisher. Without it they are skipped
 * (disputes fail with a message; notes are best effort).
 */

const MAX_SITES = 10;
const CATALOG_TIMEOUT_MS = 5_000;
const MAX_CATALOG_BYTES = 512_000;

/** What `missing` lists when no AI provider is configured. */
export const MISSING_AI_KEY = "AI provider key";

export type ResearchConfig =
  | {
      ok: true;
      agentKey: string;
      /** The default provider, and its model when known without listing models. */
      provider: ProviderId;
      model: string | null;
    }
  | { ok: false; missing: string[] };

export function researchConfig(): ResearchConfig {
  const ai = defaultModelHint();
  const agentKey = process.env.BOTFARE_AGENT_KEY?.trim();
  const missing = [...(ai ? [] : [MISSING_AI_KEY]), ...(agentKey ? [] : ["BOTFARE_AGENT_KEY"])];
  if (!ai || !agentKey) return { ok: false, missing };
  return { ok: true, agentKey, provider: ai.provider, model: ai.model };
}

export function missingConfigMessage(missing: string[]): string {
  const names = missing.map((name) => (name === MISSING_AI_KEY ? AI_KEY_HINT : name));
  return `The research agent needs ${names.join(" and ")} on the server. Set ${missing.length > 1 ? "them" : "it"} in .env (pnpm seed writes BOTFARE_AGENT_KEY) and restart the app.`;
}

/** Where the seed registers the demo site when DEMO_ORIGIN is not set (local development only). */
const LOCAL_DEMO_ORIGIN = "http://localhost:4000";

/**
 * The demo publisher's origins: DEMO_ORIGIN (what the seed registers) and DEMO_PUBLIC_URL, or the
 * seed's local default outside production when neither is set.
 */
export function researchTrustedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configured = [env.DEMO_ORIGIN?.trim() ?? "", demoPublicOrigin(env) ?? ""].filter(Boolean);
  if (configured.length > 0) return configured;
  return env.NODE_ENV === "production" ? [] : [LOCAL_DEMO_ORIGIN];
}

/** Who is asking: their own sites are readable too, unless they are a shared judge persona. */
export interface ResearchViewer {
  userId: string;
  email: string;
}

/**
 * Sites the agent may read: the demo publisher (sites at a trusted origin) and, for a signed-in
 * user with their own account, that user's own sites; never sites other people registered, so a
 * site added through the shared publisher persona does not reach every judge's research run. One
 * per origin, oldest first. In production, own sites on private or loopback hosts are left out
 * (the guarded fetch also checks what every name resolves to); the trusted demo origin may be on
 * a private network (the judge Docker stack) and is reached as configured.
 */
export function selectSites(
  rows: { id: string; name: string; origin: string; createdAt: Date; ownerUserId?: string }[],
  options: { production: boolean; trustedOrigins: string[]; viewer?: ResearchViewer | null },
): ResearchSite[] {
  const trusted = new Set(
    options.trustedOrigins.flatMap((value) => {
      const url = normalizeUrl(value);
      return url ? [new URL(url).origin] : [];
    }),
  );
  const ownerId =
    options.viewer && !isDemoPersonaEmail(options.viewer.email) ? options.viewer.userId : null;
  const seen = new Set<string>();
  const sites: ResearchSite[] = [];
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const url = normalizeUrl(row.origin);
    if (!url) continue;
    const parsed = new URL(url);
    if (seen.has(parsed.origin)) continue;
    const isTrusted = trusted.has(parsed.origin);
    if (!isTrusted && (ownerId === null || row.ownerUserId !== ownerId)) continue;
    if (options.production && !isTrusted && isPrivateHostname(parsed.hostname)) continue;
    seen.add(parsed.origin);
    sites.push({ id: row.id, name: row.name, origin: parsed.origin });
    if (sites.length >= MAX_SITES) break;
  }
  return sites;
}

async function loadSites(viewer: ResearchViewer | null): Promise<ResearchSite[]> {
  const rows = await getDb()
    .select({
      id: schema.sites.id,
      name: schema.sites.name,
      origin: schema.sites.origin,
      createdAt: schema.sites.createdAt,
      ownerUserId: schema.sites.ownerUserId,
    })
    .from(schema.sites);
  return selectSites(rows, {
    production: process.env.NODE_ENV === "production",
    trustedOrigins: researchTrustedOrigins(),
    viewer,
  });
}

/** GET <origin>/catalog.json with a size and time limit, through `fetchImpl`. */
export async function fetchCatalogWith(
  fetchImpl: typeof fetch,
  site: ResearchSite,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(`${site.origin}/catalog.json`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(await readTextLimited(response, MAX_CATALOG_BYTES));
}

/** A run's configuration: the agent key and the resolved provider, model and client. */
export interface ResearchRunConfig {
  agentKey: string;
  ai: ResolvedAi;
}

export function createResearchDeps(
  config: ResearchRunConfig,
  viewer: ResearchViewer | null = null,
): ResearchDeps {
  // Server-side only: the model and the browser keep seeing the public URLs. Every request is
  // checked against the registered origin (no redirects, no private addresses in production)
  // before the demo's public origin is mapped to DEMO_INTERNAL_URL.
  const ownUrl =
    process.env.BOTFARE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || undefined;
  const serverFetch = createGuardedFetch(createRewritingFetch(demoOriginRewrite()), {
    checkAddresses: process.env.NODE_ENV === "production",
    trustedOrigins: researchTrustedOrigins(),
  });
  return {
    client: config.ai.client,
    model: config.ai.model,
    provider: config.ai.provider,
    createAgent: ({ maxPerRequestCents, onWire }) =>
      createBotFareAgent({
        agentKey: config.agentKey,
        maxPerRequestUsd: maxPerRequestCents / 100,
        onWire,
        fetch: serverFetch,
        ...(ownUrl ? { botfareUrl: ownUrl } : {}),
        botfareFetch: globalThis.fetch,
      }),
    loadSites: () => loadSites(viewer),
    prepare: () => refillDemoAgentWallet(config.agentKey),
    fetchCatalog: (site, signal) => fetchCatalogWith(serverFetch, site, signal),
  };
}
