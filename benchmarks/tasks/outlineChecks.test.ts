import { describe, expect, it } from "vitest";
import type { Breach } from "@/lib/materials";
import type { PlanNode } from "@/lib/planTree";
import type { ChapterList, Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";
import { breachesOf, idsInText, minutesOffSize, orderBreaks, setAsideOffSize, SIZE_TOLERANCE, unreserved } from "./outlineChecks";

function chapters(minutes: number[]): ChapterList {
  return {
    source: "catalogue",
    url: "https://example.com/toc",
    printPages: false,
    end: null,
    chapters: minutes.map((m, i) => ({ n: i + 1, title: `Chapter ${i + 1}`, page: null, sections: [], minutes: m })),
  };
}

function material(id: string, extra: Partial<Material> = {}): Material {
  return { id, title: id, minutes: null, toc: null, practice: null, ...extra } as unknown as Material;
}

function node(extra: Partial<PlanNode>): PlanNode {
  return { id: "n", level: "day", title: "t", summary: "s", len: 1, status: "pending", budgetHours: null, manualSplit: false, children: null, start: 1, end: 1, ...extra };
}

const cover = (id: string, chapter?: number) => ({ id, chapter: chapter ?? null, note: null });
const row = (id: string, chapter: number | null, minutes = 30) => ({ id, chapter, minutes, tier: "must" as const, note: null });
const pcover = (id: string, itemFrom: number, itemTo: number) => ({ format: "problem-set" as const, id, note: null, itemFrom, itemTo });

describe("breachesOf", () => {
  const b = (kind: Breach["kind"]) => ({ kind, index: 0, unit: "Day 1", refs: [], names: "", text: "" }) as Breach;
  it("keeps only the asked kinds", () => {
    const all = [b("outside"), b("overlap"), b("no-time")];
    expect(breachesOf(all, ["overlap", "no-time"]).map((x) => x.kind)).toEqual(["overlap", "no-time"]);
    expect(breachesOf(all, [])).toEqual([]);
  });
});

describe("orderBreaks", () => {
  // Aliases are positional: m1 is the prompt's M2 and m4 its M3.
  const mats = [material("m0"), material("m1", { toc: chapters([30, 30, 30, 30]) }), material("m4")];

  it("is quiet when chapters and items run forward", () => {
    const nodes = [node({ covers: [cover("m1", 1), cover("m1", 2)], practiceCovers: [pcover("m4", 1, 3)] }), node({ covers: [cover("m1", 3)], practiceCovers: [pcover("m4", 4, 6)] })];
    expect(orderBreaks(nodes, mats, false)).toEqual([]);
  });

  it("finds chapter 3 after chapter 4, and item 7 after item 9, named by the aliases the model was shown", () => {
    const nodes = [node({ covers: [cover("m1", 4)], practiceCovers: [pcover("m4", 9, 9)] }), node({ covers: [cover("m1", 3)], practiceCovers: [pcover("m4", 7, 7)] })];
    expect(orderBreaks(nodes, mats, false)).toEqual(["M2.3 in Day 2 after M2.4 in Day 1", "M3.7 in Day 2 after M3.9 in Day 1"]);
  });

  it("names a material it was not given by its id", () => {
    const nodes = [node({ covers: [cover("zz", 4)] }), node({ covers: [cover("zz", 3)] })];
    expect(orderBreaks(nodes, mats, false)).toEqual(["zz chapter 3 in Day 2 after chapter 4 in Day 1"]);
  });

  it("reads leaves' tables and ignores reviews", () => {
    const nodes = [node({ materials: [row("m1", 4)] }), node({ materials: [{ ...row("m1", 2), activity: "review" as const }] })];
    expect(orderBreaks(nodes, mats, true)).toEqual([]);
    const broken = [node({ materials: [row("m1", 4)] }), node({ materials: [row("m1", 2)] })];
    expect(orderBreaks(broken, mats, true)).toHaveLength(1);
  });
});

describe("unreserved", () => {
  const mats = [material("m1"), material("m2")];
  it("names M2 when only M1 is covered", () => {
    const nodes = [node({ covers: [cover("m1", 2)] })];
    expect(unreserved(nodes, mats, false).map((m) => m.id)).toEqual(["m2"]);
  });
  it("is empty when every material is reserved, by practice too, and reads leaves' rows", () => {
    expect(unreserved([node({ covers: [cover("m1")], practiceCovers: [pcover("m2", 1, 2)] })], mats, false)).toEqual([]);
    expect(unreserved([node({ materials: [row("m1", null)] })], mats, true).map((m) => m.id)).toEqual(["m2"]);
  });
});

describe("idsInText", () => {
  const unit = (extra: Partial<UnitDraft>): UnitDraft => ({ title: "t", summary: "s", ...extra });
  it("finds M1.3 in a note and ignores Module 1", () => {
    expect(idsInText([unit({ materials: [{ id: "M1", tier: "must", minutes: 10, note: "read M1.3 first" }] })])).toEqual(["M1.3"]);
    expect(idsInText([unit({ title: "Module 1", summary: "Review module 1" })])).toEqual([]);
  });
  it("finds ids in title, summary, task and done", () => {
    const out = idsInText([unit({ title: "M2", summary: "M3.i4", practice: [{ format: "problem-set", task: "do M4.12", done: "M5", minutes: 10 }] })]);
    expect(out).toEqual(["M2", "M3.i4", "M4.12", "M5"]);
  });
});

describe("minutesOffSize", () => {
  const mats = [material("m1", { toc: chapters([40, 40, 40]) }), material("m2", { minutes: null })];
  const unit = (rows: UnitDraft["materials"]): UnitDraft => ({ title: "t", summary: "s", materials: rows });
  const read = (id: string, minutes: number) => ({ id, tier: "must" as const, minutes });
  it("sums a chapter's rows: 30 + 25 against 40 is fine", () => {
    expect(minutesOffSize([unit([read("M1.1", 30)]), unit([read("M1.1", 25)])], mats)).toEqual({ sized: 1, unsized: 0, off: [] });
  });
  it("flags 70 + 0 against 40", () => {
    const out = minutesOffSize([unit([read("M1.1", 70)]), unit([read("M1.1", 0)])], mats);
    expect(out.sized).toBe(1);
    expect(out.off).toHaveLength(1);
  });
  it("flags too little as well, and counts an unlisted book as unsized", () => {
    expect(minutesOffSize([unit([read("M1.2", 10)])], mats).off).toHaveLength(1);
    expect(minutesOffSize([unit([read("M2", 30)])], mats)).toEqual({ sized: 0, unsized: 1, off: [] });
  });
  it("leaves a whole-resource row to the judge even when its material has minutes", () => {
    const ms = [material("m1", { minutes: 600 })];
    expect(minutesOffSize([unit([read("M1", 90)])], ms)).toEqual({ sized: 0, unsized: 1, off: [] });
  });
  it("compares a practice item's row with the item's size", () => {
    const list = { source: "page" as const, items: [{ title: "a", minutes: 20 }, { title: "b", minutes: 20 }, { title: "c", minutes: 20 }] };
    const ms = [material("m1"), material("m2"), material("m3"), material("m4", { practice: { format: "problem-set", list } as unknown as Material["practice"] })];
    const practice = (minutes: number): UnitDraft => ({ title: "t", summary: "s", practice: [{ format: "problem-set", id: "M4.2", task: "x", done: "y", minutes }] });
    expect(minutesOffSize([practice(20)], ms)).toEqual({ sized: 1, unsized: 0, off: [] });
    expect(minutesOffSize([practice(90)], ms).off).toHaveLength(1);
  });
  it("exports the tolerance", () => {
    expect(SIZE_TOLERANCE).toEqual([0.5, 1.5]);
  });
});

describe("setAsideOffSize", () => {
  const mats = [material("m1", { toc: chapters([60, 60, 60]) }), material("m2")];
  const heading = (reading: number, covers = [cover("m1", 1), cover("m1", 2), cover("m1", 3)]) => node({ covers, time: { reading, practice: {} } });
  it("is fine when 3 chapters of 60 sit against 200", () => {
    expect(setAsideOffSize([heading(200)], mats)).toEqual({ sized: 1, unsized: 0, off: [] });
  });
  it("is off against 90", () => {
    const out = setAsideOffSize([heading(90)], mats);
    expect(out.sized).toBe(1);
    expect(out.off).toHaveLength(1);
  });
  it("counts a heading with an unsized cover as unsized", () => {
    expect(setAsideOffSize([heading(100, [cover("m1", 1), cover("m2")])], mats)).toEqual({ sized: 0, unsized: 1, off: [] });
  });
});
