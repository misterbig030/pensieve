import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS } from "@/lib/__fixtures__/problemList";
import { budgetLine, practiceRowsFor, readRowsFor } from "@/components/pensieve/ReadTable";
import { findNode, layout, makeNode, makeRoot } from "@/lib/planTree";
import type { Material, PracticeRef } from "@/lib/schemas/material";
import { DayCards, PracticeSection, ReadSection } from "./UnitRows";

const bank: Material = { ...AIE_MATERIALS.find((m) => m.id === "evals")!, id: "nc", title: "NeetCode 150", backbone: false, practice: LISTED_PROBLEMS };
const plain: Material = { ...AIE_MATERIALS.find((m) => m.id === "oaievals")!, id: "mock", title: "Mock Bank", backbone: false, practice: { format: "mock", items: 10, perItemMinutes: 30, minutes: 300, answers: false } };
const byId = new Map<string, Material>([...AIE_MATERIALS, bank, plain].map((m) => [m.id, m]));
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

const listed: PracticeRef = { format: "problem-set", id: "nc", task: "NeetCode 150 · Arrays & Hashing, problem 1", done: "solved", minutes: 15, generated: false, itemFrom: 1, itemTo: 1 };
const plainRow: PracticeRef = { format: "mock", id: "mock", task: "One mock round", done: "debriefed", minutes: 45, generated: false };

const day = (id: string) => makeNode({ id, level: "day", title: id, summary: "", len: 1, materials: [{ id: "aie", note: null, chapter: 3, tier: "must", minutes: 30 }] });
const week = (id: string) => makeNode({ id, level: "week", title: id, summary: "", len: 5, children: Array.from({ length: 5 }, (_, i) => day(`${id}d${i + 1}`)) });
const plan3 = layout(makeRoot([week("w1"), week("w2"), week("w3")]));

describe("PracticeSection", () => {
  it("shows a listed item as number and title with its group, and other rows by their task", () => {
    const out = html(createElement(PracticeSection, { rows: practiceRowsFor([listed, plainRow], byId) }));
    expect(out).toMatch(/217\. Contains Duplicate<span[^>]*>Arrays &amp; Hashing<\/span>/);
    expect(out).not.toContain("problem 1");
    expect(out).toContain("One mock round");
  });
  it("names the file a practice row from an imported plan comes from", () => {
    const row: PracticeRef = { format: "mock", id: null, task: "Dry run", done: "", minutes: 20, generated: false, imported: true };
    expect(html(createElement(PracticeSection, { rows: practiceRowsFor([row], byId) }))).toContain("From file");
  });
});

describe("ReadSection", () => {
  it("keeps the tier pill on each read row and the budget bar under them", () => {
    const out = html(createElement(ReadSection, { rows: readRowsFor([{ id: "aie", note: null, chapter: 3, tier: "must", minutes: 60 }], byId), budgetMinutes: 780, practiceMinutes: 300 }));
    expect(out).toContain(">Must<");
    expect(out).toContain(budgetLine({ readingMinutes: 60, practiceMinutes: 300, budgetMinutes: 780 }));
  });
});

describe("DayCards", () => {
  it("marks finished days done and the current day today", () => {
    const out = html(createElement(DayCards, { root: plan3, week: findNode(plan3, "w3")!, byId, lockBefore: 12, currentLeafId: "w3d3" }));
    expect(out.match(/>Done</g)).toHaveLength(2);
    expect(out.match(/>Today</g)).toHaveLength(1);
  });
});
