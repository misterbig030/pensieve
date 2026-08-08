import { describe, expect, it } from "vitest";
import { computeOutlineReplacement } from "./outlineRevision";

describe("computeOutlineReplacement", () => {
  it("starts new items right after the highest existing dayIndex when completion is contiguous", () => {
    const existing = [
      { dayIndex: 1, status: "completed" as const },
      { dayIndex: 2, status: "completed" as const },
      { dayIndex: 3, status: "generated" as const },
      { dayIndex: 4, status: "pending" as const },
    ];
    const draftItems = [
      { title: "New day A", summary: "..." },
      { title: "New day B", summary: "..." },
    ];
    const result = computeOutlineReplacement(existing, draftItems);
    expect(result).toEqual([
      { dayIndex: 5, title: "New day A", summary: "..." },
      { dayIndex: 6, title: "New day B", summary: "..." },
    ]);
  });

  it("starts at dayIndex 1 when nothing exists yet", () => {
    const existing: { dayIndex: number; status: "pending" | "generated" | "completed" }[] = [];
    const draftItems = [{ title: "Only day", summary: "..." }];
    const result = computeOutlineReplacement(existing, draftItems);
    expect(result).toEqual([{ dayIndex: 1, title: "Only day", summary: "..." }]);
  });

  it("handles every item being completed (no replacement slots, still appends after)", () => {
    const existing = [
      { dayIndex: 1, status: "completed" as const },
      { dayIndex: 2, status: "completed" as const },
    ];
    const draftItems = [{ title: "Extra day", summary: "..." }];
    const result = computeOutlineReplacement(existing, draftItems);
    expect(result).toEqual([{ dayIndex: 3, title: "Extra day", summary: "..." }]);
  });

  it("preserves out-of-order pending days below the max instead of overwriting them", () => {
    // Day 5 was completed while days 1-4 are still pending/generated. A
    // revision must NOT renumber over days 1-4 — it should append starting
    // after day 5 (the true max dayIndex), leaving 1-4 alone.
    const existing = [
      { dayIndex: 1, status: "completed" as const },
      { dayIndex: 2, status: "pending" as const },
      { dayIndex: 3, status: "completed" as const },
      { dayIndex: 4, status: "pending" as const },
      { dayIndex: 5, status: "completed" as const },
    ];
    const draftItems = [{ title: "New day", summary: "..." }];
    const result = computeOutlineReplacement(existing, draftItems);
    expect(result).toEqual([{ dayIndex: 6, title: "New day", summary: "..." }]);
  });
});
