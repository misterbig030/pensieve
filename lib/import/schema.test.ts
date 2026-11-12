import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { importDraftSchema, type ImportDraft, type ImportUnitDraft } from "@/lib/import/schema";
import { WEEKLY_PLAN_DRAFT } from "@/lib/import/__fixtures__/weekly-plan.draft";
import { revisedTreeSchema, unitListSchema } from "@/lib/schemas/plan";

/** The JSON schema `generateObject` sends: the AI SDK's own conversion (`asSchema`, zod 4 at `io: "input"`). */
function sent(schema: Parameters<typeof asSchema>[0]): unknown {
  return asSchema(schema).jsonSchema;
}

/**
 * Every place in a JSON schema whose type is a union: `anyOf`, `oneOf` or a `type` array. Anthropic refuses more than
 * 16, counting each nested copy.
 */
function unionCount(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, n) => sum + unionCount(n), 0);
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  const own = "anyOf" in o || "oneOf" in o || Array.isArray(o.type) ? 1 : 0;
  return own + Object.values(o).reduce((sum: number, v) => sum + unionCount(v), 0);
}

/** A draft as the model writes it: every field present, "nothing" as "", 0 or []. */
function answerOf(draft: ImportDraft) {
  const unit = (u: ImportUnitDraft): Record<string, unknown> => ({
    title: u.title,
    summary: u.summary,
    budgetHours: u.budgetHours ?? 0,
    reading: u.reading.map((r) => ({ id: r.id, part: r.part ?? "", minutes: r.minutes ?? 0 })),
    practice: u.practice.map((p) => ({ format: p.format, id: p.id ?? "", items: p.items ?? [], task: p.task, done: p.done, minutes: p.minutes ?? 0 })),
    children: (u.children ?? []).map(unit),
  });
  if (draft.kind === "no_plan") {
    return { kind: "no_plan", reason: draft.reason, title: "", hoursPerWeek: 0, daysPerWeek: 0, level: "week", materials: [], units: [], kept: [], skipped: [] };
  }
  return {
    kind: "plan",
    reason: "",
    title: draft.title,
    hoursPerWeek: draft.hoursPerWeek ?? 0,
    daysPerWeek: draft.daysPerWeek ?? 0,
    level: draft.level,
    materials: draft.materials.map((m) => ({ ...m, author: m.author ?? "", practiceFormat: m.practiceFormat ?? "", items: m.items ?? [] })),
    units: draft.units.map(unit),
    kept: draft.kept,
    skipped: draft.skipped,
  };
}

describe("importDraftSchema", () => {
  it("reads the fixture draft, as the model writes it, back unchanged", () => {
    expect(importDraftSchema.parse(answerOf(WEEKLY_PLAN_DRAFT))).toEqual(WEEKLY_PLAN_DRAFT);
  });

  it("reads a no_plan answer as its reason alone", () => {
    expect(importDraftSchema.parse(answerOf({ kind: "no_plan", reason: "A syllabus." }))).toEqual({ kind: "no_plan", reason: "A syllabus." });
  });

  it("turns the sentinels back into nulls", () => {
    const day = { title: "Mon", summary: "s", budgetHours: 0, reading: [{ id: "M1", part: " ", minutes: 0 }], practice: [{ format: "other", id: "", items: [], task: "t", done: "d", minutes: 0 }] };
    const draft = importDraftSchema.parse({
      ...answerOf({ kind: "plan", title: "P", hoursPerWeek: null, daysPerWeek: null, level: "week", materials: [], units: [], kept: [], skipped: [] }),
      materials: [{ id: "M1", title: "Book", author: "", kind: "book", practiceFormat: "", items: [] }],
      units: [{ ...day, title: "W", children: [{ ...day, children: [] }] }],
    });
    if (draft.kind !== "plan") throw new Error("expected a plan");
    expect(draft).toMatchObject({ hoursPerWeek: null, daysPerWeek: null });
    expect(draft.materials[0]).toMatchObject({ author: null, practiceFormat: null, items: null });
    const week = draft.units[0];
    expect(week).toMatchObject({ budgetHours: null, reading: [{ part: null, minutes: null }], practice: [{ id: null, items: null, minutes: null }] });
    expect(week.children![0]).toMatchObject({ title: "Mon", children: null });
  });

  it("sends no array caps to the model", () => {
    expect(JSON.stringify(sent(importDraftSchema))).not.toContain("maxItems");
  });

  it("sends the model no nullable or union-typed parameters", () => {
    // The plan draft schemas run in production on Anthropic, so they are under the limit: the counter agrees.
    expect(unionCount(sent(unitListSchema))).toBeLessThanOrEqual(16);
    expect(unionCount(sent(revisedTreeSchema))).toBeLessThanOrEqual(16);
    expect(unionCount({ properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] }, b: { type: ["string", "null"] } } })).toBe(2);
    expect(unionCount(sent(importDraftSchema))).toBe(0);
  });
});
