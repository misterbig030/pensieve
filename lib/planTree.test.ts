import { describe, expect, it } from "vitest";
import {
  budgetFor,
  childSpans,
  currentLeaf,
  doneDays,
  labelOf,
  layout,
  leavesOf,
  lockBoundary,
  makeNode,
  makeRoot,
  resolveGranularity,
  spanOf,
  splitSpans,
  topLevelFor,
  topSpans,
} from "./planTree";

describe("splitSpans", () => {
  it("absorbs a short tail into the other spans", () => {
    expect(splitSpans(30, 7)).toEqual([7, 7, 8, 8]);
    expect(splitSpans(31, 7)).toEqual([7, 8, 8, 8]);
    expect(splitSpans(10, 7)).toEqual([10]);
  });
  it("keeps a tail that is at least half a unit", () => {
    expect(splitSpans(28, 7)).toEqual([7, 7, 7, 7]);
    expect(splitSpans(11, 7)).toEqual([5, 6]);
    expect(splitSpans(32, 7)).toEqual([6, 6, 6, 7, 7]);
  });
  it("sizes months the same way", () => {
    expect(splitSpans(180, 28)).toEqual([30, 30, 30, 30, 30, 30]);
    expect(splitSpans(200, 28)).toEqual([28, 28, 28, 29, 29, 29, 29]);
  });
  it("handles degenerate input", () => {
    expect(splitSpans(0, 7)).toEqual([]);
    expect(splitSpans(1, 7)).toEqual([1]);
  });
});

describe("levels", () => {
  it("chooses the top unit by length", () => {
    expect(topLevelFor(7)).toBe("day");
    expect(topLevelFor(14)).toBe("day");
    expect(topLevelFor(30)).toBe("week");
    expect(topLevelFor(70)).toBe("week");
    expect(topLevelFor(90)).toBe("month");
  });
  it("gives top spans per level", () => {
    expect(topSpans(7)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(topSpans(30)).toEqual([7, 7, 8, 8]);
    expect(topSpans(180)).toHaveLength(6);
  });
  it("resolves auto granularity by length", () => {
    expect(resolveGranularity("auto", 30)).toBe("day");
    expect(resolveGranularity("auto", 90)).toBe("week");
    expect(resolveGranularity("week", 7)).toBe("week");
  });
  it("splits a month into weeks and a week into days", () => {
    expect(childSpans({ level: "month", len: 30 })).toEqual([7, 7, 8, 8]);
    expect(childSpans({ level: "week", len: 8 })).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(childSpans({ level: "day", len: 1 })).toEqual([]);
  });
  it("budgets about six hours a week", () => {
    expect(budgetFor(7)).toBe(6);
    expect(budgetFor(8)).toBe(7);
    expect(budgetFor(1)).toBe(1);
  });
});

function sampleTree() {
  const week1 = makeNode({
    id: "w1",
    level: "week",
    title: "Basics",
    summary: "",
    len: 7,
    children: Array.from({ length: 7 }, (_, i) =>
      makeNode({ id: `d${i + 1}`, level: "day", title: `Day ${i + 1}`, summary: "", len: 1, status: i < 3 ? "completed" : "pending" }),
    ),
  });
  const week2 = makeNode({ id: "w2", level: "week", title: "Next", summary: "", len: 8, budgetHours: 7 });
  return makeRoot([week1, week2]);
}

describe("layout and labels", () => {
  it("numbers days across the tree and recomputes group spans", () => {
    const root = sampleTree();
    expect(root.len).toBe(15);
    expect(root.children![0].start).toBe(1);
    expect(root.children![0].end).toBe(7);
    expect(root.children![1].start).toBe(8);
    expect(root.children![1].end).toBe(15);
    expect(root.children![0].children![6].start).toBe(7);
  });
  it("labels by level and ordinal", () => {
    const root = sampleTree();
    expect(labelOf(root, root.children![1])).toBe("Week 2");
    expect(labelOf(root, root.children![0].children![2])).toBe("Day 3");
    expect(spanOf(root.children![1])).toBe("Day 8–15");
    expect(spanOf(root.children![0].children![0])).toBe("Day 1");
  });
  it("re-lays out after a change", () => {
    const root = sampleTree();
    root.children!.reverse();
    layout(root);
    expect(root.children![0].start).toBe(1);
    expect(root.children![0].end).toBe(8);
    expect(root.children![1].children![0].start).toBe(9);
  });
});

describe("progress", () => {
  it("counts completed leaves by span", () => {
    const root = sampleTree();
    expect(doneDays(root)).toBe(3);
    root.children![1].status = "completed";
    expect(doneDays(root)).toBe(11);
  });
  it("lists leaves in order and finds the current one", () => {
    const root = sampleTree();
    expect(leavesOf(root).map((l) => l.id)).toEqual(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "w2"]);
    expect(currentLeaf(root)?.id).toBe("d4");
    expect(lockBoundary(root)).toBe(3);
  });
});
