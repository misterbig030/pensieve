import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import { sampleDayPlan } from "@/lib/testPlans";

vi.mock("@/lib/db/planQueries", () => ({ getLeafWithContent: vi.fn() }));
vi.mock("@/app/tracks/[id]/actions", () => ({ expandNodeAction: vi.fn(), markCompleteAction: vi.fn() }));

const { DayPane, UnitPane } = await import("./DayPane");

function render(root: PlanNode, id: string): string {
  const node = root.children!.find((n) => n.id === id)!;
  const props = { trackId: "t", root, node, currentLeafId: null, materials: AIE_MATERIALS, hoursPerWeek: 6, daysPerWeek: 7, userId: "u" };
  return renderToStaticMarkup(createElement(UnitPane, props)).replace(/<!-- -->/g, "");
}

describe("UnitPane", () => {
  it("shows what a unit not planned yet will cover and its time", () => {
    const root = makeRoot([makeNode({ id: "m2", level: "month", title: "Evals", summary: "", len: 14, covers: [{ id: "aie", chapter: 3, note: null }] })]);
    const html = render(root, "m2");
    expect(html).toContain("ch. 3");
    expect(html).toContain("about 12 h");
  });

  it("lists a planned unit's days", () => {
    const html = render(sampleDayPlan(), "w2");
    expect(html).toContain('href="?day=b1"');
    expect(html).toContain('href="?day=b3"');
  });
});

describe("DayPane", () => {
  it("keys the pane by its row, so a button's pending state or error stays with the row it was clicked on", async () => {
    const root = sampleDayPlan();
    const props = { trackId: "t", root, currentLeafId: null, materials: AIE_MATERIALS, hoursPerWeek: 6, daysPerWeek: 7, userId: "u" };
    for (const id of ["w2", "b1"]) {
      const node = id === "w2" ? root.children!.find((n) => n.id === id)! : root.children!.flatMap((n) => n.children ?? []).find((n) => n.id === id)!;
      expect((await DayPane({ ...props, node }))?.key).toBe(id);
    }
  });
});
