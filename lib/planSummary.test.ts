import { describe, expect, it } from "vitest";
import { cloneTree, layout, makeNode, makeRoot } from "./planTree";
import { diffChangedNodes, latestChangeNote, summarizePlan, tagFor } from "./planSummary";

function dayPlan() {
  return makeRoot([
    makeNode({ id: "d1", level: "day", title: "Literals", summary: "a", len: 1 }),
    makeNode({ id: "d2", level: "day", title: "Quantifiers", summary: "b", len: 1 }),
    makeNode({ id: "d3", level: "day", title: "Anchors", summary: "c", len: 1 }),
  ]);
}

function weekPlan() {
  return makeRoot([
    makeNode({
      id: "w1",
      level: "week",
      title: "Inference fundamentals",
      summary: "s1",
      len: 7,
      children: Array.from({ length: 7 }, (_, i) => makeNode({ id: `w1d${i + 1}`, level: "day", title: `Topic ${i + 1}`, summary: `t${i + 1}`, len: 1 })),
    }),
    makeNode({ id: "w2", level: "week", title: "GPUs and memory", summary: "s2", len: 7 }),
    makeNode({ id: "w3", level: "week", title: "Serving systems", summary: "s3", len: 8 }),
    makeNode({ id: "w4", level: "week", title: "Mock rounds", summary: "s4", len: 8 }),
  ]);
}

describe("summarizePlan", () => {
  it("describes a flat day plan", () => {
    expect(summarizePlan(dayPlan(), "Regex")).toBe(
      '3 days on Regex, one day at a time: Literals, Quantifiers, Anchors. Opens with "Literals" and closes on "Anchors".',
    );
  });
  it("describes a week plan with the top-level titles and closes on the last unit", () => {
    expect(summarizePlan(weekPlan(), "AI infra")).toBe(
      '30 days on AI infra, about 5 weeks, in 4 weeks: Inference fundamentals, GPUs and memory, Serving systems, Mock rounds. Opens with "Topic 1" and closes on "Mock rounds".',
    );
  });
  it("appends a note", () => {
    expect(summarizePlan(dayPlan(), "Regex", "Latest change: x.")).toMatch(/\. Latest change: x\.$/);
    expect(latestChangeNote("Swapped weeks 3 and 4.")).toBe("Latest change: swapped weeks 3 and 4.");
    expect(latestChangeNote("  ")).toBe("");
  });
});

describe("diffChangedNodes", () => {
  it("reports swapped weeks at the week level", () => {
    const prev = weekPlan();
    const next = cloneTree(prev);
    [next.children![2], next.children![3]] = [next.children![3], next.children![2]];
    layout(next);
    const changed = diffChangedNodes(prev, next);
    expect(changed.level).toBe("week");
    expect(changed.ids).toEqual(["w4", "w3"]);
    expect(changed.tags).toEqual(["Week 3", "Week 4"]);
  });
  it("reports a day edit inside a week at the day level with the week in the tag", () => {
    const prev = weekPlan();
    const next = cloneTree(prev);
    next.children![0].children![2].title = "Quantization first";
    layout(next);
    const changed = diffChangedNodes(prev, next);
    expect(changed.level).toBe("day");
    expect(changed.ids).toEqual(["w1d3"]);
    expect(changed.tags).toEqual(["Week 1 · Day 3"]);
  });
  it("reports a removal through the seam", () => {
    const prev = dayPlan();
    const next = cloneTree(prev);
    next.children!.splice(1, 1);
    layout(next);
    const changed = diffChangedNodes(prev, next);
    expect(changed.ids).toEqual(["d3"]);
    expect(changed.tags).toEqual(["Day 2"]);
  });
  it("reports an expanded week as the week itself", () => {
    const prev = weekPlan();
    const next = cloneTree(prev);
    next.children![1].children = [makeNode({ id: "n1", level: "day", title: "GPU basics", summary: "g", len: 1 })];
    layout(next);
    const changed = diffChangedNodes(prev, next);
    expect(changed.ids).toEqual(["w2"]);
  });
  it("tags nested days with their week", () => {
    const root = weekPlan();
    expect(tagFor(root, root.children![0].children![1])).toBe("Week 1 · Day 2");
    expect(tagFor(root, root.children![1])).toBe("Week 2");
  });
});
