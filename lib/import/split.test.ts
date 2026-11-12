import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnitDraft } from "@/lib/schemas/plan";

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamObject: vi.fn() }));

import { streamObject } from "ai";
import { streamExpandNode } from "@/lib/ai/planDraft";
import { convertDraft, type ImportedPlan } from "@/lib/import/convert";
import { WEEKLY_PLAN_DRAFT } from "@/lib/import/__fixtures__/weekly-plan.draft";
import { fromTreeInput } from "@/lib/planInput";
import type { PlanNode } from "@/lib/planTree";
import { splitWeekTime } from "./cover";

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

/** Splits Week 1 of the converted fixture as the draft page does, and returns the prompt the days are planned from. */
async function week1DayPrompt(importText: string | undefined): Promise<string> {
  const plan = converted();
  const tree = fromTreeInput(plan.tree);
  mockedStreamObject.mockReturnValueOnce(fakeStream(Array.from({ length: 5 }, (_, i) => ({ title: `Day ${i + 1}`, summary: "s" }))));
  const ctx = { topic: plan.title, weeks: 8, daysPerWeek: plan.daysPerWeek, granularity: plan.granularity, materials: plan.materials, hoursPerWeek: plan.hoursPerWeek, split: plan.split };
  for await (const e of streamExpandNode({ ...ctx, importText, tree, nodeId: tree.children![0].id, reason: "split" })) void e;
  return (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
}

describe("splitting an imported week into days", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });

  it("states the file's minutes and offers no format the week does not hold", async () => {
    const prompt = await week1DayPrompt("# Weekly plan");
    // The rows total 300 min of problems, 300 of the learner's other tasks and 60 of design; the covers 120 of reading.
    expect(prompt).toContain('Problems (format "problem-set"): about 5 h this week');
    expect(prompt).toContain('Other (format "other"): about 5 h this week');
    expect(prompt).toContain('Design (format "design-exercise"): about 1 h this week');
    expect(prompt).toContain("the week has about 2 h of reading");
    expect(prompt).toContain('Mock (format "mock"): none this week; write no Mock rows.');
    expect(prompt).not.toContain("write each yourself");
    expect(prompt).toContain("the rest of its time is for other, problems and design.");
    expect(prompt).toContain("Design's time is at most its blocks");
  });

  it("leaves a split on a track with no plan file as it was", async () => {
    const prompt = await week1DayPrompt(undefined);
    expect(prompt).not.toContain('Mock (format "mock"): none this week');
  });
});

describe("splitWeekTime", () => {
  const week = (over: Partial<PlanNode>): PlanNode => ({ ...fromTreeInput(converted().tree).children![0], ...over });

  it("sums the reservations by activity: must reading, and practice by format", () => {
    const w = week({
      materials: undefined,
      practice: undefined,
      covers: [
        { id: "M1", note: "Ch. 1–3", tier: "must", minutes: 90 },
        { id: "M1", note: "Ch. 9", tier: "should", minutes: 40 },
      ],
      practiceCovers: [
        { format: "other", id: null, note: null, task: "a", minutes: 100, imported: true },
        { format: "other", id: null, note: null, task: "b", minutes: 50, imported: true },
        { format: "problem-set", id: "M2", note: null, task: "c", minutes: 43, itemFrom: 1, itemTo: 1, imported: true },
      ],
    });
    expect(splitWeekTime(w)).toEqual({ reading: 90, practice: { other: 150, "problem-set": 43 } });
  });

  it("gives must reading the file left untimed what is left of the week's budget", () => {
    const w = week({ budgetHours: 5, covers: [{ id: "M1", note: "Ch. 1–3", tier: "must", minutes: null }], practiceCovers: [{ format: "other", id: null, note: null, task: "a", minutes: 200, imported: true }] });
    expect(splitWeekTime(w)).toEqual({ reading: 100, practice: { other: 200 } });
  });
});

describe("expanding an imported month into weeks", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });

  const month = (): ImportedPlan => {
    const result = convertDraft(
      {
        kind: "plan",
        title: "Q1",
        hoursPerWeek: 10,
        daysPerWeek: 5,
        level: "month",
        materials: [{ id: "M1", title: "SICP", author: null, kind: "book", practiceFormat: null, items: null }],
        units: [
          {
            title: "January",
            summary: "Start.",
            budgetHours: null,
            reading: [{ id: "M1", part: "Ch. 1", minutes: 120 }],
            practice: [
              { format: "other", id: null, items: null, task: "Set up the editor and the REPL", done: "Set up", minutes: 60 },
              { format: "other", id: null, items: null, task: "Write the study log template", done: "Written", minutes: 30 },
            ],
            children: null,
          },
        ],
        kept: [],
        skipped: [],
      },
      "q1.md",
    );
    if (!result.ok) throw new Error("fixture");
    return result.plan;
  };

  async function expand(importText: string | undefined): Promise<PlanNode[]> {
    const plan = month();
    const tree = fromTreeInput(plan.tree);
    // The weeks place the first task and read the chapter, and leave the second task out.
    const weeks: UnitDraft[] = [
      { title: "W1", summary: "s", materials: [{ id: "M1", tier: "must", minutes: 120, note: "Ch. 1" }], practice: [{ format: "other", task: "Set up the editor and the REPL", done: "Set up", minutes: 60 }] },
      { title: "W2", summary: "s" },
      { title: "W3", summary: "s" },
      { title: "W4", summary: "s" },
    ];
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks));
    let children: PlanNode[] = [];
    const ctx = { topic: plan.title, weeks: 4, daysPerWeek: plan.daysPerWeek, granularity: plan.granularity, materials: plan.materials, hoursPerWeek: plan.hoursPerWeek, split: plan.split };
    for await (const e of streamExpandNode({ ...ctx, importText, tree, nodeId: tree.children![0].id, reason: "expand" })) if (e.type === "finish") children = e.children;
    return children;
  }

  it("puts a learner's task the weeks left out on the lightest week", async () => {
    const weeks = await expand("# Q1");
    expect(weeks.map((w) => (w.practice ?? []).map((r) => r.task))).toEqual([["Set up the editor and the REPL"], ["Write the study log template"], [], []]);
    expect(weeks[1].practice![0]).toMatchObject({ format: "other", minutes: 30, imported: true });
    // The chapter the weeks read is not added again.
    expect(weeks.flatMap((w) => w.materials ?? [])).toHaveLength(1);
  });

  it("leaves the weeks as drafted on a track with no plan file", async () => {
    const weeks = await expand(undefined);
    expect(weeks.flatMap((w) => w.practice ?? []).map((r) => r.task)).toEqual(["Set up the editor and the REPL"]);
  });
});
