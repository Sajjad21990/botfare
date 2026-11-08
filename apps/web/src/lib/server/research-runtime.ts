import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { schema } from "@botfare/core";
import { createBotFareAgent } from "@botfare/sdk";
import { getDb } from "./db";
import { DEFAULT_MODEL, type ResearchDeps } from "./research-agent";
import { normalizeUrl, type ResearchSite, readTextLimited } from "./research-tools";

/**
 * Wiring for the research agent on this server: the Anthropic client, the demo agent key
 * (BOTFARE_AGENT_KEY, seeded for the agent-owner persona; it never reaches the model or the
 * browser) and the BotFare sites from the database.
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

/** Loopback, private and link-local hosts (IP literals and localhost names). */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (/^(fc|fd|fe80)/.test(host) && host.includes(":")) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Sites the agent may read: one per origin, oldest first. In production, origins on private or
 * loopback hosts are left out (other than the configured demo publisher), so a registered site
 * cannot point the server at its own network.
 */
export function selectSites(
  rows: { id: string; name: string; origin: string; createdAt: Date }[],
  options: { production: boolean; trustedOrigins: string[] },
): ResearchSite[] {
  const trusted = new Set(
    options.trustedOrigins.flatMap((value) => {
      const url = normalizeUrl(value);
      return url ? [new URL(url).origin] : [];
    }),
  );
  const seen = new Set<string>();
  const sites: ResearchSite[] = [];
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const url = normalizeUrl(row.origin);
    if (!url) continue;
    const parsed = new URL(url);
    if (seen.has(parsed.origin)) continue;
    if (options.production && isPrivateHost(parsed.hostname) && !trusted.has(parsed.origin)) {
      continue;
    }
    seen.add(parsed.origin);
    sites.push({ id: row.id, name: row.name, origin: parsed.origin });
    if (sites.length >= MAX_SITES) break;
  }
  return sites;
}

async function loadSites(): Promise<ResearchSite[]> {
  const rows = await getDb()
    .select({
      id: schema.sites.id,
      name: schema.sites.name,
      origin: schema.sites.origin,
      createdAt: schema.sites.createdAt,
    })
    .from(schema.sites);
  return selectSites(rows, {
    production: process.env.NODE_ENV === "production",
    trustedOrigins: [process.env.DEMO_ORIGIN ?? ""].filter(Boolean),
  });
}

async function fetchCatalog(site: ResearchSite, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${site.origin}/catalog.json`, {
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

export function createResearchDeps(config: Extract<ResearchConfig, { ok: true }>): ResearchDeps {
  return {
    client: new Anthropic({ apiKey: config.apiKey, maxRetries: 1, timeout: 60_000 }),
    model: config.model,
    createAgent: ({ maxPerRequestCents, onWire }) =>
      createBotFareAgent({
        agentKey: config.agentKey,
        maxPerRequestUsd: maxPerRequestCents / 100,
        onWire,
      }),
    loadSites,
    fetchCatalog,
  };
}
