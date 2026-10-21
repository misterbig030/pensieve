import { describe, expect, it } from "vitest";
import {
  budgetFor,
  childSpans,
  currentLeaf,
  daysInWeekOf,
  doneDays,
  fullLabelOf,
  labelOf,
  layout,
  leavesOf,
  lockBoundary,
  makeNode,
  makeRoot,
  relength,
  replaceNode,
  settledWeeks,
  cloneTree,
  resolveGranularity,
  spanOf,
  splitSpans,
  topLevelFor,
  topSpans,
  nextPlanningStep,
  planningStepsLeft,
  weeksOf,
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
  it("chooses the top unit by length in weeks", () => {
    expect(topLevelFor(1)).toBe("day");
    expect(topLevelFor(2)).toBe("week");
    expect(topLevelFor(10)).toBe("week");
    expect(topLevelFor(11)).toBe("month");
  });
  it("gives top spans per level, each week the usual number of days", () => {
    expect(topSpans(1, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(topSpans(4, 5)).toEqual([5, 5, 5, 5]);
    expect(topSpans(13, 5)).toEqual([20, 20, 25]);
    expect(topSpans(26, 7)).toEqual([21, 21, 28, 28, 28, 28, 28]);
  });
  it("resolves auto granularity by length", () => {
    expect(resolveGranularity("auto", 4)).toBe("day");
    expect(resolveGranularity("auto", 13)).toBe("week");
    expect(resolveGranularity("week", 1)).toBe("week");
  });
  it("splits a month into weeks of the usual days and a week into its days", () => {
    expect(childSpans({ level: "month", len: 20 }, 5)).toEqual([5, 5, 5, 5]);
    // A month saved before the setting: its tail is spread over its weeks.
    expect(childSpans({ level: "month", len: 30 }, 7)).toEqual([7, 7, 8, 8]);
    expect(childSpans({ level: "week", len: 3 }, 5)).toEqual([1, 1, 1]);
    expect(childSpans({ level: "day", len: 1 }, 5)).toEqual([]);
  });
  it("budgets the weekly hours per week", () => {
    expect(budgetFor(1)).toBe(6);
    expect(budgetFor(1, 10)).toBe(10);
    expect(budgetFor(4, 6)).toBe(24);
    expect(budgetFor(0.1, 6)).toBe(1);
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
  it("labels by level and ordinal, a week's days from Day 1", () => {
    const root = sampleTree();
    root.children!.reverse();
    layout(root);
    expect(labelOf(root, root.children![0])).toBe("Week 1");
    // The seven-day week is now second; its third day is still Day 3, though it is the plan's eleventh.
    expect(root.children![1].children![2].start).toBe(11);
    expect(labelOf(root, root.children![1].children![2])).toBe("Day 3");
    expect(fullLabelOf(root, root.children![1].children![2])).toBe("Week 2 · Day 3");
    expect(fullLabelOf(root, root.children![1])).toBe("Week 2");
  });
  it("states a unit's span in days for a week and weeks for a month", () => {
    const root = sampleTree();
    expect(spanOf(root, root.children![0], 7)).toBe("7 days");
    expect(spanOf(root, root.children![0].children![0], 7)).toBe("");
    const months = makeRoot([makeNode({ id: "m1", level: "month", title: "M", summary: "", len: 20 })]);
    expect(spanOf(months, months.children![0], 5)).toBe("4 weeks");
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

describe("weeks of time", () => {
  it("counts a week as one week whatever its days, and a day as its week's share", () => {
    const root = makeRoot([
      makeNode({ id: "w1", level: "week", title: "W", summary: "", len: 3, children: [1, 2, 3].map((i) => makeNode({ id: `d${i}`, level: "day", title: "D", summary: "", len: 1 })) }),
      makeNode({ id: "w2", level: "week", title: "W", summary: "", len: 5 }),
      makeNode({ id: "m1", level: "month", title: "M", summary: "", len: 20 }),
    ]);
    expect(weeksOf(root, root.children![0], 5)).toBe(1);
    expect(weeksOf(root, root.children![0].children![0], 5)).toBeCloseTo(1 / 3);
    expect(daysInWeekOf(root, root.children![0].children![0], 5)).toBe(3);
    expect(weeksOf(root, root.children![2], 5)).toBe(4);
    expect(weeksOf(root, root, 5)).toBe(6);
  });
  it("shares the usual week among the days at the top of a one-week plan", () => {
    const root = makeRoot([1, 2, 3, 4, 5].map((i) => makeNode({ id: `d${i}`, level: "day", title: "D", summary: "", len: 1 })));
    expect(daysInWeekOf(root, root.children![0], 5)).toBe(5);
    expect(weeksOf(root, root, 5)).toBe(1);
  });
});

describe("relength", () => {
  it("re-lengths open unplanned weeks and months, and leaves split, done and locked ones alone", () => {
    const root = makeRoot([
      makeNode({ id: "w1", level: "week", title: "W", summary: "", len: 7, status: "completed", budgetHours: 6 }),
      makeNode({ id: "w2", level: "week", title: "W", summary: "", len: 3, children: [1, 2, 3].map((i) => makeNode({ id: `d${i}`, level: "day", title: "D", summary: "", len: 1 })) }),
      makeNode({ id: "w3", level: "week", title: "W", summary: "", len: 7 }),
      makeNode({ id: "m1", level: "month", title: "M", summary: "", len: 28 }),
    ]);
    const next = relength(root, 7, 5, 7);
    expect(next.children!.map((c) => c.len)).toEqual([7, 3, 5, 20]);
    expect(next.children![2].start).toBe(11);
    expect(next.len).toBe(35);
    expect(root.children![2].len).toBe(7);
  });
});

describe("while planning", () => {
  const plan = () =>
    makeRoot([
      makeNode({ id: "w1", level: "week", title: "W", summary: "", len: 5, materials: [{ id: "M1", tier: "must", minutes: 30, note: null }] }),
      makeNode({ id: "m1", level: "month", title: "M", summary: "", len: 20 }),
    ]);
  it("counts a unit still being planned as it was, not by its first children", () => {
    const root = plan();
    root.children![1].children = [makeNode({ id: "x1", level: "week", title: "X", summary: "", len: 5 })];
    layout(root, 1, new Set(["m1"]));
    expect(weeksOf(root, root, 5)).toBe(2);
    expect(settledWeeks(root, ["m1"], 5)).toBe(5);
    expect(settledWeeks(root, ["root"], 5)).toBe(2);
  });
  it("puts a unit back as it was before a change that failed", () => {
    const root = plan();
    const before = cloneTree(root.children![0]);
    const week = root.children![0];
    week.len = 3;
    week.children = [makeNode({ id: "d1", level: "day", title: "D", summary: "", len: 1 })];
    delete week.materials;
    const restored = layout(replaceNode(root, before));
    expect(restored.children![0]).toMatchObject({ id: "w1", len: 5, children: null, materials: [{ id: "M1" }] });
    expect(restored.children![1].start).toBe(6);
    expect(root.children![0].len).toBe(3);
  });
});

describe("planning everything", () => {
  const plan = () =>
    layout(
      makeRoot([
        makeNode({
          id: "m1",
          level: "month",
          title: "M1",
          summary: "s",
          len: 30,
          children: [
            makeNode({ id: "w1", level: "week", title: "W1", summary: "s", len: 7, budgetHours: 6, children: [makeNode({ id: "d1", level: "day", title: "D", summary: "s", len: 7 })] }),
            makeNode({ id: "w2", level: "week", title: "W2", summary: "s", len: 7, budgetHours: 6 }),
            makeNode({ id: "w3", level: "week", title: "W3", summary: "s", len: 16, budgetHours: 14 }),
          ],
        }),
        makeNode({ id: "m2", level: "month", title: "M2", summary: "s", len: 30 }),
      ]),
    );
  it("takes the next unplanned unit in plan order: a week to split before a later month to plan", () => {
    expect(nextPlanningStep(plan(), "week")).toEqual({ nodeId: "w2", reason: "split", label: "Splitting Week 2 of Month 1" });
    const root = plan();
    root.children![0].children![1].children = [makeNode({ id: "d2", level: "day", title: "D", summary: "s", len: 7 })];
    root.children![0].children![2].children = [makeNode({ id: "d3", level: "day", title: "D", summary: "s", len: 16 })];
    expect(nextPlanningStep(root, "week")).toEqual({ nodeId: "m2", reason: "expand", label: "Planning Month 2" });
    root.children![1].children = [makeNode({ id: "w4", level: "week", title: "W4", summary: "s", len: 30, budgetHours: 26 })];
    expect(nextPlanningStep(root, "week")).toEqual({ nodeId: "w4", reason: "split", label: "Splitting Week 1 of Month 2" });
    root.children![1].children![0].children = [makeNode({ id: "d4", level: "day", title: "D", summary: "s", len: 30 })];
    expect(nextPlanningStep(root, "week")).toBeNull();
  });
  it("on a day plan, weeks are headings to plan, not leaves to split", () => {
    expect(nextPlanningStep(plan(), "day")).toEqual({ nodeId: "w2", reason: "expand", label: "Planning Week 2 of Month 1" });
  });
  it("counts the steps left, including the weeks an unplanned month will have", () => {
    // Weeks 2 and 3 to split, month 2 to plan, then its four weeks to split.
    expect(planningStepsLeft(plan(), 7)).toBe(7);
  });
});
