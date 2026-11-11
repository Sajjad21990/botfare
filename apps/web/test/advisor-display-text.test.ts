import { describe, expect, it } from "vitest";
import {
  isRevenueClaim,
  withoutRevenueClaims,
} from "../src/components/publisher/advisor/display-text";

describe("withoutRevenueClaims", () => {
  it("drops the sentences that claim revenue and keeps the evidence", () => {
    expect(
      withoutRevenueClaims(
        "14 of 23 agents declined at 3¢ as too expensive. Raising to 2¢ can double revenue. Agents that paid cited the page 9 times.",
      ),
    ).toBe(
      "14 of 23 agents declined at 3¢ as too expensive. Agents that paid cited the page 9 times.",
    );
  });

  it("catches earnings and income wording too", () => {
    expect(isRevenueClaim("You would earn more at 2¢.")).toBe(true);
    expect(isRevenueClaim("Weekly income should triple.")).toBe(true);
    expect(isRevenueClaim("Earnings rise if more agents buy.")).toBe(true);
    expect(isRevenueClaim("At 2¢ you would make more each week.")).toBe(true);
  });

  it("leaves ordinary sentences alone", () => {
    expect(isRevenueClaim("0 of 23 agents bought at 50¢; 14 called it a thin listicle.")).toBe(
      false,
    );
    expect(isRevenueClaim("Agents learn more from a longer preview.")).toBe(false);
    expect(isRevenueClaim("Doubling the preview length helps agents decide.")).toBe(false);
    expect(withoutRevenueClaims("Keep 3¢. 12 of 15 agents bought at it.")).toBe(
      "Keep 3¢. 12 of 15 agents bought at it.",
    );
  });

  it("does not split prices with a decimal point", () => {
    expect(withoutRevenueClaims("Try 2.5¢ for this page. Revenue would grow.")).toBe(
      "Try 2.5¢ for this page.",
    );
  });

  it("returns an empty string when every sentence is a revenue claim", () => {
    expect(withoutRevenueClaims("Raise to 2¢ to double revenue.")).toBe("");
    expect(withoutRevenueClaims("")).toBe("");
  });
});
