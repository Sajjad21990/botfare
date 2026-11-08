import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { isDemoPersonaEmail } from "@botfare/contracts";
import { schema } from "@botfare/core";
import { createBotFareAgent } from "@botfare/sdk";
import { getDb } from "./db";
import { createRewritingFetch, demoOriginRewrite, demoPublicOrigin } from "./demo-origin";
import { createGuardedFetch, isPrivateHostname } from "./outbound-guard";
import { DEFAULT_MODEL, type ResearchDeps } from "./research-agent";
import { normalizeUrl, type ResearchSite, readTextLimited } from "./research-tools";

/**
 * Wiring for the research agent on this server: the Anthropic client, the demo agent key
 * (BOTFARE_AGENT_KEY, seeded for the agent-owner persona; it never reaches the model or the
 * browser) and the BotFare sites it may read (the demo publisher, plus a real user's own sites).
 * Requests for the demo's public origin go to DEMO_INTERNAL_URL when it is set
 * (lib/server/demo-origin: the judge Docker stack); every request goes through the outbound guard.
 */

const MAX_SITES = 10;
const CATALOG_TIMEOUT_MS = 5_000;
const MAX_CATALOG_BYTES = 512_000;

export type ResearchConfig =
  | { ok: true; apiKey: string; agentKey: string; model: string }
  | { ok: false; missing: string[] };

export function researchConfig(): ResearchConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const agentKey = process.env.BOTFARE_AGENT_KEY?.trim();
  const missing = [
    ...(apiKey ? [] : ["ANTHROPIC_API_KEY"]),
    ...(agentKey ? [] : ["BOTFARE_AGENT_KEY"]),
  ];
  if (!apiKey || !agentKey) return { ok: false, missing };
  return {
    ok: true,
    apiKey,
    agentKey,
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export function missingConfigMessage(missing: string[]): string {
  const names = missing.join(" and ");
  return `The research agent needs ${names} on the server. Set ${missing.length > 1 ? "them" : "it"} in .env (pnpm seed writes BOTFARE_AGENT_KEY) and restart the app.`;
}

/** Where the seed registers Crema Notes when DEMO_ORIGIN is not set (local development only). */
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

export function createResearchDeps(
  config: Extract<ResearchConfig, { ok: true }>,
  viewer: ResearchViewer | null = null,
): ResearchDeps {
  // Server-side only: the model and the browser keep seeing the public URLs. Every request is
  // checked against the registered origin (no redirects, no private addresses in production)
  // before the demo's public origin is mapped to DEMO_INTERNAL_URL.
  const serverFetch = createGuardedFetch(createRewritingFetch(demoOriginRewrite()), {
    checkAddresses: process.env.NODE_ENV === "production",
    trustedOrigins: researchTrustedOrigins(),
  });
  return {
    client: new Anthropic({ apiKey: config.apiKey, maxRetries: 1, timeout: 60_000 }),
    model: config.model,
    createAgent: ({ maxPerRequestCents, onWire }) =>
      createBotFareAgent({
        agentKey: config.agentKey,
        maxPerRequestUsd: maxPerRequestCents / 100,
        onWire,
        fetch: serverFetch,
      }),
    loadSites: () => loadSites(viewer),
    fetchCatalog: (site, signal) => fetchCatalogWith(serverFetch, site, signal),
  };
}
