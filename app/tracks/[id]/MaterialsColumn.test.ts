import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import type { MaterialPlacement } from "@/lib/materialUses";
import type { Material } from "@/lib/schemas/material";
import { columnTotals } from "./columnLines";
import { MaterialsColumn } from "./MaterialsColumn";

const book = AIE_MATERIALS.find((m) => m.kind === "book")!;
const mat = (id: string, extra: Partial<Material> = {}): Material => ({ ...book, id, title: `Title ${id}`, backbone: false, origin: "research", ...extra });
const materials = [mat("A", { backbone: true }), mat("B"), mat("C"), mat("D")];
const placement: MaterialPlacement = {
  used: [{ material: materials[0], part: "ch. 1–2" }],
  later: [{ material: materials[1], place: "from Week 3" }],
  earlier: [{ material: materials[2], place: "Week 1" }],
  unused: [materials[3]],
};
const render = (props: Partial<Parameters<typeof MaterialsColumn>[0]> = {}) =>
  renderToStaticMarkup(createElement(MaterialsColumn, { materials, unitLabel: "Week 2", placement, ...props })).replace(/<!-- -->/g, "");

describe("MaterialsColumn", () => {
  it("opens on the selected unit with its materials first", () => {
    const html = render();
    expect(html).toContain("Used in Week 2");
    expect(html.indexOf("Title A")).toBeLessThan(html.indexOf("Later in the plan"));
    expect(html).toContain("ch. 1–2");
    expect(html).toContain("Later in the plan");
    expect(html).toContain("from Week 3");
    expect(html).toContain("Earlier");
  });

  it("opens on All when the unit uses nothing, and says why", () => {
    const html = render({ placement: { used: [], later: placement.later, earlier: [], unused: [materials[0], materials[2], materials[3]] } });
    expect(html).not.toContain("Used in");
    expect(html).toContain("Backbone");
    expect(html).toContain("Books");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Nothing in Week 2 uses a material yet"|<button[^>]*title="Nothing in Week 2 uses a material yet"[^>]*disabled=""/);
  });

  it("marks materials the plan does not use", () => {
    expect(render()).toContain("Not in the plan yet");
  });

  it("shows totals and the checked line", () => {
    const html = render();
    expect(html).toContain("Materials");
    expect(html).toContain(columnTotals(materials));
    expect(html).toContain("all checked");
  });

  it("lists every material, with no Show all", () => {
    const many = Array.from({ length: 15 }, (_, i) => mat(`M${i}`));
    const html = render({ materials: many, placement: { used: [], later: [], earlier: [], unused: many } });
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(15);
    expect(html).not.toContain("Show all");
  });

  it("says when the track has no materials", () => {
    expect(render({ materials: [], placement: { used: [], later: [], earlier: [], unused: [] } })).toContain("This track has no materials.");
  });
});
