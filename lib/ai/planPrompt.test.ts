import { describe, expect, it } from "vitest";
import { makeNode, makeRoot } from "@/lib/planTree";
import { assignRefs, buildPlanChatSystemPrompt, buildRevisionPrompt, buildUnitsPrompt, renderTree } from "./planPrompt";

function tree() {
  return makeRoot([
    makeNode({
      id: "w1",
      level: "week",
      title: "Inference fundamentals",
      summary: "The vocabulary.",
      len: 2,
      children: [
        makeNode({ id: "d1", level: "day", title: "Intro", summary: "What inference is.", len: 1, status: "completed" }),
        makeNode({ id: "d2", level: "day", title: "Metrics", summary: "Latency and throughput.", len: 1 }),
      ],
    }),
    makeNode({ id: "w2", level: "week", title: "GPUs", summary: "Where time goes.", len: 7 }),
  ]);
}

describe("renderTree", () => {
  it("renders labels, spans, refs and marks", () => {
    const root = tree();
    const text = renderTree(root, { refs: assignRefs(root), lockBefore: 1, markId: "w2" });
    expect(text).toBe(
      [
        'Week 1 [n1] (Day 1–2, 2 days): "Inference fundamentals" — The vocabulary.',
        '  Day 1 [n2]: "Intro" — What inference is. [done]',
        '  Day 2 [n3]: "Metrics" — Latency and throughput.',
        '>> Week 2 [n4] (Day 3–9, 7 days): "GPUs" — Where time goes. [not yet planned in detail]',
      ].join("\n"),
    );
  });
  it("marks week-sized leaves", () => {
    const root = makeRoot([makeNode({ id: "w", level: "week", title: "A", summary: "b", len: 7, budgetHours: 6 })]);
    expect(renderTree(root)).toContain("[week-sized unit, logged as sessions]");
  });
});

describe("buildUnitsPrompt", () => {
  it("lists the spans and asks for exactly that many units", () => {
    const prompt = buildUnitsPrompt({
      topic: "AI infra",
      sources: [],
      granularity: "day",
      level: "week",
      spans: [7, 7, 8, 8],
      startDay: 1,
      totalDays: 30,
      unitsAreLeaves: false,
    });
    expect(prompt).toContain("Split the plan into 4 weeks");
    expect(prompt).toContain("1. Days 1–7 (7 days)");
    expect(prompt).toContain("4. Days 23–30 (8 days)");
    expect(prompt).toContain("Return exactly 4 units");
    expect(prompt).toContain("heading that will be planned in detail later");
  });
  it("includes the tree and marks the parent when expanding", () => {
    const root = tree();
    const prompt = buildUnitsPrompt({
      topic: "AI infra",
      sources: [],
      granularity: "day",
      level: "day",
      spans: [1, 1, 1, 1, 1, 1, 1],
      startDay: 3,
      totalDays: 9,
      tree: root,
      parentId: "w2",
      unitsAreLeaves: true,
    });
    expect(prompt).toContain('>> Week 2 (Day 3–9, 7 days): "GPUs"');
    expect(prompt).toContain("Plan the days inside the unit marked");
    expect(prompt).toContain("1. Day 3");
    expect(prompt).toContain("Each day is one focused lesson");
  });
  it("describes week leaves as session goals", () => {
    const prompt = buildUnitsPrompt({ topic: "X", sources: [], granularity: "week", level: "week", spans: [7], startDay: 1, totalDays: 7, unitsAreLeaves: true });
    expect(prompt).toContain("across several sessions");
  });
});

describe("buildRevisionPrompt", () => {
  it("shows refs and the rules", () => {
    const root = tree();
    const prompt = buildRevisionPrompt({ topic: "AI infra", sources: [], granularity: "day", tree: root, refs: assignRefs(root), lockBefore: 1, changeRequest: "Swap Week 1 and Week 2" });
    expect(prompt).toContain('The learner asks: "Swap Week 1 and Week 2"');
    expect(prompt).toContain("Day 1 [n2]");
    expect(prompt).toContain("[done]");
    expect(prompt).toContain("Keep the ref of every unit you keep");
  });
});

describe("buildPlanChatSystemPrompt", () => {
  it("states locks in adjust mode and lists the plan", () => {
    const prompt = buildPlanChatSystemPrompt({ mode: "adjust", topic: "AI infra", sources: [], granularity: "day", tree: tree(), lockBefore: 1 });
    expect(prompt).toContain("Day 1 is completed and locked");
    expect(prompt).toContain('Week 2 (Day 3–9, 7 days): "GPUs"');
    expect(prompt).toContain("call revisePlan exactly once");
  });
});
