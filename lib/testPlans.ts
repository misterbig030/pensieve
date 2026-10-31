/** Plan trees shared by tests. Not used by the app. */

import { makeNode, makeRoot, type NodeStatus, type PlanNode } from "@/lib/planTree";

export function day(id: string, status: NodeStatus = "pending"): PlanNode {
  return makeNode({ id, level: "day", title: `Day ${id}`, summary: "", len: 1, status });
}

export function week(id: string, children: PlanNode[] | null, extra: { len?: number; status?: NodeStatus; budgetHours?: number } = {}): PlanNode {
  return makeNode({ id, level: "week", title: `Week ${id}`, summary: "", len: extra.len ?? children?.length ?? 5, children, status: extra.status, budgetHours: extra.budgetHours });
}

/**
 * Week 1: three finished days. Week 2: one finished, one with its lesson written (the current leaf), one open.
 * Week 3: not planned yet, three days long.
 */
export function sampleDayPlan(): PlanNode {
  return makeRoot([
    week("w1", [day("a1", "completed"), day("a2", "completed"), day("a3", "completed")]),
    week("w2", [day("b1", "completed"), day("b2", "generated"), day("b3")]),
    week("w3", null, { len: 3 }),
  ]);
}

/** Three week leaves on a week-granularity track: done, current, open. */
export function sampleWeekPlan(): PlanNode {
  return makeRoot([
    week("w1", null, { len: 5, status: "completed", budgetHours: 4 }),
    week("w2", null, { len: 5, budgetHours: 4 }),
    week("w3", null, { len: 5, budgetHours: 4 }),
  ]);
}

/** A week track whose Week 2 was split into five days, one finished (Week 2 holds the current leaf). */
export function sampleSplitWeekPlan(): PlanNode {
  return makeRoot([
    week("w1", null, { len: 5, status: "completed", budgetHours: 4 }),
    week("w2", [day("b1", "completed"), day("b2"), day("b3"), day("b4"), day("b5")]),
    week("w3", null, { len: 5, budgetHours: 4 }),
  ]);
}

/** Month 1 holds two weeks of two days; Month 2 is not planned yet. */
export function sampleMonthPlan(): PlanNode {
  return makeRoot([
    makeNode({
      id: "m1",
      level: "month",
      title: "Month m1",
      summary: "",
      len: 4,
      children: [week("w1", [day("a1", "completed"), day("a2", "completed")]), week("w2", [day("b1", "completed"), day("b2")])],
    }),
    makeNode({ id: "m2", level: "month", title: "Month m2", summary: "", len: 8 }),
  ]);
}
