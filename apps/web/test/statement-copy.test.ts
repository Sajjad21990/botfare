import type { PaymentStatement } from "@botfare/contracts/receipts";
import { describe, expect, it } from "vitest";
import { headline } from "../src/components/verify/statement-copy";

const payment = (resource: string | null): PaymentStatement => ({
  iss: "https://botfare.example",
  sub: "rcpt_1",
  iat: 1_794_000_000,
  v: 1,
  kind: "payment",
  payment: {
    scheme: "prepaid",
    network: "paypal:sandbox",
    asset: "USD",
    amount: "3",
    amountMicros: 30_000,
    publisherMicros: 28_500,
    feeMicros: 1_500,
    payTo: "site_1",
    siteOrigin: "https://crema.example",
    resource,
    payer: "ak_1",
    payerThumbprint: null,
    signal: null,
    offerDigest: null,
    settledAt: "2026-11-09T10:00:00.000Z",
  },
});

describe("/verify headline", () => {
  it("names the path on the paid site, and the full host when the resource is elsewhere", () => {
    expect(headline(payment("https://crema.example/articles/a"))).toBe(
      "Paid 3¢ to crema.example for /articles/a",
    );
    expect(headline(payment("https://other.example/premium"))).toBe(
      "Paid 3¢ to crema.example for other.example/premium",
    );
    expect(headline(payment(null))).toBe("Paid 3¢ to crema.example");
  });
});
