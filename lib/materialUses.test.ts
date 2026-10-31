import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { findNode, makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { CoverRef, Material, MaterialRef, PracticeRef } from "@/lib/schemas/material";
import { materialPlacement, placeLabel } from "./materialUses";

const base = AIE_MATERIALS[0];
const mat = (id: string): Material => ({ ...base, id, title: `Title ${id}`, backbone: false });
const materials = ["A", "B", "C", "D", "E"].map(mat);

const read = (id: string, chapter?: number): MaterialRef => ({ id, tier: "must", minutes: 30, note: null, chapter: chapter ?? null });
const cover = (id: string): CoverRef => ({ id, note: null });
const problems = (id: string | null, itemFrom: number, itemTo: number): PracticeRef => ({
  format: "problem-set",
  id,
  task: "Solve",
  done: "Solved",
  minutes: 30,
  generated: false,
  itemFrom,
  itemTo,
});
const day = (id: string, extra: { materials?: MaterialRef[]; practice?: PracticeRef[] } = {}) =>
  makeNode({ id, level: "day", title: id, summary: id, len: 1, ...extra });
const week = (id: string, children: PlanNode[] | null, extra: { covers?: CoverRef[] } = {}) =>
  makeNode({ id, level: "week", title: id, summary: id, len: children ? children.length : 5, children, ...extra });

// Week 1: A ch. 1 on day 1, A ch. 2 and problems 3–8 from B on day 2, C on day 5. Week 2 reserves C.
// Week 3 reserves D; week 4 reserves D again. E is never used.
function weekPlan(): PlanNode {
  return makeRoot([
    week("w1", [
      day("w1d1", { materials: [read("A", 1)] }),
      day("w1d2", { materials: [read("A", 2)], practice: [problems("B", 3, 8), problems(null, 1, 2)] }),
      day("w1d3"),
      day("w1d4"),
      day("w1d5", { materials: [read("C")] }),
    ]),
    week("w2", null, { covers: [cover("B")] }),
    week("w3", null, { covers: [cover("C"), cover("D")] }),
    week("w4", null, { covers: [cover("D")] }),
  ]);
}

const node = (root: PlanNode, id: string) => findNode(root, id)!;
const titles = (rows: { material: Material }[]) => rows.map((r) => r.material.id);

describe("placeLabel", () => {
  it("names a day by its week", () => {
    const root = weekPlan();
    expect(placeLabel(root, node(root, "w1d5"))).toBe("Week 1 · Day 5");
    expect(placeLabel(root, node(root, "w3"))).toBe("Week 3");
  });

  it("names a week in a month plan", () => {
    const month = (id: string, weeks: PlanNode[]) => makeNode({ id, level: "month", title: id, summary: id, len: 10, children: weeks });
    const root = makeRoot([month("m1", [week("m1w1", null), week("m1w2", null)]), month("m2", [week("m2w1", null), week("m2w2", null)])]);
    expect(placeLabel(root, node(root, "m2w1"))).toBe("Month 2 · Week 1");
  });
});

describe("materialPlacement", () => {
  it("lists what the selected week uses, with its chapters and items", () => {
    const root = weekPlan();
    const { used } = materialPlacement(root, materials, node(root, "w1"));
    expect(titles(used)).toEqual(["A", "B", "C"]);
    expect(used.map((u) => u.part)).toEqual(["ch. 1–2", "items 3–8", ""]);
  });

  it("prints chapters by the book's own numbers, not their place in its list", () => {
    const toc = {
      source: "model",
      url: "https://example.com",
      printPages: false,
      end: null,
      chapters: [
        { n: null, title: "Preface", page: null, minutes: null },
        { n: 1, title: "Foundations", page: null, minutes: null },
        { n: 2, title: "Storage", page: null, minutes: null },
      ],
    } as unknown as Material["toc"];
    const withToc = [{ ...materials[0], toc }, ...materials.slice(1)];
    const root = makeRoot([week("w1", [day("w1d1", { materials: [read("A", 2)] }), day("w1d2", { materials: [read("A", 3)] })])]);
    expect(materialPlacement(root, withToc, node(root, "w1")).used[0].part).toBe("ch. 1–2");
  });

  it("names the next use after the selected unit for a material used before and after it", () => {
    const root = weekPlan();
    const { later } = materialPlacement(root, materials, node(root, "w2"));
    const c = later.find((r) => r.material.id === "C")!;
    expect(c.place).toBe("Week 3");
  });

  it("says from when later uses fall in more than one place", () => {
    const root = weekPlan();
    const { later } = materialPlacement(root, materials, node(root, "w2"));
    expect(later.find((r) => r.material.id === "D")!.place).toBe("from Week 3");
    expect(titles(later)).toEqual(["C", "D"]);
  });

  it("puts a material used only before under earlier, with its last place", () => {
    const root = weekPlan();
    const { earlier } = materialPlacement(root, materials, node(root, "w3"));
    expect(earlier).toEqual([
      { material: materials[1], place: "Week 2" },
      { material: materials[0], place: "Week 1" },
    ]);
  });

  it("with a day selected, names another day of its week", () => {
    const root = weekPlan();
    const { used, later, earlier } = materialPlacement(root, materials, node(root, "w1d2"));
    expect(titles(used)).toEqual(["A", "B"]);
    expect(later.find((r) => r.material.id === "C")!.place).toBe("from Week 1 · Day 5");
    expect(earlier).toEqual([]);
  });

  it("ignores a reservation on a heading above the selected unit", () => {
    const root = makeRoot([week("w1", [day("w1d1"), day("w1d2")], { covers: [cover("A")] })]);
    const { used, later, earlier, unused } = materialPlacement(root, materials, node(root, "w1d1"));
    expect(titles(used)).toEqual([]);
    expect(later).toEqual([{ material: materials[0], place: "Week 1" }]);
    expect(titles(earlier)).toEqual([]);
    expect(unused.map((m) => m.id)).not.toContain("A");
  });

  it("ignores practice rows with no source", () => {
    const root = makeRoot([week("w1", [day("w1d1", { practice: [problems(null, 1, 2)] })])]);
    expect(titles(materialPlacement(root, materials, node(root, "w1")).used)).toEqual([]);
  });

  it("lists materials the plan does not use as unused", () => {
    const root = weekPlan();
    expect(materialPlacement(root, materials, node(root, "w1")).unused.map((m) => m.id)).toEqual(["E"]);
  });
});
