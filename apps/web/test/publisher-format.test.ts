import { describe, expect, it } from "vitest";
import {
  formatClearsIn,
  formatMicros,
  formatMoney,
  formatMoneyExact,
  withdrawableCents,
} from "../src/components/publisher/format";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("formatClearsIn", () => {
  it("counts down in minutes, then hours and minutes", () => {
    expect(formatClearsIn(at(1_000), NOW)).toBe("in 1 min");
    expect(formatClearsIn(at(45 * 60_000), NOW)).toBe("in 45 min");
    expect(formatClearsIn(at(60 * 60_000), NOW)).toBe("in 1 h");
    expect(formatClearsIn(at(3 * 3_600_000 + 20 * 60_000), NOW)).toBe("in 3 h 20 min");
    expect(formatClearsIn(at(24 * 3_600_000), NOW)).toBe("in 24 h");
  });

  it("says any moment now once the time has passed or is unreadable", () => {
    expect(formatClearsIn(at(0), NOW)).toBe("any moment now");
    expect(formatClearsIn(at(-60_000), NOW)).toBe("any moment now");
    expect(formatClearsIn("not a date", NOW)).toBe("any moment now");
  });
});

describe("withdrawableCents", () => {
  it("keeps whole cents of what is available", () => {
    expect(withdrawableCents(1_425_000)).toBe(142);
    expect(withdrawableCents(0)).toBe(0);
    expect(withdrawableCents(-5)).toBe(0);
  });
});

describe("formatMoney", () => {
  it("shows cents under a dollar", () => {
    expect(formatMoney(30_000)).toBe("3¢");
    expect(formatMoney(28_500)).toBe("3¢");
    expect(formatMoney(990_000)).toBe("99¢");
  });

  it("shows dollars with two decimals from a dollar up", () => {
    expect(formatMoney(2_036_000)).toBe("$2.04");
    expect(formatMoney(5_852_000)).toBe("$5.85");
    expect(formatMoney(1_406_000)).toBe("$1.41");
    expect(formatMoney(1_005_000)).toBe("$1.01");
    expect(formatMoney(1_000_000)).toBe("$1.00");
    expect(formatMoney(12_345_670_000)).toBe("$12,345.67");
  });

  it("rounds up into dollars at the boundary", () => {
    expect(formatMoney(995_000)).toBe("$1.00");
    expect(formatMoney(999_999)).toBe("$1.00");
  });

  it("handles nothing, sub-cent and negative amounts", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(4_000)).toBe("<1¢");
    expect(formatMoney(-30_000)).toBe("-3¢");
    expect(formatMoney(-2_036_000)).toBe("-$2.04");
  });
});

describe("formatMoneyExact", () => {
  it("keeps every digit the ledger has", () => {
    expect(formatMoneyExact(1_406_000)).toBe("$1.406");
    expect(formatMoneyExact(28_500)).toBe("$0.0285");
    expect(formatMoneyExact(2_000_000)).toBe("$2.00");
    expect(formatMoneyExact(1)).toBe("$0.000001");
  });
});

describe("formatMicros (unchanged)", () => {
  it("keeps 4 decimals for sub-cent amounts", () => {
    expect(formatMicros(1_406_000)).toBe("$1.4060");
    expect(formatMicros(2_000_000)).toBe("$2.00");
  });
});
