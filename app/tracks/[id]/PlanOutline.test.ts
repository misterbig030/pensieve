import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlanning } from "@/lib/planningLock";
import { sampleDayPlan } from "@/lib/testPlans";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("./actions", () => ({ expandNodeAction: vi.fn() }));

const { PlanOutline } = await import("./PlanOutline");

const render = () =>
  renderToStaticMarkup(createElement(PlanOutline, { trackId: "t", root: sampleDayPlan(), granularity: "day", daysPerWeek: 5, selectedId: "b2", currentLeafId: "b2" }));

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
