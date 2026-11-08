import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack } from "./harness";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsx = `${repoRoot}node_modules/.bin/tsx`;
const serverPath = fileURLToPath(new URL("../src/server.ts", import.meta.url));

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

describe("stdio server (as Claude Desktop / Claude Code start it)", () => {
  it("speaks MCP on stdout, configured by BOTFARE_AGENT_KEY and BOTFARE_URL", async () => {
    const transport = new StdioClientTransport({
      command: tsx,
      args: [serverPath],
      env: {
        PATH: process.env.PATH ?? "",
        BOTFARE_AGENT_KEY: stack.agentKey,
        BOTFARE_URL: stack.botfareUrl,
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("fetch_paid");

      const offer = (await client.callTool({
        name: "get_offer",
        arguments: { url: `${stack.siteUrl}/articles/water-temperature` },
      })) as { content: { text: string }[] };
      expect(offer.content[0]?.text).toContain("Price: $0.03");

      const paid = (await client.callTool({
        name: "fetch_paid",
        arguments: { url: `${stack.siteUrl}/articles/water-temperature`, max_price_usd: 0.03 },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(paid.isError).toBeFalsy();
      expect(paid.content[0]?.text).toMatch(/Receipt: rcpt_/);
      expect(stack.ledger.receipts).toHaveLength(1);
    } finally {
      await client.close();
    }
    expect(stderr).toContain("[botfare-mcp] ready");
    expect(stderr).not.toContain(stack.agentKey);
  }, 30_000);

  it("exits with a clear message when BOTFARE_AGENT_KEY is missing", async () => {
    const transport = new StdioClientTransport({
      command: tsx,
      args: [serverPath],
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => {});
    expect(stderr).toContain("BOTFARE_AGENT_KEY is not set");
  }, 30_000);
});
