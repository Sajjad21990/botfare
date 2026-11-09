import { describe, expect, it } from "vitest";
import { formatClearsIn, withdrawableCents } from "../src/components/publisher/format";

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
