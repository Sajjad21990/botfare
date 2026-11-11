import { describe, expect, it } from "vitest";
import {
  formatCap,
  formatCents,
  formatMicros,
  formatMoney,
  formatMoneyExact,
} from "../src/components/wallet/format";
import { agentEnvBlock, agentUsageSnippet } from "../src/components/wallet/snippets";

describe("formatMoney", () => {
  it("shows amounts under a dollar in cents", () => {
    expect(formatMoney(30_000)).toBe("3¢");
    expect(formatMoney(500_000)).toBe("50¢");
    expect(formatMoney(994_999)).toBe("99¢");
  });

  it("shows dollar amounts with two decimals", () => {
    expect(formatMoney(1_000_000)).toBe("$1.00");
    expect(formatMoney(2_040_000)).toBe("$2.04");
    expect(formatMoney(1_406_000)).toBe("$1.41");
    expect(formatMoney(995_000)).toBe("$1.00");
    expect(formatMoney(12_345_670_000)).toBe("$12,345.67");
  });

  it("reads nothing as $0.00, a sliver as <1¢, and keeps the sign", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(1_500)).toBe("<1¢");
    expect(formatMoney(-30_000)).toBe("-3¢");
    expect(formatMoney(-2_500_000)).toBe("-$2.50");
  });

  it("gives the exact figure for a tooltip", () => {
    expect(formatMoneyExact(1_406_000)).toBe("$1.406");
    expect(formatMoneyExact(28_500)).toBe("$0.0285");
    expect(formatMoneyExact(2_000_000)).toBe("$2.00");
  });

  it("leaves the older helpers as they were", () => {
    expect(formatMicros(1_500)).toBe("$0.0015");
    expect(formatMicros(30_000)).toBe("$0.03");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCap(10)).toBe("10¢");
    expect(formatCap(150)).toBe("$1.50");
  });
});

describe("agent key snippets", () => {
  it("puts the key and this app's URL in the .env block", () => {
    expect(agentEnvBlock({ agentKey: "bfk_abc", botfareUrl: "https://botfare.example" })).toBe(
      "BOTFARE_AGENT_KEY=bfk_abc\nBOTFARE_URL=https://botfare.example\n",
    );
  });

  it("uses the SDK's real option names and a per-page limit", () => {
    const code = agentUsageSnippet({
      maxPerRequestCents: 5,
      exampleOrigin: "http://localhost:4000/",
    });
    expect(code).toContain('import { createBotFareAgent } from "@botfare/sdk";');
    expect(code).toContain("agentKey: process.env.BOTFARE_AGENT_KEY!");
    expect(code).toContain("maxPerRequestUsd: 0.05, // never more than 5¢ a page");
    expect(code).toContain('agent.fetch("http://localhost:4000/articles/burr-basics")');
    expect(code).toContain("{ response, paid, receiptId }");
    expect(code).not.toMatch(/npm i/);
  });

  it("defaults to a 10¢ limit and the example site", () => {
    const code = agentUsageSnippet();
    expect(code).toContain("maxPerRequestUsd: 0.10");
    expect(code).toContain("https://crema-notes.example/articles/burr-basics");
    expect(agentUsageSnippet({ maxPerRequestCents: 150 })).toContain(
      "never more than $1.50 a page",
    );
  });
});
