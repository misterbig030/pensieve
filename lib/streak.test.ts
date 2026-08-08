import { describe, expect, it } from "vitest";
import { computeStreak } from "./streak";

const day = (offsetFromToday: number, today: Date) => {
  const d = new Date(today);
  d.setDate(d.getDate() - offsetFromToday);
  return d;
};

describe("computeStreak", () => {
  const today = new Date("2026-08-07T12:00:00Z");

  it("returns 0 for no check-ins", () => {
    expect(computeStreak([], today)).toBe(0);
  });

  it("returns 1 when only today has a check-in", () => {
    expect(computeStreak([day(0, today)], today)).toBe(1);
  });

  it("counts consecutive days ending today", () => {
    const dates = [day(0, today), day(1, today), day(2, today)];
    expect(computeStreak(dates, today)).toBe(3);
  });

  it("still counts the streak if today has no check-in yet but yesterday does", () => {
    const dates = [day(1, today), day(2, today)];
    expect(computeStreak(dates, today)).toBe(2);
  });

  it("breaks the streak on a gap", () => {
    const dates = [day(0, today), day(1, today), day(3, today)];
    expect(computeStreak(dates, today)).toBe(2);
  });

  it("resets to 0 if the most recent check-in is more than 1 day ago", () => {
    const dates = [day(3, today), day(4, today)];
    expect(computeStreak(dates, today)).toBe(0);
  });

  it("de-duplicates multiple check-ins on the same day", () => {
    const d0 = day(0, today);
    const d0b = new Date(d0);
    d0b.setHours(d0b.getHours() + 2);
    expect(computeStreak([d0, d0b], today)).toBe(1);
  });
});
