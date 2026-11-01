import { describe, expect, it } from "vitest";
import { creditPeriod, creditsLeft, formatReset, monthStart } from "./credits";

describe("creditPeriod", () => {
  const iso = (p: { start: Date; end: Date }) => [p.start.toISOString(), p.end.toISOString()];

  it("runs from the signup day, at 00:00 UTC, to the same day next month", () => {
    const signup = new Date("2026-09-14T17:30:00Z");
    expect(iso(creditPeriod(signup, new Date("2026-11-01T00:00:00Z")))).toEqual(["2026-10-14T00:00:00.000Z", "2026-11-14T00:00:00.000Z"]);
    expect(iso(creditPeriod(signup, new Date("2026-11-14T00:00:00Z")))).toEqual(["2026-11-14T00:00:00.000Z", "2026-12-14T00:00:00.000Z"]);
    expect(iso(creditPeriod(signup, new Date("2026-11-13T23:59:59Z")))).toEqual(["2026-10-14T00:00:00.000Z", "2026-11-14T00:00:00.000Z"]);
  });

  it("starts on the signup day itself", () => {
    const signup = new Date("2026-11-01T09:00:00Z");
    expect(iso(creditPeriod(signup, new Date("2026-11-01T09:00:00Z")))).toEqual(["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
  });

  it("ends a 31st's period on the last day of a shorter month, then returns to the 31st", () => {
    const signup = new Date("2026-01-31T12:00:00Z");
    expect(iso(creditPeriod(signup, new Date("2026-02-10T00:00:00Z")))).toEqual(["2026-01-31T00:00:00.000Z", "2026-02-28T00:00:00.000Z"]);
    expect(iso(creditPeriod(signup, new Date("2026-03-05T00:00:00Z")))).toEqual(["2026-02-28T00:00:00.000Z", "2026-03-31T00:00:00.000Z"]);
    expect(iso(creditPeriod(new Date("2027-12-31T00:00:00Z"), new Date("2028-02-29T10:00:00Z")))).toEqual(["2028-02-29T00:00:00.000Z", "2028-03-31T00:00:00.000Z"]);
  });

  it("crosses a year end", () => {
    const signup = new Date("2026-08-20T00:00:00Z");
    expect(iso(creditPeriod(signup, new Date("2027-01-02T00:00:00Z")))).toEqual(["2026-12-20T00:00:00.000Z", "2027-01-20T00:00:00.000Z"]);
  });

  it("gives the first period when the clock reads before the signup", () => {
    const signup = new Date("2026-11-20T08:00:00Z");
    expect(iso(creditPeriod(signup, new Date("2026-11-10T00:00:00Z")))).toEqual(["2026-11-20T00:00:00.000Z", "2026-12-20T00:00:00.000Z"]);
  });

  it("falls back to the calendar month from the 1st", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    expect(iso(creditPeriod(monthStart(now), now))).toEqual(["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
  });

  it("formats a reset date as the app shows it", () => {
    expect(formatReset(new Date("2026-12-14T00:00:00Z"))).toBe("14 Dec");
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
