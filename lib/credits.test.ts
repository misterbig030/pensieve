import { describe, expect, it } from "vitest";
import { creditsLeft, formatReset, monthStart, nextReset } from "./credits";

describe("month window", () => {
  it("starts at 00:00 UTC on the 1st", () => {
    expect(monthStart(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-11-01T00:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("resets on the next 1st, across a year end", () => {
    expect(nextReset(new Date("2026-10-15T08:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(nextReset(new Date("2026-12-31T23:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(formatReset(new Date("2026-12-01T00:00:00Z"))).toBe("1 Dec");
  });
});

describe("creditsLeft", () => {
  it("rounds down and never goes below zero", () => {
    expect(creditsLeft(0)).toBe(500);
    expect(creditsLeft(0.004)).toBe(499);
    expect(creditsLeft(4.99)).toBe(1);
    expect(creditsLeft(4.996)).toBe(0);
    expect(creditsLeft(7)).toBe(0);
    expect(creditsLeft(0.1 + 0.2)).toBe(470);
  });
});
