import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlanning } from "@/lib/planningLock";
import { sampleDayPlan } from "@/lib/testPlans";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("./actions", () => ({ expandNodeAction: vi.fn() }));

const { PlanOutline } = await import("./PlanOutline");

const render = (root = sampleDayPlan()) =>
  renderToStaticMarkup(createElement(PlanOutline, { trackId: "t", root, granularity: "day", daysPerWeek: 5, selectedId: "b2", currentLeafId: "b2" }));

describe("PlanOutline while the pane is planning", () => {
  afterEach(() => setPlanning("pane", false));

  it("can't start planning everything", () => {
    expect(render()).toMatch(/<button(?![^>]* disabled="")[^>]*>Plan everything<\/button>/);
    setPlanning("pane", true);
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Plan everything<\/button>/);
  });

  it("hides the rows' planning buttons", () => {
    expect(render()).toContain("Plan Week 3");
    setPlanning("pane", true);
    expect(render()).not.toContain("Plan Week 3");
  });
});

describe("PlanOutline root problems", () => {
  it("shows the plan's problems above the outline, one per line", () => {
    const root = sampleDayPlan();
    root.problems = ["Problems add up to 21 h; the time split gave them 26 h.", "Another top-level problem."];
    const html = render(root);
    expect(html).toContain("Problems add up to 21 h; the time split gave them 26 h.");
    expect(html).toContain("Another top-level problem.");
    expect(html.indexOf("Another top-level problem.")).toBeLessThan(html.indexOf("Week w1"));
  });

  it("shows none when the plan has no problems", () => {
    expect(render()).not.toMatch(/<p[ >]/);
  });
});
