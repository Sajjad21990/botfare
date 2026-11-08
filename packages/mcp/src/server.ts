/**
 * BotFare MCP server (stdio) for Claude Desktop and Claude Code.
 *
 *   BOTFARE_AGENT_KEY   required: the bfk_... agent key from the BotFare wallet page
 *   BOTFARE_URL         BotFare app URL (default http://localhost:3000)
 *   BOTFARE_MAX_PRICE_USD  optional: fetch_paid's ceiling when no max_price_usd is given and the
 *                       key has no per-request max (default 0.10)
 *
 * stdout carries the MCP protocol, so everything else (logs, warnings) goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBotFareMcpServer } from "./tools";

function log(message: string): void {
  process.stderr.write(`[botfare-mcp] ${message}\n`);
}

// Anything a dependency prints must not corrupt the protocol stream.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

function fail(message: string): never {
  log(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const agentKey = process.env.BOTFARE_AGENT_KEY?.trim();
  if (!agentKey) {
    fail(
      "BOTFARE_AGENT_KEY is not set. Create an agent key on the BotFare wallet page and pass it in the MCP server's env.",
    );
  }
  const botfareUrl = process.env.BOTFARE_URL?.trim() || "http://localhost:3000";
  try {
    new URL(botfareUrl);
  } catch {
    fail(`BOTFARE_URL must be an absolute URL, got ${JSON.stringify(botfareUrl)}`);
  }
  // The SDK reads BOTFARE_URL for Signature-Agent; keep it in step with the default.
  process.env.BOTFARE_URL = botfareUrl;

  let defaultMaxPriceUsd: number | undefined;
  const rawMax = process.env.BOTFARE_MAX_PRICE_USD?.trim();
  if (rawMax) {
    defaultMaxPriceUsd = Number(rawMax);
    if (!Number.isFinite(defaultMaxPriceUsd) || defaultMaxPriceUsd < 0.01) {
      fail(`BOTFARE_MAX_PRICE_USD must be a dollar amount of at least 0.01, got ${rawMax}`);
    }
  }

  let server: ReturnType<typeof createBotFareMcpServer>;
  try {
    server = createBotFareMcpServer({
      agentKey,
      botfareUrl,
      log,
      ...(defaultMaxPriceUsd !== undefined ? { defaultMaxPriceUsd } : {}),
    });
  } catch (err) {
    // Key errors never quote the key.
    fail((err as Error).message);
  }
  await server.connect(new StdioServerTransport());
  log(`ready: BotFare at ${new URL(botfareUrl).origin}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
