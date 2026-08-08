import { describe, expect, it } from "vitest";
import { computeOutlineReplacement } from "./outlineRevision";

describe("computeOutlineReplacement", () => {
  it("starts new items right after the last completed dayIndex", () => {
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
      { dayIndex: 3, title: "New day A", summary: "..." },
      { dayIndex: 4, title: "New day B", summary: "..." },
    ]);
  });

  it("starts at dayIndex 1 when nothing is completed yet", () => {
    const existing = [
      { dayIndex: 1, status: "pending" as const },
      { dayIndex: 2, status: "pending" as const },
    ];
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
});
