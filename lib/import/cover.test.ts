import { describe, expect, it } from "vitest";
import { makeNode, type PlanNode } from "@/lib/planTree";
import type { MaterialRef, PracticeCover, PracticeRef } from "@/lib/schemas/material";
import { coverImportedRows } from "./cover";

const other = (task: string, minutes: number): PracticeCover => ({ format: "other", id: null, note: null, task, minutes, imported: true });
const row = (task: string, minutes: number, extra: Partial<PracticeRef> = {}): PracticeRef => ({ format: "other", id: null, task, done: "done", minutes, generated: false, ...extra });
const day = (id: string, practice: PracticeRef[] = [], materials: MaterialRef[] = []): PlanNode => makeNode({ id, level: "day", title: id, summary: "", len: 1, practice, materials });
const week = (practiceCovers: PracticeCover[], covers: PlanNode["covers"] = []): PlanNode => makeNode({ id: "w", level: "week", title: "W", summary: "", len: 3, practiceCovers, covers });

describe("coverImportedRows", () => {
  it("appends an uncovered imported row to the lightest day", () => {
    const parent = week([other("Build a heap from scratch", 30), other("Write the sift-down tests", 40), other("Read the CLRS heap notes aloud", 20)]);
    const days = [day("d1", [row("Build a heap from scratch", 30)]), day("d2", [row("Write the sift-down tests", 40)]), day("d3", [row("Something else entirely", 10)])];
    const out = coverImportedRows(parent, days);
    expect(out.appended).toBe(1);
    expect(out.days[2].practice!.map((r) => r.task)).toEqual(["Something else entirely", "Read the CLRS heap notes aloud"]);
    expect(out.days[2].practice![1]).toMatchObject({ format: "other", minutes: 20, imported: true, generated: false });
    expect(days[2].practice).toHaveLength(1);
  });

  it("spreads several uncovered rows over the lightest days, ties to the earliest", () => {
    const parent = week([other("Alpha task here please", 30), other("Bravo task here please", 30)]);
    const out = coverImportedRows(parent, [day("d1"), day("d2"), day("d3")]);
    expect(out.appended).toBe(2);
    expect(out.days.map((d) => d.practice?.length ?? 0)).toEqual([1, 1, 0]);
  });

  it("matches a task case-insensitively by its first 24 characters", () => {
    const parent = week([other("Implement a binary heap with decrease-key", 30)]);
    const out = coverImportedRows(parent, [day("d1", [row("IMPLEMENT A BINARY HEAP WITH extra words", 30)])]);
    expect(out.appended).toBe(0);
  });

  it("treats item ranges as covering", () => {
    const covers: PracticeCover[] = Array.from({ length: 7 }, (_, i) => ({ format: "problem-set" as const, id: "m1", note: null, task: `Item ${i + 1}`, minutes: 25, itemFrom: i + 1, itemTo: i + 1, imported: true }));
    const days = [
      day("d1", [row("a", 50, { format: "problem-set", id: "m1", itemFrom: 1, itemTo: 2 })]),
      day("d2", [row("b", 50, { format: "problem-set", id: "m1", itemFrom: 3, itemTo: 3 })]),
      day("d3", [row("c", 50, { format: "problem-set", id: "m1", itemFrom: 4, itemTo: 5 })]),
      day("d4", [row("d", 25, { format: "problem-set", id: "m1", itemFrom: 6, itemTo: 6 })]),
      day("d5", [row("e", 25, { format: "problem-set", id: "m1", itemFrom: 7, itemTo: 7 })]),
    ];
    expect(coverImportedRows(week(covers), days).appended).toBe(0);
  });

  it("appends a sourced item no day takes", () => {
    const covers: PracticeCover[] = [{ format: "problem-set", id: "m1", note: null, task: "Item 9", minutes: 25, itemFrom: 9, itemTo: 9, imported: true }];
    const out = coverImportedRows(week(covers), [day("d1", [row("a", 25, { format: "problem-set", id: "m1", itemFrom: 1, itemTo: 1 })]), day("d2")]);
    expect(out.appended).toBe(1);
    expect(out.days[1].practice![0]).toMatchObject({ id: "m1", itemFrom: 9, itemTo: 9, imported: true, generated: false });
  });

  it("splits an empty imported week without error", () => {
    const out = coverImportedRows(week([]), [day("d1"), day("d2")]);
    expect(out.appended).toBe(0);
    expect(out.days).toHaveLength(2);
    expect(coverImportedRows(makeNode({ id: "w", level: "week", title: "W", summary: "", len: 1 }), []).appended).toBe(0);
  });

  it("ignores rows that are not imported", () => {
    const parent = week([{ ...other("Not from the file", 30), imported: undefined }]);
    expect(coverImportedRows(parent, [day("d1")]).appended).toBe(0);
  });

  it("appends an uncovered must reading to the day with the least reading", () => {
    const parent = week([], [{ id: "b1", note: null, chapter: 1, tier: "must", minutes: 40 }, { id: "b1", note: null, chapter: 2, tier: "must", minutes: 30 }, { id: "b2", note: "§2 only", tier: "should", minutes: 10 }]);
    const days = [day("d1", [], [{ id: "b1", tier: "must", minutes: 40, note: null, chapter: 1 }]), day("d2", [], [{ id: "b3", tier: "must", minutes: 90, note: null }]), day("d3")];
    const out = coverImportedRows(parent, days);
    expect(out.appended).toBe(1);
    expect(out.days[2].materials).toEqual([{ id: "b1", tier: "must", minutes: 30, note: null, chapter: 2 }]);
  });
});
