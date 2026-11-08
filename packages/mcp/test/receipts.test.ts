import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBotFareMcpServer } from "../src/tools";
import { RECEIPT_KID, SITE_ID, startStack } from "./harness";

/** Signed receipts in the MCP tools: fetch_paid shows and checks the receipt; verify_receipt. */

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

function receiptIdIn(text: string): string {
  const match = /Receipt: (rcpt_[0-9a-f]+)/.exec(text);
  if (!match?.[1]) throw new Error(`no receipt in ${text}`);
  return match[1];
}

beforeAll(async () => {
  stack = await startStack({ signReceipts: true });
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

describe("signed receipts in the MCP tools", () => {
  let receiptId = "";
  let statement = "";

  it("fetch_paid returns the signed receipt with a one-line signature check", async () => {
    const url = `${stack.siteUrl}/articles/water-temperature`;
    const result = await call("fetch_paid", { url, max_price_usd: 0.03 });
    expect(result.isError).toBe(false);
    receiptId = receiptIdIn(result.text);
    statement = stack.statements.get(receiptId)?.payment ?? "";
    expect(statement).not.toBe("");
    expect(result.text).toContain(
      `Signed receipt (BotFare payment statement, Ed25519 JWS): ${statement}`,
    );
    expect(result.text).toMatch(
      new RegExp(
        `Signature check: verified, signed by BotFare key ${RECEIPT_KID}: \\$0\\.03 paid to ${SITE_ID}`,
      ),
    );
    expect(result.text).toContain("publisher $0.0285, BotFare fee $0.0015");
  });

  it("verify_receipt by receipt ID lists the statements, and checks the bytes read once attested", async () => {
    const before = await call("verify_receipt", { receipt_id: receiptId });
    expect(before.isError).toBe(false);
    expect(before.text).toContain(`Statements BotFare holds for ${receiptId}:`);
    expect(before.text).toMatch(/- payment: verified, signed by BotFare key rk_mcptest/);
    expect(before.text).toMatch(/- delivery: none yet/);
    expect(before.text).toMatch(/- refund: none/);
    expect(before.text).toContain("Verified claims:");
    expect(before.text).toContain(`"sub":"${receiptId}"`);

    await stack.attest(receiptId, stack.articleHtml);
    const after = await call("verify_receipt", { receipt_id: receiptId });
    expect(after.text).toMatch(/- delivery: verified, signed by BotFare key rk_mcptest: HTTP 200/);
    expect(after.text).toContain("The bytes this server read match the attested digest.");

    await stack.attest(receiptId, "<p>something else</p>");
    const changed = await call("verify_receipt", { receipt_id: receiptId });
    expect(changed.text).toMatch(/differ from the attested digest/);
  });

  it("verify_receipt checks a statement it is given, and flags a forged one", async () => {
    const good = await call("verify_receipt", { statement });
    expect(good.isError).toBe(false);
    expect(good.text).toMatch(new RegExp(`Given payment statement for ${receiptId}: verified`));

    const [header, payload, signature] = statement.split(".");
    const claims = JSON.parse(Buffer.from(payload as string, "base64url").toString());
    claims.payment.amountMicros = 1;
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    const bad = await call("verify_receipt", { statement: forged });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/NOT verified \(bad_signature\)/);
    expect(bad.text).toMatch(/UNVERIFIED/);
  });

  it("verify_receipt reports an unknown receipt and needs an argument", async () => {
    const unknown = await call("verify_receipt", { receipt_id: "rcpt_ffffffffffffffff" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/no statements for rcpt_ffffffffffffffff/);
    const empty = await call("verify_receipt", {});
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/Pass receipt_id/);
  });

  it("logs never contain the agent key", () => {
    expect(logs.some((line) => line.includes("signed receipt verified"))).toBe(true);
    expect(logs.join("\n")).not.toContain(stack.agentKey);
  });
});
