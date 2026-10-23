import { describe, expect, it } from "vitest";
import { PRACTICE_FORMATS, PRACTICE_REGISTRY, formatHours, normalizePicks, shareOut, weekBudgets, type PracticePickDraft } from "@/lib/practice";

const draft = (format: string, share = 25, focus = "Arrays", reason = "Because."): PracticePickDraft => ({ format, share, focus, reason });

describe("normalizePicks", () => {
  it("keeps known formats, drops unknown ones and duplicates, and caps the picks at four", () => {
    const picks = normalizePicks([
      draft("problem-set"),
      draft("quiz"),
      draft("problem-set"),
      draft("mock"),
      draft("design-exercise"),
      draft("recall"),
      draft("lab"),
    ]);
    expect(picks.map((p) => p.format)).toEqual(["problem-set", "mock", "design-exercise", "recall"]);
  });

  it("normalises shares to sum to 100", () => {
    const shares = normalizePicks([draft("problem-set", 40), draft("recall", 40), draft("mock", 60)]).map((p) => p.share);
    expect(shares).toEqual([29, 29, 42]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
    expect(normalizePicks([draft("lab", 7)]).map((p) => p.share)).toEqual([100]);
    expect(normalizePicks([draft("lab", 0), draft("recall", -5), draft("mock", 30)]).map((p) => [p.format, p.share])).toEqual([["mock", 100]]);
  });

  it("keeps every share at least 1 and the total at 100", () => {
    const shares = normalizePicks([draft("problem-set", 1), draft("recall", 1000)]).map((p) => p.share);
    expect(shares.every((s) => s >= 1)).toBe(true);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("clips focus and reason, and drops a pick with no focus", () => {
    const [pick] = normalizePicks([draft("recall", 50, `  ${"f".repeat(200)}  `, "r".repeat(400))]);
    expect(pick.focus).toHaveLength(160);
    expect(pick.focus.endsWith("…")).toBe(true);
    expect(pick.reason).toHaveLength(300);
    expect(pick.reason.endsWith("…")).toBe(true);
    expect(normalizePicks([draft("recall", 50, "   "), draft("mock", 50, "Full run")]).map((p) => p.format)).toEqual(["mock"]);
  });

  it("returns no picks for a missing or empty list", () => {
    expect(normalizePicks(null)).toEqual([]);
    expect(normalizePicks(undefined)).toEqual([]);
    expect(normalizePicks([])).toEqual([]);
  });
});

describe("PRACTICE_REGISTRY", () => {
  it("lists every format in the registry with a label, a research line and a generation rule", () => {
    expect(PRACTICE_FORMATS).toHaveLength(7);
    expect(PRACTICE_FORMATS.every((f) => PRACTICE_REGISTRY[f].id === f && PRACTICE_REGISTRY[f].label && PRACTICE_REGISTRY[f].research && PRACTICE_REGISTRY[f].generated)).toBe(true);
  });

  it("sizes each format as the spec says", () => {
    const sizes = Object.fromEntries(PRACTICE_FORMATS.map((f) => [f, [PRACTICE_REGISTRY[f].perItemMinutes, PRACTICE_REGISTRY[f].fixedMinutes]]));
    expect(sizes).toEqual({
      "problem-set": [10, null],
      recall: [3, null],
      "design-exercise": [null, 50],
      lab: [5, null],
      project: [null, null],
      mock: [null, 75],
      session: [null, null],
    });
  });
});

describe("formatHours", () => {
  const split = (shares: number[], readingShare = 40) => ({
    readingShare,
    practice: "practice",
    reason: "",
    formats: shares.map((share, i) => ({ format: (["problem-set", "design-exercise", "mock"] as const)[i], share, focus: `focus ${i}`, reason: "" })),
  });

  it("splits the practice hours by share, rounded to sum to the practice hours", () => {
    // 40 h total, 40% reading: 16 reading, 24 practice hours.
    const rows = formatHours(split([50, 30, 20]), 40);
    expect(rows.map((r) => [r.format, r.label, r.hours, r.focus])).toEqual([
      ["problem-set", "Problems", 12, "focus 0"],
      ["design-exercise", "Design", 7, "focus 1"],
      ["mock", "Mock", 5, "focus 2"],
    ]);
  });

  it("shares the hours by largest remainder, ties to the earlier pick", () => {
    // 25 h total, 60% reading: 15 reading, 10 practice; 45/35/20 -> 4.5, 3.5, 2 -> floors 4, 3, 2, the spare hour goes to the first 0.5.
    const rows = formatHours(split([45, 35, 20], 60), 25);
    expect(rows.map((r) => r.hours)).toEqual([5, 3, 2]);
    expect(rows.reduce((a, r) => a + r.hours, 0)).toBe(10);
  });

  it("never gives a pick negative hours when there are fewer hours than picks", () => {
    const four = {
      readingShare: 0,
      practice: "practice",
      reason: "",
      formats: (["problem-set", "recall", "mock", "lab"] as const).map((format) => ({ format, share: 25, focus: "x", reason: "" })),
    };
    const rows = formatHours(four, 2);
    expect(rows.map((r) => r.hours)).toEqual([1, 1, 0, 0]);
  });

  it("is empty when the split has no picks", () => {
    expect(formatHours({ readingShare: 50, practice: "practice", reason: "" }, 40)).toEqual([]);
  });
});

describe("weekBudgets", () => {
  const split = (shares: number[], readingShare: number) => ({
    readingShare,
    practice: "practice",
    reason: "",
    formats: shares.map((share, i) => ({ format: (["problem-set", "design-exercise", "mock", "lab"] as const)[i], share, focus: `focus ${i}`, reason: "" })),
  });

  it("gives reading its share of the week and shares the rest across the picks", () => {
    expect(weekBudgets(split([50, 30, 20], 30), 600)).toEqual({
      reading: 180,
      practice: { "problem-set": 210, "design-exercise": 126, mock: 84 },
    });
  });

  it("shares the practice minutes by largest remainder so they sum exactly, ties to the earlier pick", () => {
    // 101 min at 0% reading: 45/35/20 -> 45.45, 35.35, 20.2 -> floors 45, 35, 20, the spare minute to the biggest remainder.
    const b = weekBudgets(split([45, 35, 20], 0), 101);
    expect(b.reading).toBe(0);
    expect(Object.values(b.practice).reduce((a, m) => a + (m ?? 0), 0)).toBe(101);
    expect(b.practice).toEqual({ "problem-set": 46, "design-exercise": 35, mock: 20 });
    // 10 min over 50/50: a tie goes to the earlier pick.
    expect(weekBudgets(split([50, 50], 0), 11).practice).toEqual({ "problem-set": 6, "design-exercise": 5 });
  });

  it("is all reading without a split, without picks, or at 100% reading", () => {
    expect(weekBudgets(null, 600)).toEqual({ reading: 600, practice: {} });
    expect(weekBudgets(undefined, 600)).toEqual({ reading: 600, practice: {} });
    expect(weekBudgets({ readingShare: 40, practice: "practice", reason: "" }, 600)).toEqual({ reading: 600, practice: {} });
    expect(weekBudgets(split([50, 50], 100), 600)).toEqual({ reading: 600, practice: {} });
  });
});

describe("shareOut", () => {
  it("shares a total by percent so the parts sum to the total", () => {
    expect(shareOut(10, [45, 35, 20])).toEqual([5, 3, 2]);
    expect(shareOut(0, [50, 50])).toEqual([0, 0]);
  });
});
