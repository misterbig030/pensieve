import { describe, expect, it } from "vitest";
import { renderMaterials } from "@/lib/ai/planPrompt";
import { layout, makeRoot, type PlanNode } from "@/lib/planTree";
import { loadFixture } from "./fixtures";
import { TASKS } from "./task";
import { renderOutline } from "./tasks/outline";
import { loadOutlineFixture, type OutlineFixture } from "./tasks/outlineFixtures";

function node(extra: Partial<PlanNode>): PlanNode {
  return { id: "n", level: "week", title: "t", summary: "s", len: 2, status: "pending", budgetHours: null, manualSplit: false, children: null, start: 1, end: 1, ...extra };
}

describe("judgeViewChars", () => {
  it("is allocate's rendered materials, as the estimate always took them", () => {
    const fixture = loadFixture("sde-1");
    expect(TASKS.allocate.judgeViewChars(fixture)).toBe(renderMaterials(fixture.input.materials).length);
  });

  it("is outline's whole judge view: the view with the level left empty, and the level at the baseline's length", () => {
    const fixture = loadOutlineFixture("csapp-1/week-1");
    const empty = renderOutline({ nodes: [], units: [], breaches: [], problems: [] }, fixture).length;
    expect(TASKS.outline.judgeViewChars(fixture)).toBe(empty + fixture.baseline.outputTokens * 4);
    expect(TASKS.outline.judgeViewChars(fixture)).toBeGreaterThan(renderMaterials(fixture.materials).length + fixture.baseline.outputTokens * 4);
  });

  it("grows with the tree around the level", () => {
    const fixture = loadOutlineFixture("csapp-1/week-1");
    const weeks = (n: number) => layout(makeRoot(Array.from({ length: n }, (_, i) => node({ id: `w${i + 1}`, title: `Week ${i + 1} title`, summary: "A summary of what this week covers" }))));
    const small: OutlineFixture = { ...fixture, tree: weeks(2), parentId: "w1" };
    const large: OutlineFixture = { ...fixture, tree: weeks(8), parentId: "w1" };
    expect(TASKS.outline.judgeViewChars(large)).toBeGreaterThan(TASKS.outline.judgeViewChars(small));
  });
});
