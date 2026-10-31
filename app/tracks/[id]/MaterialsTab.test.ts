import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { approxDuration } from "@/lib/researchProgress";
import type { Material } from "@/lib/schemas/material";
import { materialGroups, materialTotals } from "@/components/pensieve/MaterialsList";
import { MaterialsTab } from "./MaterialsTab";

const book = AIE_MATERIALS.find((m) => m.kind === "book")!;
const extra: Material[] = Array.from({ length: 12 }, (_, i) => ({ ...book, id: `X${i}`, title: `Extra book ${i}`, backbone: false }));
const materials = [...AIE_MATERIALS, ...extra];
const render = () => renderToStaticMarkup(createElement(MaterialsTab, { topic: "AI engineering", materials })).replace(/<!-- -->/g, "");

describe("MaterialsTab", () => {
  it("shows every material, with no Show all", () => {
    const html = render();
    for (const m of materials) expect(html).toContain(m.title.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    expect(html).not.toContain("Show all");
  });

  it("links each group from Jump to, and every anchor exists", () => {
    const html = render();
    const groups = materialGroups(materials);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) {
      expect(html).toContain(`href="#${g.anchor}"`);
      expect(html).toContain(`id="${g.anchor}"`);
    }
  });

  it("sums reading and practice hours and counts each kind", () => {
    const html = render();
    const { readingMinutes, practiceMinutes } = materialTotals(materials);
    expect(html).toContain(`${materials.length} materials`);
    expect(html).toContain(approxDuration(readingMinutes).replace("≈ ", ""));
    if (practiceMinutes > 0) expect(html).toContain(approxDuration(practiceMinutes).replace("≈ ", ""));
    const books = materialGroups(materials).find((g) => g.label === "Books")!;
    expect(books.count).toBeGreaterThanOrEqual(12);
    expect(html).toMatch(new RegExp(`Books</span>.*?>${books.count}<`));
  });

  it("says how many materials the totals leave out for having no size", () => {
    const unsized: Material = { ...book, id: "U", title: "Unsized", backbone: false, minutes: undefined, practice: undefined };
    const html = renderToStaticMarkup(createElement(MaterialsTab, { topic: "AI engineering", materials: [...materials, unsized] }));
    expect(html).toContain("Not counting 1 with no size");
    expect(render()).not.toContain("with no size");
  });

  it("doesn't repeat the list's heading", () => {
    const html = render();
    expect(html).not.toContain("materials-h");
    expect(html.match(/Sizes are for the part the plan uses/g)).toHaveLength(1);
  });
});
