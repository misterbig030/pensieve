import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS } from "@/lib/__fixtures__/problemList";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import type { CoverRef, Material, PracticeCover, PracticeRef } from "@/lib/schemas/material";
import { CoversRow, PlanTree, coverLines } from "./PlanTree";

const bank: Material = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "nc", title: "NeetCode 150", backbone: false, practice: LISTED_PROBLEMS };
const plain: Material = { ...AIE_MATERIALS.find((m) => m.id === "oaievals")!, id: "mock", title: "Mock Bank", backbone: false, practice: { format: "mock", items: 10, perItemMinutes: 30, minutes: 300, answers: false } };
const byId = new Map<string, Material>([...AIE_MATERIALS, bank, plain].map((m) => [m.id, m]));

const week = (practiceCovers: PracticeCover[], covers: CoverRef[] = []) => makeNode({ level: "month", title: "M", summary: "s", len: 14, covers, practiceCovers });
const render = (node: ReturnType<typeof week>) => renderToStaticMarkup(createElement(CoversRow, { node, byId })).replace(/<!-- -->/g, "");

const lines = (node: ReturnType<typeof week>) => coverLines(node, byId).map((l) => `${l.m.title}${l.part ? ` · ${l.part}` : ""}`);

describe("coverLines", () => {
  it("names a listed source by its format and the groups its run spans", () => {
    expect(lines(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 14 }]))).toEqual(["NeetCode 150 · Problems · Arrays & Hashing – Two Pointers"]);
  });
  it("names a single group alone, and every group of a long run as first – last", () => {
    expect(lines(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 9 }]))).toEqual(["NeetCode 150 · Problems · Arrays & Hashing"]);
    expect(lines(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 5, itemTo: 21 }]))).toEqual(["NeetCode 150 · Problems · Arrays & Hashing – Stack"]);
  });
  it("names a source without a list by its format and note", () => {
    expect(lines(week([{ format: "mock", id: "mock", note: "two rounds" }]))).toEqual(["Mock Bank · Mock · two rounds"]);
    expect(lines(week([{ format: "mock", id: "mock", note: null }]))).toEqual(["Mock Bank · Mock"]);
  });
  it("lists every reservation, the backbone first with its chapters by number and title, practice after the reading", () => {
    const covers: CoverRef[] = [{ id: "evals", note: null }, { id: "aie", note: null, chapter: 3 }, { id: "aie", note: null, chapter: 4 }, { id: "oaievals", note: "the graders guide" }];
    const out = lines(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 9 }, { format: "mock", id: "mock", note: null }], covers));
    const aie = AIE_MATERIALS.find((m) => m.id === "aie")!;
    const evals = AIE_MATERIALS.find((m) => m.id === "evals")!;
    const oai = AIE_MATERIALS.find((m) => m.id === "oaievals")!;
    expect(out).toEqual([
      `${aie.title} · ch. 3 Evaluation Methodology; ch. 4 Evaluate AI Systems`,
      evals.title,
      `${oai.title} · the graders guide`,
      "NeetCode 150 · Problems · Arrays & Hashing",
      "Mock Bank · Mock",
    ]);
  });
  it("marks a second pass as a review", () => {
    const aie = AIE_MATERIALS.find((m) => m.id === "aie")!;
    expect(lines(week([], [{ id: "aie", note: null, chapter: 2, activity: "review" }]))).toEqual([`${aie.title} · Review of ch. 2 Understanding Foundation Models`]);
  });
  it("has no line for a reservation whose material is not in the list", () => {
    expect(lines(week([{ format: "design-exercise", id: null, note: "x", task: "Design a limiter", minutes: 30 }], [{ id: "gone", note: null }]))).toEqual([]);
  });
});

describe("CoversRow", () => {
  it("lists each material by its short title, its full title as the tooltip, with nothing held back", () => {
    const repo: Material = { ...bank, id: "repo", title: "GitHub - mdmzfzl/NeetCode-Solutions: My solutions in C++, Python and Rust · GitHub" };
    const covers: CoverRef[] = ["aie", "evals", "oaievals"].map((id) => ({ id, note: null }));
    const node = week([{ format: "problem-set", id: "repo", note: null, itemFrom: 1, itemTo: 9 }, { format: "mock", id: "mock", note: null }], covers);
    const html = renderToStaticMarkup(createElement(CoversRow, { node, byId: new Map([...byId, ["repo", repo]]) })).replace(/<!-- -->/g, "");
    expect(html.match(/<li/g)).toHaveLength(5);
    expect(html).toContain('title="GitHub - mdmzfzl/NeetCode-Solutions: My solutions in C++, Python and Rust · GitHub">NeetCode Solutions</span>');
    expect(html).toContain("NeetCode Solutions</span><span class=\"text-muted-foreground\"> · Problems · Arrays &amp; Hashing</span>");
    expect(html).toContain(">AI Engineering</span>");
    expect(html).not.toContain("more");
  });
  it("renders nothing for a heading with no reservation", () => {
    expect(render(week([]))).toBe("");
  });
});

describe("a collapsed day card's practice lines", () => {
  const listed: PracticeRef = { format: "problem-set", id: "nc", task: "NeetCode 150 · Arrays & Hashing, problem 1", done: "solved", minutes: 15, generated: false, itemFrom: 1, itemTo: 1 };
  const plainRow: PracticeRef = { format: "mock", id: "mock", task: "One mock round", done: "debriefed", minutes: 45, generated: false };
  const tree = () => {
    const d1 = makeNode({ id: "d1", level: "day", title: "Hashing", summary: "s", len: 1, practice: [listed, plainRow] });
    return layout(makeRoot([makeNode({ id: "w1", level: "week", title: "Arrays", summary: "s", len: 1, children: [d1] })]));
  };
  const none = new Set<string>();
  const html = () =>
    renderToStaticMarkup(
      createElement(PlanTree, {
        root: tree(),
        mode: "create",
        highlight: none,
        lockBefore: 0,
        currentLeafId: null,
        pending: {},
        collapsed: none,
        openChips: none,
        busy: false,
        onToggle: () => {},
        onToggleChip: () => {},
        onExpand: () => {},
        onSplit: () => {},
        materials: [...byId.values()],
        hoursPerWeek: 6,
        daysPerWeek: 5,
      }),
    ).replace(/<!-- -->/g, "");

  it("shows a listed item as number and title with its group, and other rows by their task", () => {
    const out = html();
    expect(out).toContain("217. Contains Duplicate");
    expect(out).toMatch(/217\. Contains Duplicate<span[^>]*>Arrays &amp; Hashing<\/span>/);
    expect(out).not.toContain("problem 1");
    expect(out).toContain("One mock round");
  });
});
