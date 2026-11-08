import { encodeAgentKey } from "@botfare/contracts";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlToText } from "../src/text";
import { createBotFareMcpServer, spendCap } from "../src/tools";
import { ARTICLE_PREVIEW, SITE_ID, startStack } from "./harness";

let stack: Awaited<ReturnType<typeof startStack>>;
let client: Client;
const logs: string[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join("\n") };
}

beforeAll(async () => {
  stack = await startStack();
  const server = createBotFareMcpServer({
    agentKey: stack.agentKey,
    botfareUrl: stack.botfareUrl,
    log: (message) => logs.push(message),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
  await stack?.stop();
});

describe("BotFare MCP server", () => {
  it("lists four tools and tells Claude to check the offer first", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "fetch_paid",
      "get_offer",
      "recent_receipts",
      "wallet_balance",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_offer?.description).toMatch(/Never pays/);
    expect(byName.fetch_paid?.description).toMatch(/Call get_offer first/);
    expect(byName.get_offer?.annotations?.readOnlyHint).toBe(true);
    expect(byName.fetch_paid?.inputSchema.properties).toHaveProperty("max_price_usd");
    expect(client.getInstructions()).toMatch(/call get_offer first/);
  });

  it("get_offer returns the price and preview without paying", async () => {
    const before = stack.walletMicros();
    const result = await call("get_offer", { url: `${stack.siteUrl}/articles/water-temperature` });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Price: $0.03");
    expect(result.text).toContain(`site ${SITE_ID}`);
    expect(result.text).toContain(`Title: ${ARTICLE_PREVIEW.title}`);
    expect(result.text).toContain(ARTICLE_PREVIEW.excerpt);
    expect(result.text).toContain("max_price_usd 0.03");
    expect(stack.walletMicros()).toBe(before);
    expect(stack.ledger.receipts).toHaveLength(0);
    expect(stack.paymentsSeen).toHaveLength(0);
  });

  it("get_offer flags a price over the key's per-request max", async () => {
    const result = await call("get_offer", { url: `${stack.siteUrl}/reports/annual` });
    expect(result.text).toContain("Price: $0.25");
    expect(result.text).toMatch(/Over your limits: this key's per-request max \(\$0\.05\)/);
  });

  it("get_offer says when a page is free, and rejects non-http URLs", async () => {
    expect((await call("get_offer", { url: `${stack.siteUrl}/free` })).text).toMatch(
      /did not ask for payment/,
    );
    const bad = await call("get_offer", { url: "file:///etc/passwd" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Only http\(s\) URLs/);
  });

  it("fetch_paid refuses a price above max_price_usd without signing a payment", async () => {
    const result = await call("fetch_paid", {
      url: `${stack.siteUrl}/articles/water-temperature`,
      max_price_usd: 0.02,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/costs \$0\.03, above your max_price_usd: \$0\.02/);
    expect(result.text).toMatch(/Nothing was signed or paid/);
    expect(stack.paymentsSeen).toHaveLength(0);
    expect(stack.ledger.receipts).toHaveLength(0);
  });

  it("fetch_paid refuses a price above the key's per-request max even with a higher max_price_usd", async () => {
    const result = await call("fetch_paid", {
      url: `${stack.siteUrl}/reports/annual`,
      max_price_usd: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/above this key's per-request max/);
    expect(stack.paymentsSeen).toHaveLength(0);
  });

  it("fetch_paid pays within the limits and returns readable text with the receipt", async () => {
    const before = stack.walletMicros();
    const result = await call("fetch_paid", {
      url: `${stack.siteUrl}/articles/water-temperature`,
      max_price_usd: 0.03,
    });
    expect(result.isError).toBe(false);
    const receipt = stack.ledger.receipts[0];
    expect(receipt).toBeDefined();
    expect(result.text).toContain(`Paid $0.03 to site ${SITE_ID}`);
    expect(result.text).toContain(`Receipt: ${receipt?.transaction}`);
    expect(result.text).toContain("# Water temperature for pour-over");
    expect(result.text).toContain("Brew between 92 °C and 96 °C & adjust by roast.");
    expect(result.text).toContain("- Light roasts: hotter");
    expect(result.text).not.toContain("tracking");
    expect(result.text).not.toContain("<p>");
    expect(before - stack.walletMicros()).toBe(30_000);
    expect(stack.paymentsSeen).toEqual(["/articles/water-temperature"]);
  });

  it("fetch_paid without max_price_usd uses the key's limits and pretty-prints JSON", async () => {
    const result = await call("fetch_paid", { url: `${stack.siteUrl}/api/brew-ratio` });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Paid $0.01");
    expect(result.text).toContain('"ratio": "1:16"');
    expect(stack.ledger.receipts).toHaveLength(2);
  });

  it("fetch_paid refuses once the daily cap is nearly used up", async () => {
    // Spent 4 cents of 8: one more 3-cent article fits, the next does not.
    expect(
      (await call("fetch_paid", { url: `${stack.siteUrl}/articles/water-temperature` })).isError,
    ).toBe(false);
    const paymentsBefore = stack.paymentsSeen.length;
    const result = await call("fetch_paid", {
      url: `${stack.siteUrl}/articles/water-temperature`,
      max_price_usd: 0.05,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /above what is left of this key's daily cap \(\$0\.01 of \$0\.08\)/,
    );
    expect(stack.paymentsSeen).toHaveLength(paymentsBefore);
    expect(stack.ledger.receipts).toHaveLength(3);
  });

  it("fetch_paid reads a free page without paying", async () => {
    const result = await call("fetch_paid", { url: `${stack.siteUrl}/free` });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/No payment needed \(HTTP 200\)/);
    expect(result.text).toContain("# Free page");
    expect(stack.ledger.receipts).toHaveLength(3);
  });

  it("wallet_balance shows the balance, today's spend and the limits", async () => {
    const result = await call("wallet_balance");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Agent key: research agent (ak_mcptest)");
    expect(result.text).toContain("Wallet balance: $0.93");
    expect(result.text).toContain("Spent today: $0.07 of a $0.08 daily cap ($0.01 left");
    expect(result.text).toContain("Per-request max: $0.05");
    expect(result.text).toContain("Allowed sites: any");
  });

  it("recent_receipts lists payments newest first with receipt IDs", async () => {
    const result = await call("recent_receipts", { limit: 2 });
    expect(result.isError).toBe(false);
    const [newest, previous] = [...stack.ledger.receipts].reverse();
    const lines = result.text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(newest?.transaction);
    expect(lines[0]).toContain("$0.03");
    expect(lines[0]).toContain("Crema Notes");
    expect(lines[1]).toContain(previous?.transaction);
    expect(lines[1]).toContain("$0.01");
  });

  it("signs agent API requests (the stand-in API verified every one) and logs without the key", () => {
    expect(stack.apiRequests()).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(stack.agentKey);
    expect(logs.some((line) => line.includes("fetch_paid") && line.includes("rcpt_"))).toBe(true);
  });
});

describe("agent API errors", () => {
  it("reports a BotFare 401 as a tool error", async () => {
    // A server whose key BotFare does not know: the stand-in answers 401.
    const stranger = await generateAgentKeyPair();
    const agentKey = encodeAgentKey({
      v: 1,
      keyId: "ak_stranger",
      privateJwk: stranger.privateJwk as { kty: "OKP"; crv: "Ed25519"; x: string; d: string },
    });
    const server = createBotFareMcpServer({
      agentKey,
      botfareUrl: stack.botfareUrl,
      log: () => {},
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const other = new Client({ name: "test", version: "0.0.0" });
    await other.connect(a);
    const result = (await other.callTool({ name: "wallet_balance", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/BotFare refused \/api\/agent\/wallet: Unknown keyid/);
    await other.close();
  });

  it("refuses to start with a malformed agent key", () => {
    expect(() =>
      createBotFareMcpServer({ agentKey: "bfk_nope", botfareUrl: stack.botfareUrl }),
    ).toThrow(/could not decode/);
  });
});

describe("helpers", () => {
  it("spendCap takes the tightest limit", () => {
    const wallet = {
      keyId: "ak_x",
      keyName: "x",
      balanceUsd: 0.05,
      spentTodayUsd: 0.5,
      dailyCapUsd: 1,
      perRequestMaxUsd: 0.25,
    };
    expect(spendCap(wallet, 0.1, 0.1)).toMatchObject({ cents: 5, reason: /wallet balance/ });
    expect(spendCap({ ...wallet, balanceUsd: 10 }, 0.1, 0.1)).toMatchObject({ cents: 10 });
    expect(spendCap({ ...wallet, balanceUsd: 10 }, undefined, 0.1)).toMatchObject({ cents: 25 });
    expect(
      spendCap({ ...wallet, balanceUsd: 10, perRequestMaxUsd: null }, undefined, 0.1),
    ).toMatchObject({ cents: 10, reason: /default price ceiling/ });
    expect(spendCap(null, undefined, 0.1)).toMatchObject({ cents: 10 });
    expect(spendCap({ ...wallet, balanceUsd: 10, spentTodayUsd: 0.71 }, 1, 0.1)).toMatchObject({
      cents: 25,
    });
    expect(spendCap({ ...wallet, balanceUsd: 10, spentTodayUsd: 0.9 }, 1, 0.1)).toMatchObject({
      cents: 10,
      reason: /daily cap/,
    });
  });

  it("htmlToText keeps structure and drops markup", () => {
    expect(
      htmlToText("<h2>Grind</h2><p>Fine &lt;-&gt; coarse</p><script>x()</script><br>end"),
    ).toBe("## Grind\n\nFine <-> coarse\n\nend");
  });
});
