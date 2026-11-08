import { describe, expect, it } from "vitest";
import { moneyToCents, PrepaidPayPalClient, PrepaidPayPalServer, parseAtomicCents } from "../src";
import { requirements } from "./helpers";

describe("money", () => {
  it("parses dollar prices into whole cents", () => {
    expect(moneyToCents("$0.03")).toBe(3);
    expect(moneyToCents("0.5")).toBe(50);
    expect(moneyToCents(0.01)).toBe(1);
    expect(moneyToCents("$12")).toBe(1200);
  });

  it("rejects sub-cent, zero and malformed prices", () => {
    expect(() => moneyToCents("$0.005")).toThrow();
    expect(() => moneyToCents("$0")).toThrow();
    expect(() => moneyToCents("three cents")).toThrow();
    expect(() => parseAtomicCents("0")).toThrow();
    expect(() => parseAtomicCents("1.5")).toThrow();
  });
});

describe("PrepaidPayPalServer", () => {
  const server = new PrepaidPayPalServer();

  it("turns a price into USD cents", async () => {
    expect(await server.parsePrice("$0.03", "paypal:sandbox")).toEqual({
      asset: "USD",
      amount: "3",
    });
  });

  it("caps the authorization lifetime at 60 seconds", async () => {
    const enhanced = await server.enhancePaymentRequirements(
      { ...requirements, maxTimeoutSeconds: 300 },
      { x402Version: 2, scheme: "prepaid", network: "paypal:sandbox" },
      [],
    );
    expect(enhanced.maxTimeoutSeconds).toBe(60);
  });
});

describe("PrepaidPayPalClient", () => {
  it("recognizes USD on PayPal networks for SDK spend controls", () => {
    const client = new PrepaidPayPalClient({ keyId: "ak", privateJwk: {} });
    expect(client.findDefaultAsset("USD", "paypal:sandbox")?.decimals).toBe(2);
    expect(client.findDefaultAsset("USD", "eip155:8453")).toBeUndefined();
  });

  it("refuses to pay other schemes", async () => {
    const client = new PrepaidPayPalClient({ keyId: "ak", privateJwk: {} });
    await expect(
      client.createPaymentPayload(2, { ...requirements, scheme: "exact" }),
    ).rejects.toThrow();
  });
});
