/** Copy-paste snippets for using an agent key with @botfare/sdk (browser-safe, no secrets kept). */

/** Where the SDK comes from today: the packages are not published to npm yet. */
export const SDK_SOURCE_URL = "https://github.com/Sajjad21990/botfare#run-it-locally";

const EXAMPLE_ORIGIN = "https://saffron-and-salt.example";
const EXAMPLE_PATH = "/recipes/weeknight-red-lentil-dal";

/** The agent's .env: its key and this BotFare app's URL (the SDK reads both). */
export function agentEnvBlock({
  agentKey,
  botfareUrl,
}: {
  agentKey: string;
  botfareUrl: string;
}): string {
  return `BOTFARE_AGENT_KEY=${agentKey}\nBOTFARE_URL=${botfareUrl}\n`;
}

/**
 * A short agent.ts: createBotFareAgent with the key and a per-page limit, then one paid fetch.
 * `exampleOrigin` is a BotFare site to fetch from (the demo site when there is one).
 */
export function agentUsageSnippet({
  maxPerRequestCents,
  exampleOrigin,
}: {
  maxPerRequestCents?: number | null;
  exampleOrigin?: string;
} = {}): string {
  const cents = maxPerRequestCents ?? 10;
  const url = `${(exampleOrigin ?? EXAMPLE_ORIGIN).replace(/\/+$/, "")}${EXAMPLE_PATH}`;
  return `import { createBotFareAgent } from "@botfare/sdk";

// BOTFARE_AGENT_KEY and BOTFARE_URL (this app's address) live in .env
const agent = createBotFareAgent({
  agentKey: process.env.BOTFARE_AGENT_KEY!,
  maxPerRequestUsd: ${(cents / 100).toFixed(2)}, // never more than ${cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(2)}`} a page
});

// Pays the page's price from your wallet, and only after the page arrives
const { response, paid, receiptId } = await agent.fetch("${url}");`;
}
