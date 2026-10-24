import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS } from "@/lib/__fixtures__/problemList";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import type { CoverRef, Material, PracticeCover, PracticeRef } from "@/lib/schemas/material";
import { CoversRow, PlanTree } from "./PlanTree";

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
    expect(html).toContain('title="Mock Bank"');
  });
  it("keeps a practice chip visible on a reading-heavy week; reading gives way, named in the overflow's title", () => {
    const titles = ["aie", "evals", "oaievals"].map((id) => AIE_MATERIALS.find((m) => m.id === id)!);
    const covers: CoverRef[] = titles.map((m) => ({ id: m.id, note: null }));
    const html = render(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 9 }], covers));
    expect(html).toContain("NeetCode 150 · Arrays &amp; Hashing");
    expect(html).toContain("+ 1 more");
    const shownReading = titles.filter((m) => html.includes(`>${m.title.replace(/&/g, "&amp;")}</span>`) || html.includes(`>${m.title.replace(/&/g, "&amp;")} ·`));
    expect(shownReading).toHaveLength(2);
    const hiddenTitle = html.match(/title="([^"]*)" class="rounded-full bg-background px-\[9px\] py-\[3px\]">\+ 1 more/)![1];
    const hidden = titles.filter((m) => !shownReading.includes(m));
    expect(hiddenTitle).toContain(hidden[0].title.replace(/&/g, "&amp;"));
  });
  it("with several practice chips and little room, shows at least one and counts the rest", () => {
    const covers: CoverRef[] = ["aie", "evals", "oaievals"].map((id) => ({ id, note: null }));
    const html = render(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 9 }, { format: "mock", id: "mock", note: null }], covers));
    expect(html).toContain("NeetCode 150 · Arrays &amp; Hashing");
    expect(html).not.toMatch(/>Mock Bank</);
    expect(html).toContain("+ 2 more");
    expect(html).toMatch(/title="[^"]*Mock Bank[^"]*"[^>]*>\+ 2 more/);
  });
  it("shows several practice chips when reading leaves room", () => {
    const html = render(week([{ format: "problem-set", id: "nc", note: null, itemFrom: 1, itemTo: 9 }, { format: "mock", id: "mock", note: "two rounds" }], [{ id: "aie", note: null }]));
    expect(html).toContain("Mock Bank · two rounds");
    expect(html).not.toContain("more");
  });
  it("shows a week that reserves only practice, and nothing for a reservation without a source", () => {
    expect(render(week([{ format: "mock", id: "mock", note: null }]))).toContain("Mock Bank");
    expect(render(week([{ format: "design-exercise", id: null, note: "x", task: "Design a limiter", minutes: 30 }]))).toBe("");
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
