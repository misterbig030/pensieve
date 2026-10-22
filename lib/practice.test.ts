import { describe, expect, it } from "vitest";
import { PRACTICE_FORMATS, PRACTICE_REGISTRY, normalizePicks, type PracticePickDraft } from "@/lib/practice";

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
