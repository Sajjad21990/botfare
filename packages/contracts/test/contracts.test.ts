import { describe, expect, it } from "vitest";
import {
  decodeAgentKey,
  encodeAgentKey,
  findPricingRule,
  isKnownAiBot,
  newId,
  parseSiteAuthHeader,
  siteAuthHeader,
  siteConfigSchema,
} from "../src";

describe("contracts", () => {
  it("makes prefixed IDs", () => {
    expect(newId("site")).toMatch(/^site_[0-9a-f]{16}$/);
  });

  it("round-trips site auth headers", () => {
    const header = siteAuthHeader("site_abc", "s3cret:with:colons");
    expect(parseSiteAuthHeader(header)).toEqual({
      siteId: "site_abc",
      siteSecret: "s3cret:with:colons",
    });
    expect(parseSiteAuthHeader("Bearer x")).toBeNull();
    expect(parseSiteAuthHeader(undefined)).toBeNull();
  });

  it("round-trips agent keys", () => {
    const payload = {
      v: 1 as const,
      keyId: "ak_123",
      privateJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "pub", d: "priv" },
    };
    expect(decodeAgentKey(encodeAgentKey(payload))).toEqual(payload);
    expect(() => decodeAgentKey("nope")).toThrow();
  });

  it("matches pricing rules, honouring free paths and methods", () => {
    const config = siteConfigSchema.parse({
      siteId: "site_x",
      name: "Demo",
      origin: "https://demo.example",
      network: "paypal:sandbox",
      pricing: [
        { pattern: "/articles/premium-*", priceCents: 50 },
        { pattern: "/articles/*", priceCents: 3 },
        { pattern: "/api/brew-ratio", priceCents: 1, audience: "everyone" },
      ],
      freePaths: ["/articles/index"],
      version: "1",
    });
    expect(findPricingRule(config, "GET", "/articles/premium-roundup")?.priceCents).toBe(50);
    expect(findPricingRule(config, "get", "/articles/burr-basics")?.priceCents).toBe(3);
    expect(findPricingRule(config, "GET", "/articles/index")).toBeUndefined();
    expect(findPricingRule(config, "POST", "/articles/burr-basics")).toBeUndefined();
    expect(findPricingRule(config, "GET", "/api/brew-ratio")?.audience).toBe("everyone");
  });

  it("recognizes known AI bots", () => {
    expect(isKnownAiBot("Mozilla/5.0 (compatible; GPTBot/1.2)")).toBe(true);
    expect(isKnownAiBot("Mozilla/5.0 (Macintosh) Safari/605")).toBe(false);
  });
});
