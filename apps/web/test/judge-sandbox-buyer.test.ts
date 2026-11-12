import { describe, expect, it } from "vitest";
import { judgeSandboxBuyer } from "../src/lib/server/judge";
import { WALLET_RECEIPT_LIMIT } from "../src/lib/server/wallet";

describe("judgeSandboxBuyer", () => {
  it("returns the trimmed sandbox buyer when both values are set", () => {
    expect(
      judgeSandboxBuyer({
        JUDGE_SANDBOX_BUYER_EMAIL: " buyer@example.test ",
        JUDGE_SANDBOX_BUYER_PASSWORD: " test-pass ",
      }),
    ).toEqual({ email: "buyer@example.test", password: "test-pass" });
  });

  it("returns null when either value is missing or blank", () => {
    expect(judgeSandboxBuyer({ JUDGE_SANDBOX_BUYER_EMAIL: "buyer@example.test" })).toBeNull();
    expect(
      judgeSandboxBuyer({
        JUDGE_SANDBOX_BUYER_EMAIL: "  ",
        JUDGE_SANDBOX_BUYER_PASSWORD: "test-pass",
      }),
    ).toBeNull();
  });
});

describe("wallet receipts", () => {
  it("shows the latest 10, so the Disputes card stays near the top on a phone", () => {
    expect(WALLET_RECEIPT_LIMIT).toBe(10);
  });
});
