import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS } from "@/lib/__fixtures__/problemList";
import { makeNode } from "@/lib/planTree";
import type { CoverRef, Material, PracticeCover } from "@/lib/schemas/material";
import { CoversRow } from "./PlanTree";

const bank: Material = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "nc", title: "NeetCode 150", backbone: false, practice: LISTED_PROBLEMS };
const plain: Material = { ...AIE_MATERIALS.find((m) => m.id === "oaievals")!, id: "mock", title: "Mock Bank", backbone: false, practice: { format: "mock", items: 10, perItemMinutes: 30, minutes: 300, answers: false } };
const byId = new Map<string, Material>([...AIE_MATERIALS, bank, plain].map((m) => [m.id, m]));

const week = (practiceCovers: PracticeCover[], covers: CoverRef[] = []) => makeNode({ level: "month", title: "M", summary: "s", len: 14, covers, practiceCovers });
const render = (node: ReturnType<typeof week>) => renderToStaticMarkup(createElement(CoversRow, { node, byId })).replace(/<!-- -->/g, "");

describe("CoversRow practice reservations", () => {
  it("shows a listed source as the groups its run spans", () => {
    const html = render(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 14 }]));
    expect(html).toContain("NeetCode 150 · Arrays &amp; Hashing – Two Pointers");
  });
  it("names a single group alone, and every group of a long run as first – last", () => {
    expect(render(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 9 }]))).toContain("NeetCode 150 · Arrays &amp; Hashing<");
    expect(render(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 5, itemTo: 21 }]))).toContain("NeetCode 150 · Arrays &amp; Hashing – Stack");
  });
  it("shows a source without a list as its note", () => {
    const html = render(week([{ format: "mock", id: "mock", note: "two rounds" }]));
    expect(html).toContain("Mock Bank · two rounds");
  });
  it("puts practice after the reading, and counts both in the overflow", () => {
    const covers: CoverRef[] = [{ id: "aie", note: null }, { id: "evals", note: null }];
    const html = render(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 9 }, { format: "mock", id: "mock", note: null }], covers));
    expect(html.indexOf(AIE_MATERIALS.find((m) => m.id === "aie")!.title)).toBeLessThan(html.indexOf("NeetCode 150"));
    expect(html).toContain("+ 1 more");
    expect(html).not.toContain("Mock Bank");
  });
  it("shows a week that reserves only practice, and nothing for a reservation without a source", () => {
    expect(render(week([{ format: "mock", id: "mock", note: null }]))).toContain("Mock Bank");
    expect(render(week([{ format: "design-exercise", id: null, note: "x", task: "Design a limiter", minutes: 30 }]))).toBe("");
  });
});
