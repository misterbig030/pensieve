import { describe, expect, it } from "vitest";
import { importDraftSchema, type ImportDraft, type ImportUnitDraft } from "@/lib/import/schema";
import { WEEKLY_PLAN_DRAFT } from "@/lib/import/__fixtures__/weekly-plan.draft";
import { revisedTreeSchema, unitListSchema } from "@/lib/schemas/plan";
import { sentSchema as sent, unionCount } from "@/lib/ai/strictOutput";

/** How many object levels deep a JSON schema nests: the root object is 1. */
function objectDepth(node: unknown): number {
  if (Array.isArray(node)) return Math.max(0, ...node.map(objectDepth));
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  const below = Math.max(0, ...Object.values(o).map(objectDepth));
  return o.type === "object" ? 1 + below : below;
}

type Answer = Record<string, unknown> & { units: Record<string, unknown>[] };

/** A draft as the model writes it: every field present, "nothing" as "", 0 or [], and the units flat with parent indexes. */
function answerOf(draft: ImportDraft): Answer {
  if (draft.kind === "no_plan") {
    return { kind: "no_plan", reason: draft.reason, title: "", hoursPerWeek: 0, daysPerWeek: 0, materials: [], units: [], kept: [], skipped: [] };
  }
  const units: Record<string, unknown>[] = [];
  const below: Record<string, "week" | "day"> = { month: "week", week: "day" };
  const add = (u: ImportUnitDraft, level: string, parent: number) => {
    const index = units.length;
    units.push({
      level,
      parent,
      title: u.title,
      summary: u.summary,
      budgetHours: u.budgetHours ?? 0,
      reading: u.reading.map((r) => ({ id: r.id, part: r.part ?? "", minutes: r.minutes ?? 0 })),
      practice: u.practice.map((p) => ({ format: p.format, id: p.id ?? "", items: p.items ?? [], task: p.task, done: p.done, minutes: p.minutes ?? 0 })),
    });
    for (const child of u.children ?? []) add(child, below[level], index);
  };
  for (const u of draft.units) add(u, draft.level, -1);
  return {
    kind: "plan",
    reason: "",
    title: draft.title,
    hoursPerWeek: draft.hoursPerWeek ?? 0,
    daysPerWeek: draft.daysPerWeek ?? 0,
    materials: draft.materials.map(({ id, title, author, kind, practiceFormat }) => ({ id, title, author: author ?? "", kind, practiceFormat: practiceFormat ?? "" })),
    units,
    kept: draft.kept,
    skipped: draft.skipped,
  };
}

const EMPTY_PLAN: ImportDraft = { kind: "plan", title: "P", hoursPerWeek: null, daysPerWeek: null, level: "week", materials: [], units: [], kept: [], skipped: [] };

function unitAnswer(title: string, level: string, parent: number) {
  return { level, parent, title, summary: "s", budgetHours: 0, reading: [], practice: [] };
}

describe("importDraftSchema", () => {
  it("reads the fixture draft, as the model writes it, back unchanged", () => {
    expect(importDraftSchema.parse(answerOf(WEEKLY_PLAN_DRAFT))).toEqual(WEEKLY_PLAN_DRAFT);
  });

  it("reads a no_plan answer as its reason alone", () => {
    expect(importDraftSchema.parse(answerOf({ kind: "no_plan", reason: "A syllabus." }))).toEqual({ kind: "no_plan", reason: "A syllabus." });
  });

  it("rebuilds month, week and day from parent indexes", () => {
    const leaf = (title: string): ImportUnitDraft => ({ title, summary: "s", budgetHours: null, reading: [], practice: [], children: null });
    const nested: ImportDraft = {
      ...EMPTY_PLAN,
      level: "month",
      units: [
        { ...leaf("Jan"), children: [{ ...leaf("Jan w1"), children: [leaf("Mon"), leaf("Tue")] }, leaf("Jan w2")] },
        leaf("Feb"),
      ],
    };
    expect(answerOf(nested).units.map((u) => [u.title, u.level, u.parent])).toEqual([
      ["Jan", "month", -1],
      ["Jan w1", "week", 0],
      ["Mon", "day", 1],
      ["Tue", "day", 1],
      ["Jan w2", "week", 0],
      ["Feb", "month", -1],
    ]);
    expect(importDraftSchema.parse(answerOf(nested))).toEqual(nested);
  });

  it("puts a unit with a bad parent at the top level and lists it", () => {
    const draft = importDraftSchema.parse({
      ...answerOf(EMPTY_PLAN),
      units: [
        unitAnswer("W1", "week", -1),
        unitAnswer("Forward", "day", 3),
        unitAnswer("Out of range", "day", 99),
        unitAnswer("Mon", "day", 0),
        unitAnswer("Inside a day", "day", 3),
        unitAnswer("Fractional", "day", 0.5),
      ],
      skipped: [{ heading: "Notes", reason: "Fits no week." }],
    });
    if (draft.kind !== "plan") throw new Error("expected a plan");
    expect(draft.units.map((u) => [u.title, u.children?.map((c) => c.title) ?? null])).toEqual([
      ["W1", ["Mon"]],
      ["Forward", null],
      ["Out of range", null],
      ["Inside a day", null],
      ["Fractional", null],
    ]);
    expect(draft.skipped.map((s) => s.heading)).toEqual(["Notes", "Forward", "Out of range", "Inside a day", "Fractional"]);
    expect(draft.skipped[1].reason).toBe("Its parent (3) is not an earlier unit, so it was imported at the top level.");
    expect(draft.level).toBe("week");
  });

  it("turns the sentinels back into nulls", () => {
    const row = { id: "M1", part: " ", minutes: 0 };
    const task = { format: "other", id: "", items: [], task: "t", done: "d", minutes: 0 };
    const draft = importDraftSchema.parse({
      ...answerOf(EMPTY_PLAN),
      materials: [{ id: "M1", title: "Book", author: "", kind: "book", practiceFormat: "" }],
      units: [{ ...unitAnswer("W", "week", -1), reading: [row], practice: [task] }],
    });
    if (draft.kind !== "plan") throw new Error("expected a plan");
    expect(draft).toMatchObject({ hoursPerWeek: null, daysPerWeek: null });
    expect(draft.materials[0]).toMatchObject({ author: null, practiceFormat: null, items: null });
    expect(draft.units[0]).toMatchObject({ budgetHours: null, children: null, reading: [{ part: null, minutes: null }], practice: [{ id: null, items: null, minutes: null }] });
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

  it("sends a grammar no bigger than the plan schemas that compile in production", () => {
    const schema = sent(importDraftSchema);
    // The answer, a unit, a row: no deeper.
    expect(objectDepth(schema)).toBe(3);
    const budget = Math.max(JSON.stringify(sent(unitListSchema)).length, JSON.stringify(sent(revisedTreeSchema)).length);
    expect(JSON.stringify(schema).length).toBeLessThanOrEqual(budget);
  });
});
