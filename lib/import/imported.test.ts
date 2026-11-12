import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnitDraft } from "@/lib/schemas/plan";

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamObject: vi.fn(), generateObject: vi.fn() }));

import { streamObject } from "ai";
import { assignRefs, buildUnitsPrompt } from "@/lib/ai/planPrompt";
import { redraftPlan } from "@/lib/ai/planRedraft";
import { applyRevision } from "@/lib/ai/planRevision";
import { convertDraft, type ImportedPlan } from "@/lib/import/convert";
import { WEEKLY_PLAN_DRAFT } from "@/lib/import/__fixtures__/weekly-plan.draft";
import { aliasMaterials, pickSources, resolvePracticeRefs } from "@/lib/materials";
import { fromTreeInput } from "@/lib/planInput";
import { layout, type PlanNode } from "@/lib/planTree";

const mockedStreamObject = vi.mocked(streamObject);

function fakeStream(units: UnitDraft[]) {
  return {
    partialObjectStream: (async function* () {
      for (let i = 1; i <= units.length; i++) yield { units: units.slice(0, i) };
    })(),
    object: Promise.resolve({ units }),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 }),
    finishReason: Promise.resolve("stop"),
    providerMetadata: Promise.resolve({ gateway: { cost: "0.004" } }),
  } as unknown as ReturnType<typeof streamObject>;
}

function converted(): ImportedPlan {
  const result = convertDraft(WEEKLY_PLAN_DRAFT, "weekly-plan.md");
  if (!result.ok) throw new Error("fixture");
  return result.plan;
}

const tree = (plan: ImportedPlan): PlanNode => layout(fromTreeInput(plan.tree));

describe("an imported plan's own formats", () => {
  it("are assignable from the file's split, though no source or writer backs them", () => {
    const plan = converted();
    const other = pickSources(plan.split, plan.materials).find((p) => p.pick.format === "other");
    expect(other).toMatchObject({ sources: [], assignable: true });
  });

  it("a re-draft of the open weeks lists Other with its minutes, and says to copy the learner's tasks", () => {
    const plan = converted();
    const root = tree(plan);
    const prompt = buildUnitsPrompt({
      topic: plan.title,
      materials: plan.materials,
      granularity: plan.granularity,
      hoursPerWeek: plan.hoursPerWeek,
      daysPerWeek: plan.daysPerWeek,
      split: plan.split,
      importText: "# Weekly plan",
      level: "week",
      spans: Array(7).fill(plan.daysPerWeek),
      weeks: 8,
      keep: [root.children![0]],
      unitsAreLeaves: true,
    });
    expect(prompt).toMatch(/- Other \(format "other"\): about \d+(\.\d+)? h(?: \d+ min)? across the weeks/);
    expect(prompt).toContain("the learner's own tasks from their plan file");
    expect(prompt).toContain("The learner does a task from their own plan file. These are the learner's own tasks from their plan file: copy each");
    expect(prompt).not.toContain("No source in the list: null");
  });

  it("a sourceless draft of a never-written format resolves as the learner's own", () => {
    const plan = converted();
    const { refs, refused } = resolvePracticeRefs([{ format: "other", task: "Pensieve: one benchmark round", done: "Verdict written", minutes: 90 }], aliasMaterials(plan.materials), plan.split);
    expect(refused).toEqual([]);
    expect(refs).toEqual([{ format: "other", id: null, task: "Pensieve: one benchmark round", done: "Verdict written", minutes: 90, generated: true, imported: true }]);
  });

  it("a plan not imported still refuses a sourceless row of a never-written format", () => {
    const split = { readingShare: 50, practice: "problems", reason: "A coding topic.", formats: [{ format: "problem-set" as const, share: 100, focus: "arrays", reason: "Practice." }] };
    const { refs, refused } = resolvePracticeRefs([{ format: "problem-set", task: "Ten array problems", done: "Solved", minutes: 60 }], aliasMaterials([]), split);
    expect(refs).toEqual([]);
    expect(refused).toEqual(['Problems "Ten array problems": no source, and this format is never written']);
  });

  it("a row a revision moves to another week stays imported", () => {
    const plan = converted();
    const original = tree(plan);
    const drill = original.children![0].practice!.find((p) => p.format === "design-exercise")!;
    const units = original.children!.map((w, i) => ({ ref: `n${i + 1}`, title: w.title, summary: w.summary, days: w.len }));
    // Week 1's drill goes to Week 2; Week 1 keeps the rest of its rows.
    const week1 = original.children![0].practice!.filter((p) => p !== drill).map((p) => ({ format: p.format, id: p.id === null ? undefined : `M${Number(p.id.slice(1))}${p.itemFrom ? `.${p.itemFrom}` : ""}`, task: p.task, done: p.done, minutes: p.minutes }));
    const revised = {
      units: [
        { ...units[0], practice: week1 },
        { ...units[1], practice: [{ format: "design-exercise", task: drill.task, done: drill.done, minutes: drill.minutes }] },
        ...units.slice(2),
      ],
    };
    const result = applyRevision(original, assignRefs(original), revised, 0, plan.granularity, aliasMaterials(plan.materials), plan.hoursPerWeek, plan.daysPerWeek, plan.split);
    expect(result.children![1].practice).toEqual([{ format: "design-exercise", id: null, task: drill.task, done: drill.done, minutes: drill.minutes, generated: true, imported: true }]);
  });
});

describe("an imported plan whose share the learner moved", () => {
  // The slider sets the split's reason to the learner's; the picks still come from the file.
  const moved = (plan: ImportedPlan) => ({ ...plan.split, readingShare: 30, reason: "Set by you." });

  it("keeps Other assignable and a sourceless Other draft the learner's own", () => {
    const plan = converted();
    const split = moved(plan);
    expect(split.formats!.every((p) => p.reason === "From your file.")).toBe(true);
    expect(pickSources(split, plan.materials).find((p) => p.pick.format === "other")).toMatchObject({ assignable: true });
    const { refs, refused } = resolvePracticeRefs([{ format: "other", task: "Pensieve: one benchmark round", done: "Verdict written", minutes: 90 }], aliasMaterials(plan.materials), split);
    expect(refused).toEqual([]);
    expect(refs[0]).toMatchObject({ format: "other", imported: true });
  });

  it("keeps the Other line in the re-draft prompt", () => {
    const plan = converted();
    const root = tree(plan);
    const prompt = buildUnitsPrompt({
      topic: plan.title,
      materials: plan.materials,
      granularity: plan.granularity,
      hoursPerWeek: plan.hoursPerWeek,
      daysPerWeek: plan.daysPerWeek,
      split: moved(plan),
      importText: "# Weekly plan",
      level: "week",
      spans: Array(7).fill(plan.daysPerWeek),
      weeks: 8,
      keep: [root.children![0]],
      unitsAreLeaves: true,
    });
    expect(prompt).toMatch(/- Other \(format "other"\): about \d+(\.\d+)? h(?: \d+ min)? across the weeks/);
    expect(prompt).toContain("These are the learner's own tasks from their plan file");
  });
});

describe("re-drafting an imported plan", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });

  it("keeps a learner's row the re-drafted weeks copy as imported", async () => {
    const plan = converted();
    const root = tree(plan);
    const drill = root.children![5].practice!.find((p) => p.format === "design-exercise")!;
    const week = (title: string, practice: UnitDraft["practice"] = []): UnitDraft => ({ title, summary: "s", practice });
    mockedStreamObject.mockReturnValueOnce(fakeStream([week("Six", [{ format: "design-exercise", task: drill.task, done: drill.done, minutes: drill.minutes }]), week("Seven"), week("Eight")]));
    const { tree: out } = await redraftPlan({
      topic: plan.title,
      materials: plan.materials,
      granularity: plan.granularity,
      weeks: 8,
      daysPerWeek: plan.daysPerWeek,
      hoursPerWeek: plan.hoursPerWeek,
      split: plan.split,
      importText: "# Weekly plan",
      tree: root,
      // Weeks 1–5 are behind the learner: the re-draft writes weeks 6–8.
      lockBefore: 5 * plan.daysPerWeek,
      scope: { kind: "level", parentId: null },
    });
    expect(out.children![5].practice).toEqual([{ format: "design-exercise", id: null, task: drill.task, done: drill.done, minutes: drill.minutes, generated: true, imported: true }]);
  });
});
