import { describe, expect, it } from "vitest";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import { clampHours, dayMinutes, hoursInText, normalizeSplit, presetFor, readingShareOf, rebudget, totalHours } from "./studyTime";

describe("hours", () => {
  it("totals the plan's hours", () => {
    expect(totalHours(84, 6)).toBe(72);
    expect(totalHours(84)).toBe(72);
    expect(totalHours(7, 3)).toBe(3);
    expect(totalHours(84, 30)).toBe(360);
    expect(totalHours(1, 1)).toBe(1);
  });

  it("gives a day its share of the week, to five minutes", () => {
    expect(dayMinutes(6)).toBe(50);
    expect(dayMinutes(30)).toBe(255);
    expect(dayMinutes(1)).toBe(10);
  });

  it("clamps and names presets", () => {
    expect(clampHours(0)).toBe(1);
    expect(clampHours(200)).toBe(80);
    expect(clampHours(9.6)).toBe(10);
    expect(clampHours(Number.NaN)).toBe(6);
    expect(presetFor(30)?.label).toBe("Full time");
    expect(presetFor(10)).toBeNull();
  });
});

describe("hoursInText", () => {
  it.each([
    ["Backend engineer. About 15 hours a week, heavy on building.", 15],
    ["10h/week", 10],
    ["I have 6 hrs per week", 6],
    ["5-7 hours each week", 6],
    ["30 minutes a day", 4],
    ["2 hours per day", 14],
    ["heavy on building, no time stated", null],
    ["a 12 week plan", null],
  ])("%s → %s", (text, hours) => {
    expect(hoursInText(text)).toBe(hours);
  });
});

describe("split", () => {
  it("clamps the share and trims the words", () => {
    expect(normalizeSplit({ readingShare: 62.5, practice: " building projects. ", reason: " A skill learned by shipping. " })).toEqual({
      readingShare: 63,
      practice: "building projects",
      reason: "A skill learned by shipping.",
    });
    expect(normalizeSplit({ readingShare: 140, practice: "x", reason: "" })?.readingShare).toBe(100);
  });

  it("is null without a share or a practice", () => {
    expect(normalizeSplit(null)).toBeNull();
    expect(normalizeSplit({ practice: "building" })).toBeNull();
    expect(normalizeSplit({ readingShare: 50, practice: "  " })).toBeNull();
  });

  it("reads as a fraction, or null for plans without one", () => {
    expect(readingShareOf({ readingShare: 85, practice: "writing", reason: "" })).toBe(0.85);
    expect(readingShareOf(null)).toBeNull();
  });
});

describe("rebudget", () => {
  it("re-budgets open weeks and leaves completed and locked ones alone", () => {
    const week = (id: string, status: "pending" | "completed" = "pending") => makeNode({ id, level: "week", title: id, summary: id, len: 7, budgetHours: 6, status });
    const heading = makeNode({ id: "w4", level: "week", title: "w4", summary: "w4", len: 7 });
    const root = layout(makeRoot([week("w1", "completed"), week("w2"), week("w3"), heading]));
    const next = rebudget(root, 10, 14);
    expect(next.children!.map((n) => n.budgetHours)).toEqual([6, 6, 10, null]);
    expect(root.children![2].budgetHours).toBe(6);
  });
});
