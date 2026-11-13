import { describe, expect, it } from "vitest";
import type { ConvertResult, ImportedPlan } from "@/lib/import/convert";
import type { Material } from "@/lib/schemas/material";
import type { PlanTreeInput } from "@/lib/schemas/plan";
import { IMPORT_FIXTURES, checkImport } from "./checks";

type Node = PlanTreeInput[number];

function node(title: string, over: Partial<Node> = {}): Node {
  return { id: `tmp-${title}`, level: "week", title, summary: title, len: 5, ...over } as Node;
}

function plan(tree: Node[], over: Partial<ImportedPlan> = {}): ConvertResult {
  return {
    ok: true,
    plan: { title: "T", granularity: "week", hoursPerWeek: 10, daysPerWeek: 5, split: {} as ImportedPlan["split"], materials: [], tree, kept: [], skipped: [], ...over },
  };
}

const noPlan: ConvertResult = { ok: false, reason: "no_plan", message: "No plan." };
const tooLong: ConvertResult = { ok: false, reason: "too_long", message: "Too long." };

function mat(id: string, title: string, kind: Material["kind"], titles: string[] = []): Material {
  return {
    id,
    title,
    kind,
    practice: titles.length ? { format: "problem-set", items: titles.length, perItemMinutes: null, minutes: null, answers: false, list: { items: titles.map((t) => ({ title: t })), source: "user", url: "x" } } : undefined,
  } as unknown as Material;
}

const LEET = ["703", "1046", "973", "215", "621", "355", "295"];

function weeklyPlan(over: { problems?: string[]; weeks?: number; imported?: boolean; design?: boolean; book?: boolean; empty?: number[] } = {}): ConvertResult {
  const { problems = LEET, weeks = 8, imported = true, design = true, book = true, empty = [] } = over;
  const leet = mat("M2", "LeetCode", "tool", ["703", "1046", "973", "215", "621", "355", "295", "999"]);
  const practice = [
    ...problems.map((p) => ({ format: "problem-set", id: "M2", task: `LeetCode ${p}`, done: "d", minutes: 40, generated: false, itemFrom: leet.practice!.list!.items.findIndex((i) => i.title === p) + 1, itemTo: leet.practice!.list!.items.findIndex((i) => i.title === p) + 1, imported })),
    ...(design ? [{ format: "design-exercise", id: null, task: "Drill 1: rate limiter", done: "d", minutes: 45, generated: false, imported }] : []),
    { format: "project", id: null, task: "Pensieve: close branches", done: "d", minutes: 100, generated: false, imported },
  ];
  const first = node("Nov 10–15", { practice, materials: book ? [{ id: "M1", tier: "must", activity: "read", note: "Ch. 1–3", minutes: 90 }] : [] } as Partial<Node>);
  // Weeks 2 on hold a row each, as the file fills every week; those in `empty` (by week number) hold none.
  const rest = Array.from({ length: weeks - 1 }, (_, i) =>
    node(`Week ${i + 2}`, empty.includes(i + 2) ? {} : ({ practice: [{ format: "other", id: null, task: `Task ${i + 2}`, done: "d", minutes: 60, generated: false, imported }] } as Partial<Node>)),
  );
  const tree = [first, ...rest];
  return plan(tree, { materials: [mat("M1", "System Design Interview, vol. 1", "book"), leet] });
}

const names = (r: ReturnType<typeof checkImport>) => r.verdicts.filter((v) => !v.pass).map((v) => v.name);

describe("fixtures", () => {
  it("lists the five fixtures", () => {
    expect(IMPORT_FIXTURES).toEqual(["weekly-plan", "month-plan", "syllabus", "reading-list", "odd-section"]);
  });
});

describe("weekly-plan", () => {
  it("passes a correct answer and reports where the other rows landed", () => {
    const r = checkImport("weekly-plan", weeklyPlan());
    expect(r.passed).toBe(true);
    expect(r.notes.join(" ")).toContain("project");
  });
  it("fails with 7 weeks", () => {
    expect(names(checkImport("weekly-plan", weeklyPlan({ weeks: 7 })))).toContain("8 weeks");
  });
  it("fails when the heap problems are out of order or missing", () => {
    expect(names(checkImport("weekly-plan", weeklyPlan({ problems: [...LEET].reverse() })))).toContain("7 heap problem rows in order");
    expect(names(checkImport("weekly-plan", weeklyPlan({ problems: LEET.slice(0, 6) })))).toContain("7 heap problem rows in order");
  });
  it("fails without the rate limiter or the book", () => {
    expect(names(checkImport("weekly-plan", weeklyPlan({ design: false })))).toContain("rate limiter design-exercise row");
    expect(names(checkImport("weekly-plan", weeklyPlan({ book: false })))).toContain("vol. 1 reading");
  });
  it("fails when a week the file fills holds no rows", () => {
    const r = checkImport("weekly-plan", weeklyPlan({ empty: [7] }));
    expect(names(r)).toEqual(["every week has rows"]);
    expect(r.verdicts.find((v) => v.name === "every week has rows")!.detail).toContain("Week 7");
  });
  it("no longer judges the imported flag, which the converter sets on every row", () => {
    const r = checkImport("weekly-plan", weeklyPlan({ imported: false }));
    expect(r.passed).toBe(true);
    expect(r.verdicts.map((v) => v.name)).not.toContain("every practice row imported");
  });
  it("fails on a no_plan answer", () => {
    expect(checkImport("weekly-plan", noPlan).passed).toBe(false);
  });
});

describe("month-plan", () => {
  const months = (n: number, children: Node["children"] = null) => plan(Array.from({ length: n }, (_, i) => node(`Month ${i + 1}`, { level: "month", children })));
  it("passes 3 month headings with no children", () => {
    expect(checkImport("month-plan", months(3)).passed).toBe(true);
  });
  it("fails with 2 months, with weeks inside, or on no_plan", () => {
    expect(checkImport("month-plan", months(2)).passed).toBe(false);
    expect(checkImport("month-plan", months(3, [node("w") as never])).passed).toBe(false);
    expect(checkImport("month-plan", noPlan).passed).toBe(false);
  });
});

describe("no-plan fixtures", () => {
  for (const id of ["syllabus", "reading-list"] as const) {
    it(`${id} passes no_plan`, () => {
      expect(checkImport(id, noPlan).passed).toBe(true);
    });
    it(`${id} fails a plan or too_long`, () => {
      expect(checkImport(id, plan([node("Topic")])).passed).toBe(false);
      expect(checkImport(id, tooLong).passed).toBe(false);
    });
  }
});

describe("odd-section", () => {
  const weeks = (n: number, skipped: ImportedPlan["skipped"]) => plan(Array.from({ length: n }, (_, i) => node(`Week ${i + 1}`)), { skipped });
  it("passes 4 weeks and one skipped section", () => {
    expect(checkImport("odd-section", weeks(4, [{ heading: "Ongoing", reason: "no dates" }])).passed).toBe(true);
  });
  it("fails with 5 weeks, nothing skipped, or two skipped", () => {
    expect(names(checkImport("odd-section", weeks(5, [{ heading: "Ongoing", reason: "r" }])))).toContain("4 weeks");
    expect(names(checkImport("odd-section", weeks(4, [])))).toContain("1 skipped section");
    expect(names(checkImport("odd-section", weeks(4, [{ heading: "a", reason: "r" }, { heading: "b", reason: "r" }])))).toContain("1 skipped section");
  });
});
