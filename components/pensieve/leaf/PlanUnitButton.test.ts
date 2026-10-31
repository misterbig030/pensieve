import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlanning } from "@/lib/planningLock";

vi.mock("@/app/tracks/[id]/actions", () => ({ expandNodeAction: vi.fn() }));

const { PlanUnitButton } = await import("./PlanUnitButton");

describe("PlanUnitButton", () => {
  it("lets a week be split into a number of days other than the usual", () => {
    const html = renderToStaticMarkup(createElement(PlanUnitButton, { trackId: "t", nodeId: "w2", reason: "split", label: "Split into days", daysPerWeek: 4, hoursPerWeek: 8 }));
    expect(html).toContain('aria-label="Split into 4 days, or choose another number"');
  });
});

describe("PlanUnitButton while the outline is planning", () => {
  afterEach(() => setPlanning("outline", false));
  const render = (reason: "expand" | "split") =>
    renderToStaticMarkup(createElement(PlanUnitButton, { trackId: "t", nodeId: "w2", reason, label: "Plan Week 2", daysPerWeek: 4, hoursPerWeek: 8 }));

  it("can't plan a unit", () => {
    expect(render("expand")).not.toContain(" disabled=\"\"");
    setPlanning("outline", true);
    expect(render("expand")).toMatch(/<button[^>]*disabled=""[^>]*>Plan Week 2<\/button>/);
  });

  it("can't split a week", () => {
    expect(render("split")).toMatch(/<button(?![^>]* disabled="")[^>]*>/);
    setPlanning("outline", true);
    expect(render("split")).not.toMatch(/<button(?![^>]* disabled="")[^>]*>/);
  });
});
