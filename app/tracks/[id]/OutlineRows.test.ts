import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findNode, type PlanNode } from "@/lib/planTree";
import { day, sampleDayPlan, sampleWeekPlan } from "@/lib/testPlans";
import { Row, openUnits, type Ctx } from "./OutlineRows";

const planning = { isPending: false, planning: false, pending: {}, run: () => {} } as unknown as Ctx["planning"];

function render(root: PlanNode, id: string, selectedId: string): string {
  const ctx: Ctx = { root, selectedId, currentLeafId: null, open: new Set(), toggle: () => {}, reveal: () => {}, planning };
  ctx.currentLeafId = root.children?.find((n) => n.status !== "completed")?.id ?? null;
  return renderToStaticMarkup(createElement(Row, { node: findNode(root, id)!, depth: 0, ctx })).replace(/<!-- -->/g, "");
}

describe("outline rows on a week track", () => {
  it("shows a finished week as done instead of its budget", () => {
    const html = render(sampleWeekPlan(), "w1", "w2");
    expect(html).toContain('data-state="done"');
    expect(html).not.toContain("4 h");
  });

  it("marks the current week", () => {
    const html = render(sampleWeekPlan(), "w2", "w1");
    expect(html).toContain('data-state="current"');
    expect(html).toContain("This week");
  });
});

describe("inline planning buttons", () => {
  it("leave the selected row's action to the pane", () => {
    expect(render(sampleDayPlan(), "w3", "w3")).not.toContain("Plan Week 3");
  });

  it("can't be tapped on other rows until they show on hover", () => {
    const html = render(sampleDayPlan(), "w3", "b2");
    expect(html).toContain("Plan Week 3");
    // Tailwind's hover variants apply only where the device can hover, so on touch the button never takes taps.
    expect(html).toMatch(/class="[^"]*\bpointer-events-none\b[^"]*\bgroup-hover:pointer-events-auto\b[^"]*"[^>]*>Plan Week 3/);
  });
});

describe("openUnits", () => {
  it("opens the way to the current leaf, less finished units, and the selected unit", () => {
    const open = openUnits(sampleDayPlan(), "b2", "w1", new Map());
    expect([...open].sort()).toEqual(["w1", "w2"]);
  });

  it("opens a selected unit once planning gives it days", () => {
    const before = sampleDayPlan();
    expect(openUnits(before, "b2", "w3", new Map()).has("w3")).toBe(false);
    const after = sampleDayPlan();
    findNode(after, "w3")!.children = [day("c1"), day("c2"), day("c3")];
    expect(openUnits(after, "b2", "w3", new Map()).has("w3")).toBe(true);
  });

  it("opens the way to a new current leaf", () => {
    const root = sampleDayPlan();
    for (const id of ["b2", "b3"]) findNode(root, id)!.status = "completed";
    findNode(root, "w3")!.children = [day("c1"), day("c2"), day("c3")];
    const open = openUnits(root, "c1", "c1", new Map());
    expect(open.has("w3")).toBe(true);
    expect(open.has("w2")).toBe(false);
  });

  it("keeps what the learner opened and closed", () => {
    const open = openUnits(sampleDayPlan(), "b2", "b2", new Map([["w1", true], ["w2", false]]));
    expect(open.has("w1")).toBe(true);
    expect(open.has("w2")).toBe(false);
  });
});
