import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";

// Only streamObject and generateObject are faked; the error classes stay real so provider refusals are recognised.
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamObject: vi.fn(), generateObject: vi.fn() }));

import { generateObject, streamObject } from "ai";
import { APICallError } from "@ai-sdk/provider";
import type { ModelCall } from "./logged";
import type { ServiceEvent } from "./serviceEvents";
import { STRUCTURE_ALLOCATE_MIN_MS, STRUCTURE_RESERVE_MS, type StructureFinder } from "./research/structureFinder";
import { SourceFetcher } from "./research/tools";
import { DRAFT_BUDGET_MS, OUTLINE_RESERVE_MS, STEP_MIN_MS, nodeFor, streamExpandNode, timeOverLimit, toUnitTime, draftLevel, applyUnitRefs, streamPlanDraft, streamResearchedPlanDraft, weekLeafBlocks } from "./planDraft";
import { MAX_UNIT_MINUTES, unitTimeSchema } from "@/lib/schemas/plan";
import type { ResolvedModel } from "./resolve";
import type { PlanDraftEvent, PlanExpandEvent } from "@/lib/planChat";
import { aliasMaterials, type Breach } from "@/lib/materials";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import { AIE_MATERIALS, aiePlan } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS, PROBLEM_ITEMS } from "@/lib/__fixtures__/problemList";
import { DEFAULT_HOURS_PER_WEEK } from "@/lib/studyTime";

const mockedStreamObject = vi.mocked(streamObject);
const mockedGenerateObject = vi.mocked(generateObject);
const ALLOCATE_LABEL = "Allocate";

/** The split the first tests draft against, so they need no allocation call (the same shape the allocation yields). */
const SPLIT = { readingShare: 85, practice: "building projects", reason: "A craft topic.", formats: [{ format: "project" as const, share: 100, focus: "a small tool", reason: "Learning by building." }] };

/** What the allocation call returns by default: one project pick, and no part changed for any material. */
const ALLOCATION = { readingShare: 85, practice: "building projects", reason: "A craft topic.", picks: [{ format: "project", share: 100, focus: "a small tool", reason: "Learning by building." }], parts: [] };

/** Makes the allocation call return `object`; every plan drafted without a split makes one allocation call first. */
function respondAllocate(object: unknown = ALLOCATION) {
  mockedGenerateObject.mockResolvedValue({
    object,
    usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
    finishReason: "stop",
    providerMetadata: { gateway: { cost: "0.002" } },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
}

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

function material(id: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "docs", url: `https://example.com/${id}`, title: id, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, ...extra };
}

describe("streamPlanDraft with materials", () => {
  beforeEach(() => {
    // Braces matter: a returned mock would be called by the runner as a cleanup hook, with no arguments.
    mockedStreamObject.mockReset();
    mockedGenerateObject.mockReset();
    respondAllocate();
  });

  it("puts covers on headings and the Read table on leaves, drops unknown ids, and reports the checks", async () => {
    mockedStreamObject
      .mockReturnValueOnce(
        fakeStream([
          { title: "Foundations", summary: "a", covers: [{ id: "M1", note: "ch. 1–2" }, { id: "M9" }, { id: "M2" }] },
          { title: "Applied", summary: "b", covers: [{ id: "M1", note: "ch. 5" }] },
          { title: "Projects", summary: "c" },
          { title: "Review", summary: "d" },
        ]),
      )
      .mockReturnValueOnce(
        fakeStream(
          Array.from({ length: 7 }, (_, i) => ({
            title: `Day ${i + 1}`,
            summary: "d",
            materials: i === 0 ? [{ id: "M1", tier: "must" as const, minutes: 40.4, note: "ch. 1" }, { id: "M2", tier: "should" as const, minutes: 10 }] : [{ id: "M2", tier: "should" as const, minutes: 10 }],
          })),
        ),
      );
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({
      topic: "LLM engineering",
      weeks: 4, daysPerWeek: 7,
      granularity: "day",
      materials: [material("M1", { kind: "book", backbone: true }), material("M2")],
      split: SPLIT,
      log: { onCall: (c) => void calls.push(c) },
    })) {
      events.push(event);
    }
    const finish = events.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type !== "finish") return;
    const [w1, w2, w3] = finish.root.children!;
    expect(w3.covers).toBeUndefined();
    expect(w1.covers).toEqual([
      { id: "M1", note: "ch. 1–2", chapter: null, activity: "read" },
      { id: "M2", note: null, chapter: null, activity: "read" },
    ]);
    expect(w2.covers).toEqual([{ id: "M1", note: "ch. 5", chapter: null, activity: "read" }]);
    expect(w1.children![0].materials).toEqual([
      { id: "M1", tier: "must", minutes: 40, note: "ch. 1", chapter: null, activity: "read" },
      { id: "M2", tier: "should", minutes: 10, note: null, chapter: null, activity: "read" },
    ]);
    expect(calls[0].facts).toEqual(expect.arrayContaining(["dropped unknown M9", "backbone ch. 3, 4 not reserved"]));
    expect(calls[1].facts).toEqual(expect.arrayContaining(["no must: Week 1 · Day 2, Week 1 · Day 3, Week 1 · Day 4, Week 1 · Day 5, Week 1 · Day 6, Week 1 · Day 7"]));
    // The prompt for the week's days carries the week's reservation.
    const secondPrompt = mockedStreamObject.mock.calls[1][0] as { prompt: string };
    expect(secondPrompt.prompt).toContain("This unit's reservation, the only resources its days may use: M1 (ch. 1–2), M2.");
  });
});

describe("material ids in the text", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
    mockedGenerateObject.mockReset();
  });

  it("puts ids the model copied into titles, summaries and notes in words, and says so", async () => {
    const book = { ...bookOfSix(), title: "Ten Hours: A Book" };
    const essay = material("E", { kind: "essay", title: "On Interviews | A Blog", minutes: 20, minutesBasis: "measured" });
    mockedStreamObject.mockReturnValue(
      fakeStream([
        { title: "Start M1", summary: "Read M1.1–M1.2, then M2.", materials: [{ id: "M1.1", tier: "must", minutes: 100, note: "parts M1.1–M1.2" }, { id: "M2", tier: "should", minutes: 20, note: "whole essay" }] },
        { title: "Next", summary: "Go on.", materials: [{ id: "M1.3", tier: "must", minutes: 100 }] },
      ]),
    );
    const calls: ModelCall[] = [];
    let finish: PlanDraftEvent | undefined;
    for await (const event of streamPlanDraft({ topic: "Interviews", weeks: 2, daysPerWeek: 5, granularity: "week", materials: [book, essay], split: SPLIT, log: { onCall: (c) => void calls.push(c) } })) finish = event;
    if (finish?.type !== "finish") throw new Error("no finish");
    const [w1] = finish.root.children!;
    expect(w1.title).toBe("Start Ten Hours");
    expect(w1.summary).toBe("Read Ten Hours ch. 1–2, then On Interviews.");
    expect(w1.materials![0].note).toBe("parts ch. 1–2");
    expect(calls[0].facts).toContain("ids put in words in 3 fields");
  });
});

/** A six-chapter book of ten hours, so a kept chapter set shrinks it. */
function bookOfSix(): Material {
  return material("M1", {
    kind: "book",
    backbone: true,
    minutes: 600,
    minutesBasis: "estimated",
    toc: { source: "catalogue", url: "https://openlibrary.org/books/OL1M", printPages: false, end: null, chapters: Array.from({ length: 6 }, (_, i) => ({ n: i + 1, title: `Chapter ${i + 1}`, page: null, minutes: 100, sections: [] })) },
  });
}

describe("streamPlanDraft and the allocation", () => {
  beforeEach(() => {
    // Braces matter: a returned mock would be called by the runner as a cleanup hook, with no arguments.
    mockedStreamObject.mockReset();
    mockedGenerateObject.mockReset();
    respondAllocate();
  });

  const weeks = (n: number): UnitDraft[] => Array.from({ length: n }, (_, i) => ({ title: `W${i + 1}`, summary: "s" }));
  const budgeted = { ...ALLOCATION, parts: [{ id: "M1", purpose: null, minutes: null, units: [{ from: 1, to: 3 }], items: null, drop: false, dropReason: null }] };

  it("emits the plan's coverage with the allocated materials, and null when the allocation fails", async () => {
    const coverage = { covered: ["Branching"], open: ["Rebasing"] };
    respondAllocate({ ...budgeted, coverage });
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const first: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", hoursPerWeek: 10, materials: [bookOfSix()] })) first.push(event);
    expect(first[0]).toMatchObject({ type: "allocated", coverage });

    mockedGenerateObject.mockReset();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedGenerateObject.mockRejectedValue(new Error("down"));
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const second: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", hoursPerWeek: 10, materials: [bookOfSix()] })) second.push(event);
    expect(second[0]).toMatchObject({ type: "allocated", coverage: null });
    error.mockRestore();
  });

  it("allocates after research, then sends the allocated materials and the split before any node", async () => {
    respondAllocate(budgeted);
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", hoursPerWeek: 10, materials: [bookOfSix()], log: { onCall: (c) => void calls.push(c) } })) events.push(event);

    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
    const kinds = events.map((e) => e.type);
    expect(kinds.slice(0, 2)).toEqual(["allocated", "split"]);
    expect(kinds.indexOf("node")).toBeGreaterThan(1);
    expect(kinds.filter((k) => k === "allocated" || k === "split")).toHaveLength(2);
    const allocated = events[0];
    if (allocated.type !== "allocated") throw new Error("no allocated event");
    expect(allocated.dropped).toEqual([]);
    expect(allocated.materials).toHaveLength(1);
    // The allocation keeps chapters 1–3: the whole list stays, marked with them for the outline, and their minutes are its time.
    expect(allocated.materials[0].toc?.chapters).toHaveLength(6);
    expect(allocated.materials[0].toc?.kept).toEqual([1, 2, 3]);
    expect(allocated.materials[0].minutes).toBe(300);
    // The reading share follows the kept chapters: 300 of the 2400 minutes.
    expect(events[1]).toEqual({
      type: "split",
      split: { readingShare: 13, practice: "building projects", reason: "A craft topic.", formats: [{ format: "project", share: 100, focus: "a small tool", reason: "Learning by building." }] },
    });
    const finish = events.at(-1);
    expect(finish?.type === "finish" && finish.root.children!.map((n) => n.budgetHours)).toEqual([10, 10, 10, 10]);
    // The drafter is never asked to decide a split; it is told the one the allocation made, with the allocated chapters.
    expect(calls.map((c) => c.label)).toEqual([ALLOCATE_LABEL, "Top level · 4 weeks"]);
    expect(calls[1].prompt).not.toContain('as "split"');
    expect(calls[1].prompt).toContain("How this plan spends that time: about 13% reading or watching the materials, the rest on project.");
  });

  it("sends the materials the allocation dropped, and drafts without them", async () => {
    respondAllocate({
      ...ALLOCATION,
      parts: [
        { id: "M1", purpose: null, minutes: null, items: null, drop: false, dropReason: null },
        { id: "M2", purpose: null, minutes: null, items: null, drop: true, dropReason: "the book covers it" },
      ],
    });
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [material("M1"), material("M2", { title: "Found essay" })] })) events.push(event);
    const allocated = events[0];
    if (allocated.type !== "allocated") throw new Error("no allocated event");
    expect(allocated.materials.map((m) => m.id)).toEqual(["M1"]);
    expect(allocated.dropped).toEqual([{ title: "Found essay", url: "https://example.com/M2", reason: "not used by the plan: the book covers it", stage: "plan" }]);
    expect((mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt).not.toContain("Found essay");
  });

  it("adds the allocation's cost to the finish event", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const rows: (number | null)[] = [];
    let finish: PlanDraftEvent | undefined;
    for await (const event of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], log: { onLog: (row) => void rows.push(row.costUsd) } })) {
      if (event.type === "finish") finish = event;
    }
    expect(rows).toEqual([0.002, 0.004]);
    expect(finish?.type === "finish" && finish.costUsd).toBeCloseTo(0.006, 10);
  });

  it("drafts the weeks on Opus 5.5 at high effort, and records the effort", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const rows: { caller: string; model: string; effort: string | null }[] = [];
    for await (const event of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], log: { onLog: (row) => void rows.push(row) } })) void event;
    const call = mockedStreamObject.mock.calls[0][0] as { model: unknown; providerOptions?: unknown };
    expect(call.model).toBe("anthropic/claude-opus-5.5");
    expect(call.providerOptions).toEqual({ anthropic: { effort: "high" } });
    expect(rows.find((r) => r.caller === "outline" && r.model === "anthropic/claude-opus-5.5" && r.effort === "high")).toBeDefined();
  });

  it("lets a refusal on the learner's own key propagate without drafting anything", async () => {
    const refusal = new APICallError({ message: "Your credit balance is too low", url: "https://api.anthropic.com", requestBodyValues: {}, statusCode: 400 });
    mockedGenerateObject.mockReset();
    mockedGenerateObject.mockRejectedValue(refusal);
    const allocateModel = { id: "anthropic/claude-opus-5.5", model: {}, keyOwner: "user" } as unknown as ResolvedModel;
    const events: PlanDraftEvent[] = [];
    await expect(async () => {
      for await (const event of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], allocateModel })) events.push(event);
    }).rejects.toBe(refusal);
    expect(events).toEqual([]);
    expect(mockedStreamObject).not.toHaveBeenCalled();
  });

  it("drafts an all-reading plan when the allocation fails on the app's key", async () => {
    mockedGenerateObject.mockReset();
    mockedGenerateObject.mockRejectedValueOnce(new Error("No object generated"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const materials = [material("M1")];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials })) events.push(event);
    expect(events[0]).toEqual({ type: "allocated", materials: materials.map((m) => ({ ...m, uses: null })), dropped: [], coverage: null });
    expect(events[1]).toEqual({ type: "split", split: { readingShare: 100, practice: "reading", reason: "", formats: [] } });
    expect(events.at(-1)?.type).toBe("finish");
    error.mockRestore();
  });

  it("drafts an all-reading plan when the allocation returns nothing usable", async () => {
    respondAllocate({ readingShare: "lots", practice: "", reason: "" });
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [] })) events.push(event);
    expect(events.find((e) => e.type === "split")).toEqual({ type: "split", split: { readingShare: 100, practice: "reading", reason: "", formats: [] } });
    expect(events.at(-1)?.type).toBe("finish");
    error.mockRestore();
  });

  it("does not allocate when a split is given", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const calls: ModelCall[] = [];
    const split = { readingShare: 50, practice: "building", reason: "" };
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", split, materials: [], log: { onCall: (c) => void calls.push(c) } })) events.push(event);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "split" || e.type === "allocated")).toBe(false);
    expect(calls[0].prompt).toContain("the rest on building");
  });

  it("passes the allocate model and the request's signal to the allocation", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const controller = new AbortController();
    const direct = { modelId: "claude-opus-5-5", provider: "anthropic.messages" };
    const allocateModel: ResolvedModel = { model: direct as never, id: "anthropic/claude-opus-5.5", keyOwner: "user" };
    for await (const _ of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], allocateModel, signal: controller.signal })) void _;
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
    expect(mockedGenerateObject.mock.calls[0][0]).toMatchObject({ model: direct, abortSignal: controller.signal });
  });

  it("allocates on the app's allocate model when none is given", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const calls: ModelCall[] = [];
    for await (const _ of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], log: { onCall: (c) => void calls.push(c) } })) void _;
    expect(calls[0].label).toBe(ALLOCATE_LABEL);
    expect(calls[0].model).toBe("anthropic/claude-opus-5.5");
  });

  it("allocates over the plan's hours, the default week when none is given", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const calls: ModelCall[] = [];
    for await (const _ of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], log: { onCall: (c) => void calls.push(c) } })) void _;
    expect(calls[0].prompt).toContain(`${4 * DEFAULT_HOURS_PER_WEEK} hours`);
  });

  it("shows the allocation every material, the learner's and the researched", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const learner = material("L1", { origin: "learner", title: "My notes" });
    const found = material("R1", { title: "Found by research" });
    for await (const _ of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [learner, found] })) void _;
    const prompt = (mockedGenerateObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("My notes");
    expect(prompt).toContain("Found by research");
  });

  it("drafts on the outline model it is given and records who paid", async () => {
    mockedStreamObject.mockImplementation(() =>
      fakeStream([
        { title: "A", summary: "a" },
        { title: "B", summary: "b" },
        { title: "C", summary: "c" },
        { title: "D", summary: "d" },
      ]),
    );
    const direct = { modelId: "claude-haiku-4-5", provider: "anthropic.messages" };
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({
      topic: "T",
      weeks: 4, daysPerWeek: 7,
      granularity: "week",
      materials: [],
      hoursPerWeek: 6,
      outlineModel: { model: direct as never, id: "anthropic/claude-haiku-4.5", keyOwner: "user" },
      log: { onCall: (c) => void calls.push(c) },
    }))
      events.push(event);
    expect(events.at(-1)?.type).toBe("finish");
    expect(mockedStreamObject.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockedStreamObject.mock.calls) expect(call[0].model).toBe(direct);
    // The allocation runs on its own model, not the units' (the app's, as none was given).
    expect(mockedGenerateObject.mock.calls).toHaveLength(1);
    expect(mockedGenerateObject.mock.calls[0][0].model).toBe("anthropic/claude-opus-5.5");
    expect(calls.length).toBe(mockedStreamObject.mock.calls.length + 1);
    expect(calls.filter((c) => c.label !== ALLOCATE_LABEL).every((c) => c.model === "anthropic/claude-haiku-4.5" && c.keyOwner === "user")).toBe(true);
  });

  it("rethrows a stream failure instead of waiting on an object that never arrives", async () => {
    // The SDK reports a failed stream through onError and ends the partial stream; result.object never settles.
    const refusal = Object.assign(new Error("Your credit balance is too low"), { statusCode: 400 });
    mockedStreamObject.mockImplementation((opts) => {
      const onError = (opts as { onError?: (e: { error: unknown }) => void }).onError;
      return {
        // The SDK calls onError while the stream is consumed, then ends the stream without a result.
        partialObjectStream: (async function* () {
          onError?.({ error: refusal });
        })(),
        object: new Promise(() => {}),
        usage: new Promise(() => {}),
        finishReason: new Promise(() => {}),
      } as unknown as ReturnType<typeof streamObject>;
    });
    await expect(async () => {
      for await (const _ of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], hoursPerWeek: 6 })) void _;
    }).rejects.toBe(refusal);
  });

});

describe("streamResearchedPlanDraft", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
    mockedGenerateObject.mockReset();
    respondAllocate();
  });

  const weeks = (n: number): UnitDraft[] => Array.from({ length: n }, (_, i) => ({ title: `W${i + 1}`, summary: "s" }));
  const offline = { fetcher: { fetch: vi.fn() } as never, books: vi.fn() as never };

  it("researches first, then allocates, and sends the allocation and the split before any node", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamResearchedPlanDraft({
      topic: "Git",
      weeks: 4,
      daysPerWeek: 7,
      materials: [],
      granularity: "week",
      arm: null,
      research: offline,
      log: { onCall: (c) => void calls.push(c) },
    })) events.push(event);

    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe("research.start");
    const done = kinds.indexOf("research.done");
    expect(done).toBeGreaterThan(0);
    expect(kinds.slice(done + 1, done + 3)).toEqual(["allocated", "split"]);
    expect(kinds.filter((k) => k === "split")).toHaveLength(1);
    expect(kinds.indexOf("node")).toBeGreaterThan(done + 2);
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
    expect(kinds.at(-1)).toBe("finish");
    expect(calls.at(-1)?.prompt).toContain("the rest on project.");
  });

  it("starts research with no split, and allocates the materials research ended with", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const learner = { type: "note" as const, title: "My notes", url: "note:1", text: "Notes on branching." };
    const events: PlanDraftEvent[] = [];
    for await (const event of streamResearchedPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, materials: [learner], granularity: "week", arm: null, research: offline })) events.push(event);
    const done = events.find((e) => e.type === "research.done");
    const allocated = events.find((e) => e.type === "allocated");
    if (done?.type !== "research.done" || allocated?.type !== "allocated") throw new Error("missing events");
    expect(done.materials.map((m) => m.title)).toContain("My notes");
    expect(allocated.materials.map((m) => m.id)).toEqual(done.materials.map((m) => m.id));
    expect((mockedGenerateObject.mock.calls[0][0] as { prompt: string }).prompt).toContain("My notes");
  });

  it("adds the allocation's cost to the finish event", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const rows: (number | null)[] = [];
    let finish: PlanDraftEvent | undefined;
    for await (const event of streamResearchedPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, materials: [], granularity: "week", arm: null, research: offline, log: { onLog: (row) => void rows.push(row.costUsd) } })) {
      if (event.type === "finish") finish = event;
    }
    expect(rows).toEqual([0.002, 0.004]);
    expect(finish?.type === "finish" && finish.costUsd).toBeCloseTo(0.006, 10);
  });

  it("keeps a split it is given and makes no allocation call", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const split = { readingShare: 50, practice: "building", reason: "" };
    const events: PlanDraftEvent[] = [];
    for await (const event of streamResearchedPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, materials: [], granularity: "week", split, arm: null, research: offline })) events.push(event);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "split" || e.type === "allocated")).toBe(false);
  });

  it("lets a refusal on the learner's own key propagate after research and before any node", async () => {
    const refusal = new APICallError({ message: "refused", url: "https://api.anthropic.com", requestBodyValues: {}, statusCode: 401 });
    mockedGenerateObject.mockReset();
    mockedGenerateObject.mockRejectedValue(refusal);
    const allocateModel = { id: "anthropic/claude-opus-5.5", model: {}, keyOwner: "user" } as unknown as ResolvedModel;
    const events: PlanDraftEvent[] = [];
    await expect(async () => {
      for await (const event of streamResearchedPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, materials: [], granularity: "week", arm: null, research: offline, allocateModel })) events.push(event);
    }).rejects.toBe(refusal);
    expect(events.some((e) => e.type === "research.done")).toBe(true);
    expect(events.some((e) => e.type === "node" || e.type === "split" || e.type === "allocated")).toBe(false);
    expect(mockedStreamObject).not.toHaveBeenCalled();
  });

  it("passes the allocate model and the request's signal to the allocation", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const controller = new AbortController();
    const direct = { modelId: "claude-opus-5-5", provider: "anthropic.messages" };
    const allocateModel: ResolvedModel = { model: direct as never, id: "anthropic/claude-opus-5.5", keyOwner: "app" };
    for await (const _ of streamResearchedPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, materials: [], granularity: "week", arm: null, research: offline, allocateModel, signal: controller.signal })) void _;
    expect(mockedGenerateObject.mock.calls[0][0]).toMatchObject({ model: direct, abortSignal: controller.signal });
  });

  it("gives research the draft's deadline and the structure finder", async () => {
    // The learner's own long page: a structure finder runs for it when there is time.
    const primer = "https://primer.example.com/";
    const fetcher = new SourceFetcher(async (url) => ({ finalUrl: url, title: "Primer", ogTitle: null, h1: null, author: null, published: null, text: "About design", words: 30_000 }));
    const finder = { find: vi.fn<StructureFinder["find"]>(async () => ({ toc: null, minutes: null, basis: null, list: null, refused: null, facts: [], note: null, units: 0, counts: { searches: 0, fetches: 0 }, costUsd: 0 })) };
    const draft = async (deadline: number) => {
      mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
      const events: PlanDraftEvent[] = [];
      const materials = [{ type: "link" as const, url: primer }];
      for await (const event of streamResearchedPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, materials, granularity: "week", arm: null, research: { fetcher, books: offline.books, structure: finder }, deadline })) {
        events.push(event);
      }
      return events;
    };
    const late = await draft(Date.now() + 150_000);
    expect(finder.find).not.toHaveBeenCalled();
    expect(late.some((e) => e.type === "research.structure")).toBe(false);
    const early = await draft(Date.now() + DRAFT_BUDGET_MS);
    expect(finder.find).toHaveBeenCalledTimes(1);
    expect(finder.find.mock.calls[0][0]).toMatchObject({ origin: "learner", title: "Primer" });
    expect(early.some((e) => e.type === "research.structure")).toBe(true);
  });

  it("leaves the allocation and the outline their time after the structure stage", () => {
    expect(STRUCTURE_RESERVE_MS).toBe(STRUCTURE_ALLOCATE_MIN_MS + OUTLINE_RESERVE_MS);
  });

  it("stops at an aborted request instead of drafting", async () => {
    const controller = new AbortController();
    controller.abort();
    mockedGenerateObject.mockReset();
    mockedGenerateObject.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(async () => {
      for await (const _ of streamResearchedPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, materials: [], granularity: "week", arm: null, research: offline, signal: controller.signal })) void _;
    }).rejects.toThrow("aborted");
    expect(mockedStreamObject).not.toHaveBeenCalled();
  });
});

/** The stream shape of a failed call: onError fires while the stream is consumed, and the result never settles. */
function failingStream(error: unknown) {
  return (opts: unknown) => {
    const onError = (opts as { onError?: (e: { error: unknown }) => void }).onError;
    return {
      partialObjectStream: (async function* () {
        onError?.({ error });
      })(),
      object: new Promise(() => {}),
      usage: new Promise(() => {}),
      finishReason: new Promise(() => {}),
    } as unknown as ReturnType<typeof streamObject>;
  };
}

describe("breaches while drafting", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });
  const ctx = { topic: "AI engineering", weeks: 1, daysPerWeek: 7, granularity: "day" as const, materials: AIE_MATERIALS, hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" } };
  const dayUnits = (chapters: number[]) => chapters.map((c, i) => ({ title: `D${i + 1}`, summary: "s", materials: [{ id: `M1.${c}`, tier: "must" as const, minutes: 20 }] }));
  /** The fixture with week 1 as a hand-split week: its Read table has become its reservation. */
  const tree = () => {
    const r = aiePlan();
    const w1 = r.children![0].children![0];
    w1.covers = w1.materials!.map((m) => ({ id: m.id, chapter: m.chapter, note: null }));
    delete w1.materials;
    return r;
  };

  it("drafts a breaching level once, keeps its units as written, and sends its problems with the finish", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 1, 2, 2, 3, 3, 4])));
    const calls: ModelCall[] = [];
    const events: PlanExpandEvent[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) events.push(e);
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "child")).toHaveLength(6); // the last unit arrives with done
    expect(calls.map((c) => c.label)).toEqual(["Week 1 · 7 days"]);
    expect(calls[0].facts).toContain("breach: Week 1 · Day 5 reads M1.3, which Week 2 holds");
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error("no finish");
    // Nothing is dropped: the days that read chapters 3 and 4 keep them.
    expect(finish.children.map((d) => d.materials![0].chapter)).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect(finish.problems).toContain("Week 1 · Day 5 reads AI Engineering ch. 3, which Week 2 holds.");
    expect(finish.problems.every((p) => !/\bM\d/.test(p))).toBe(true);
  });
  it("sends no problems with the finish when the level keeps every rule", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 1, 1, 2, 2, 2, 2])));
    const events: PlanExpandEvent[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split" })) events.push(e);
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error("no finish");
    expect(finish.problems).toEqual([]);
  });
  it("a hand-split week's Read table is its reservation even when the client has not converted it", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3])));
    const calls: ModelCall[] = [];
    // The real client sends the tree before splitWeek runs: week 1 still carries `materials`.
    for await (const e of streamExpandNode({ ...ctx, tree: aiePlan(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) void e;
    const firstPrompt = (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(firstPrompt).toContain("This unit's reservation, the only resources its days may use: M1.1–M1.2.");
    expect(calls[0].facts).toContain("breach: Week 1 · Day 2 reads M1.3, which Week 1 did not reserve");
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
  });
  it("sizes chapter rows from the list before judging the budget", async () => {
    const week = (title: string, ids: string[], minutes: number[]) => ({ title, summary: "s", materials: ids.map((id, i) => ({ id, tier: "must" as const, minutes: minutes[i] })) });
    // The model wrote flat 60-minute rows, 240 min in week 1; its chapters are 107, 140, 93 and 126 minutes.
    const weeks = [week("W1", ["M1.1", "M1.2", "M1.3", "M1.4"], [60, 60, 60, 60]), week("W2", ["M1.5"], [60]), week("W3", ["M1.6"], [60]), week("W4", ["M1.7"], [60])];
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks));
    const calls: ModelCall[] = [];
    for await (const _ of streamPlanDraft({ ...ctx, weeks: 4, daysPerWeek: 7, granularity: "week", log: { onCall: (c) => void calls.push(c) } })) void _;
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(calls[0].facts).toContain("breach: Week 1 plans 466 min in a week of 360 min.");
  });
  it("keeps rows that breach, drops nothing and reports them", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3])));
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    let problems: string[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) {
      if (e.type === "finish") ({ children, problems } = e);
    }
    expect(children[1].materials!.map((m) => m.chapter)).toEqual([3]);
    expect(calls[0].facts.some((f) => f.startsWith("dropped M1.3"))).toBe(false);
    expect(problems).toContain("Week 1 · Day 2 reads AI Engineering ch. 3, which Week 1 did not reserve.");
  });
  it("drafts a top level over its hours once, keeps its units unchanged, and puts its problems on the root", async () => {
    const week = (title: string, ids: string[], minutes: number[]) => ({ title, summary: "s", materials: ids.map((id, i) => ({ id, tier: "must" as const, minutes: minutes[i] })) });
    const weeks = [
      week("W1", ["M1.1", "M1.2", "M1.3", "M1.4"], [107, 140, 93, 126]),
      ...["M1.5", "M1.6", "M1.7"].map((id, i) => week(`W${i + 2}`, [id], [60])),
    ];
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks));
    const calls: ModelCall[] = [];
    let root: PlanNode | null = null;
    for await (const e of streamPlanDraft({ ...ctx, weeks: 4, daysPerWeek: 7, granularity: "week", log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") root = e.root;
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.label)).toEqual(["Top level · 4 weeks"]);
    expect(calls[0].facts).toContain("breach: Week 1 plans 466 min in a week of 360 min.");
    expect(calls[0].facts.some((f) => f.startsWith("dropped M1"))).toBe(false);
    expect(root!.children!.map((w) => w.title)).toEqual(weeks.map((w) => w.title));
    expect(root!.children![0].materials!.map((m) => m.chapter)).toEqual([1, 2, 3, 4]);
    expect(root!.problems).toContain("Week 1 plans 7 h 46 min in a week of 6 h.");
  });
  it("a budget the outline misses stays as written and is reported", async () => {
    const units = [10, 10, 10, 10, 10].map((minutes, i) => ({ n: i + 1, title: `U${i + 1}`, page: null, minutes, sections: [] }));
    const primer = material("primer", { minutes: 50, toc: { source: "catalogue", url: "u", printPages: false, end: null, chapters: units } });
    // Each week reads one 10-minute unit of the primer's 50-minute budget.
    const weeks = ["W1", "W2"].map((title, i) => ({ title, summary: "s", materials: [{ id: `M1.${i + 1}`, tier: "must" as const, minutes: 10 }] }));
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks));
    const calls: ModelCall[] = [];
    let root: PlanNode | null = null;
    for await (const e of streamPlanDraft({ ...ctx, materials: [primer], weeks: 2, granularity: "week", log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") root = e.root;
    const miss = "M1's units reserved add up to about 20 min against its budget of about 50 min";
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(calls[0].facts).toContain(`breach: ${miss}`);
    expect(calls[0].facts.some((f) => f.startsWith("dropped"))).toBe(false);
    expect(root!.problems).toEqual(["primer's units reserved add up to about 20 min against its budget of about 50 min."]);
  });
  it("splits a week into the number of days picked, each a share of that week", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 1, 2])));
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", splitDays: 3, log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    const prompt = mockedStreamObject.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Its 3 days cover, in order:");
    // Six hours over three days is two hours a day; must-reading is budgeted over the week, 40% of its 6 h.
    expect(prompt).toContain("3. Day 3 — budget about 2 h\n");
    expect(prompt).toContain("Across the week, the days' must minutes add up to no more than about 2 h 24 min.");
    expect(prompt).not.toContain("4. Day 4");
    expect(children.map((c) => c.len)).toEqual([1, 1, 1]);
    expect(calls[0].facts).toContain("3 of 3 units");
  });
  it("puts each planned parent's problems on it, and leaves a parent without any with none", async () => {
    const week = (title: string, ids: string[]) => ({ title, summary: "s", covers: ids.map((id) => ({ id })) });
    const weeks = [week("W1", ["M1.1", "M1.2"]), week("W2", ["M1.3"]), week("W3", ["M1.4"]), week("W4", ["M1.5"])];
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks)).mockReturnValueOnce(fakeStream(dayUnits([1, 3])));
    let root: PlanNode | null = null;
    for await (const e of streamPlanDraft({ ...ctx, weeks: 4, daysPerWeek: 2, granularity: "day" })) if (e.type === "finish") root = e.root;
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    const w1 = root!.children![0];
    expect(w1.problems).toEqual(expect.arrayContaining(["Week 1 · Day 2 reads AI Engineering ch. 3, which Week 1 did not reserve."]));
    expect(w1.children!.map((d) => d.materials![0].chapter)).toEqual([1, 3]);
    expect(root!.children![1].problems).toBeUndefined();
  });
});

describe("practice while drafting", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });
  const problems = material("M2", { kind: "course", practice: { format: "problem-set", items: 150, perItemMinutes: 10, minutes: null, answers: true } });
  const materials = [material("M1"), problems];
  const split = {
    readingShare: 50,
    practice: "problems and labs",
    reason: "r",
    formats: [
      { format: "problem-set" as const, share: 50, focus: "arrays", reason: "" },
      { format: "lab" as const, share: 50, focus: "git", reason: "" },
    ],
  };
  const ctx = { topic: "Interviews", weeks: 1, daysPerWeek: 7, granularity: "week" as const, materials, hoursPerWeek: 6, split };
  /** A one-week plan whose week leaf is split by hand: it reads M1 and practises M2. */
  const tree = () =>
    makeRoot([
      makeNode({
        id: "w1",
        level: "week",
        title: "Arrays",
        summary: "s",
        len: 7,
        budgetHours: 6,
        materials: [{ id: "M1", tier: "must", minutes: 60, note: null }],
        practice: [{ format: "problem-set", id: "M2", task: "Arrays 1–6", done: "all pass", minutes: 40, generated: false }],
      }),
    ]);

  it("puts practice rows on days, refuses what the rules forbid, and gives a sourceless lab's time to reading", async () => {
    const units: UnitDraft[] = [
      {
        title: "D1",
        summary: "s",
        materials: [{ id: "M1", tier: "must", minutes: 60 }],
        practice: [
          { format: "problem-set", id: "M2", task: "Arrays 1–3", done: "all pass", minutes: 20 },
          { format: "problem-set", task: "Problems of my own", done: "solved", minutes: 10 },
        ],
      },
      { title: "D2", summary: "s", practice: [{ format: "problem-set", id: "M2", task: "Arrays 4–6", done: "all pass", minutes: 20 }, { format: "lab", task: "A git lab", done: "passes", minutes: 30 }] },
      { title: "D3", summary: "s" },
    ];
    mockedStreamObject.mockReturnValueOnce(fakeStream(units)).mockReturnValueOnce(fakeStream(units));
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", splitDays: 3, log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    const prompt = (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
    // The split week's practice row is the reservation its days are planned from.
    expect(prompt).toContain("Reserved for this unit: M2 40 min: Arrays 1–6.");
    expect(prompt).not.toContain("Lab");
    expect(children[0].practice).toEqual([{ format: "problem-set", id: "M2", task: "Arrays 1–3", done: "all pass", minutes: 20, generated: false }]);
    expect(children[1].practice).toEqual([{ format: "problem-set", id: "M2", task: "Arrays 4–6", done: "all pass", minutes: 20, generated: false }]);
    expect(children[2].practice).toBeUndefined();
    expect(calls[0].facts).toContain("no source for Lab: its time goes to reading");
    expect(calls[0].facts).toContain('refused Problems "Problems of my own": no source, and this format is never written; Lab "A git lab": no source, and this format is never written');
  });

  it("checks practice written without a source when the plan has no materials", async () => {
    const design = { readingShare: 50, practice: "design", reason: "r", formats: [{ format: "design-exercise" as const, share: 100, focus: "systems", reason: "" }] };
    const day = (title: string, minutes: number): UnitDraft => ({ title, summary: "s", practice: [{ format: "design-exercise", task: "Design a cache", done: "covers eviction and consistency", minutes }] });
    const first = [day("D1", 200), day("D2", 30), day("D3", 30), day("D4", 30), day("D5", 30)];
    mockedStreamObject.mockReturnValueOnce(fakeStream(first));
    const calls: ModelCall[] = [];
    for await (const _ of streamPlanDraft({ topic: "Systems", weeks: 1, daysPerWeek: 5, granularity: "day", materials: [], hoursPerWeek: 6, split: design, log: { onCall: (c) => void calls.push(c) } })) void _;
    // Six hours over five days is 70 min a day: a 200-minute day breaches, and is reported, not asked again.
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(calls[0].facts).toContain("breach: Day 1 is 200 min of reading and practice against a budget of about 70 min");
  });

  it("reserves practice sources on headings", () => {
    const node = nodeFor(
      { title: "Month", summary: "s", covers: [{ id: "M1" }], practiceCovers: [{ format: "problem-set", id: "M2", note: "Arrays & Hashing" }], practice: [{ format: "problem-set", id: "M2", task: "t", done: "d", minutes: 5 }] },
      "month",
      28,
      "week",
      aliasMaterials(materials),
      6,
      split,
    );
    expect(node.practiceCovers).toEqual([{ format: "problem-set", id: "M2", note: "Arrays & Hashing" }]);
    expect(node.practice).toBeUndefined();
  });
});

describe("unit time while drafting", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });
  const problems = material("M2", { kind: "course", practice: { format: "problem-set", items: 150, perItemMinutes: 10, minutes: null, answers: true } });
  const materials = [material("M1", { minutes: 300 }), problems];
  const split = {
    readingShare: 40,
    practice: "problems and design",
    reason: "r",
    formats: [
      { format: "problem-set" as const, share: 80, focus: "arrays", reason: "" },
      { format: "design-exercise" as const, share: 20, focus: "systems", reason: "" },
    ],
  };
  const ctx = { topic: "Interviews", weeks: 8, daysPerWeek: 5, granularity: "day" as const, materials, hoursPerWeek: 6, split };

  it("keeps a heading's time for the picked formats, leaves a heading without one unset, and names a format the split never picked", async () => {
    const month = makeNode({ id: "m1", level: "month", title: "Foundations", summary: "s", len: 10 });
    mockedStreamObject.mockReturnValueOnce(
      fakeStream([
        { title: "W1", summary: "s", time: { reading: 150, practice: [{ format: "problem-set", minutes: 180 }, { format: "lab", minutes: 30 }] } },
        { title: "W2", summary: "s" },
      ]),
    );
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: makeRoot([month]), nodeId: "m1", reason: "expand", log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    expect(children[0].time).toEqual({ reading: 150, practice: { "problem-set": 180 } });
    expect(children[1].time).toBeUndefined();
    expect(calls[0].facts.filter((f) => f.includes("lab"))).toEqual(["dropped time for unpicked lab"]);
  });

  it("puts no time on leaves", async () => {
    const week = makeNode({ id: "w1", level: "week", title: "Arrays", summary: "s", len: 2 });
    mockedStreamObject.mockReturnValueOnce(fakeStream([1, 2].map((n) => ({ title: `D${n}`, summary: "s", time: { reading: 30, practice: [{ format: "problem-set" as const, minutes: 40 }] } }))));
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: makeRoot([week]), nodeId: "w1", reason: "expand" })) if (e.type === "finish") children = e.children;
    expect(children.map((c) => c.time)).toEqual([undefined, undefined]);
  });
});

describe("toUnitTime", () => {
  it("sums a format given twice and returns the formats the split never picked", () => {
    const draft = { reading: 60, practice: [{ format: "problem-set" as const, minutes: 40 }, { format: "mock" as const, minutes: 75 }, { format: "problem-set" as const, minutes: 20 }] };
    expect(toUnitTime(draft, ["problem-set", "recall"])).toEqual({ time: { reading: 60, practice: { "problem-set": 60 } }, unpicked: ["mock"] });
  });

  it("holds each activity's minutes to what a saved unit may keep, so a slip does not fail the plan's save", () => {
    const draft = { reading: 45000, practice: [{ format: "problem-set" as const, minutes: 20000 }, { format: "problem-set" as const, minutes: 20000 }, { format: "recall" as const, minutes: 90 }] };
    const { time } = toUnitTime(draft, ["problem-set", "recall"]);
    expect(time).toEqual({ reading: MAX_UNIT_MINUTES, practice: { "problem-set": MAX_UNIT_MINUTES, recall: 90 } });
    expect(unitTimeSchema.safeParse(time).success).toBe(true);
    expect(timeOverLimit(draft)).toBe(true);
    expect(timeOverLimit({ reading: 60, practice: [{ format: "recall", minutes: 90 }] })).toBe(false);
  });
});

describe("week leaves drafted in blocks", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
    mockedGenerateObject.mockReset();
  });

  const weekRows = (from: number, count: number, extra: (n: number) => Partial<UnitDraft> = () => ({})): UnitDraft[] =>
    Array.from({ length: count }, (_, i) => ({ title: `W${from + i}`, summary: "s", ...extra(from + i) }));

  /** A stream that sends nothing until `gate` opens: a block's call that is still running. */
  function gatedStream(units: UnitDraft[], gate: Promise<void>) {
    const stream = fakeStream(units);
    const partials = stream.partialObjectStream;
    return {
      ...stream,
      partialObjectStream: (async function* () {
        await gate;
        yield* partials;
      })(),
    } as unknown as ReturnType<typeof streamObject>;
  }

  it("lists the blocks a top level of week leaves is drafted in: one call up to four weeks, blocks of at most three beyond", () => {
    expect(weekLeafBlocks(1)).toEqual([1]);
    expect(weekLeafBlocks(4)).toEqual([4]);
    expect(weekLeafBlocks(5)).toEqual([2, 3]);
    expect(weekLeafBlocks(6)).toEqual([3, 3]);
    expect(weekLeafBlocks(8)).toEqual([2, 3, 3]);
    expect(weekLeafBlocks(10)).toEqual([2, 2, 3, 3]);
  });

  it("drafts eight week leaves as block headings, then every block's weeks at once, and sends the weeks in order", async () => {
    const heads: UnitDraft[] = [
      { title: "Start", summary: "s", covers: [{ id: "M1.1" }, { id: "M1.2" }], time: { reading: 200, practice: [{ format: "project", minutes: 760 }] } },
      { title: "Middle", summary: "s", covers: [{ id: "M1.3" }, { id: "M1.4" }], time: { reading: 200, practice: [{ format: "project", minutes: 1240 }] } },
      { title: "End", summary: "s", covers: [{ id: "M1.5" }, { id: "M1.6" }], time: { reading: 200, practice: [{ format: "project", minutes: 1240 }] } },
    ];
    // The first block's weeks arrive only once every block's call has started: the blocks run at once, not in turn.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    mockedStreamObject
      .mockReturnValueOnce(fakeStream(heads))
      .mockReturnValueOnce(gatedStream(weekRows(1, 2, (n) => ({ materials: [{ id: `M1.${n}`, tier: "must", minutes: 100 }] })), gate))
      .mockReturnValueOnce(fakeStream(weekRows(3, 3)))
      .mockImplementationOnce(() => {
        open();
        return fakeStream(weekRows(6, 3));
      });
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "Interviews", weeks: 8, daysPerWeek: 5, granularity: "week", hoursPerWeek: 8, materials: [bookOfSix()], split: SPLIT, log: { onCall: (c) => void calls.push(c) } })) {
      events.push(event);
    }
    expect(mockedStreamObject).toHaveBeenCalledTimes(4);
    const prompts = mockedStreamObject.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);
    expect(prompts[0]).toContain("Split the plan into 3 months");
    expect(prompts[0]).toContain("1. Month 1 (2 weeks)");
    expect(prompts[2]).toContain('Plan the weeks inside the unit marked ">>"');
    expect(prompts[2]).toContain("This unit's reservation, the only resources its weeks may use:");
    expect(calls.map((c) => c.label)).toEqual(["Top level · 8 weeks in 3 blocks", "Weeks 1–2 · 2 weeks", "Weeks 3–5 · 3 weeks", "Weeks 6–8 · 3 weeks"]);

    const root = events.find((e) => e.type === "node") && events.at(-1);
    if (root?.type !== "finish") throw new Error("no finish");
    const nodes = events.filter((e) => e.type === "node");
    expect(nodes.map((e) => e.parentId)).toEqual(Array(8).fill(root.root.id));
    expect(nodes.map((e) => e.node.title)).toEqual(["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"]);
    const weeks = root.root.children!;
    expect(weeks.map((w) => [w.level, w.title, w.start, w.end, w.budgetHours, w.children])).toEqual(
      Array.from({ length: 8 }, (_, i) => ["week", `W${i + 1}`, i * 5 + 1, i * 5 + 5, 8, null]),
    );
    expect(weeks[0].materials).toEqual([expect.objectContaining({ id: "M1", chapter: 1, tier: "must" })]);
    expect(weeks.some((w) => w.covers || w.time)).toBe(false);
  });

  it("puts the plan's checks on the root by week, as one call's would be", async () => {
    mockedStreamObject
      .mockReturnValueOnce(fakeStream([{ title: "A", summary: "s" }, { title: "B", summary: "s" }]))
      .mockReturnValueOnce(fakeStream(weekRows(1, 3)))
      .mockReturnValueOnce(fakeStream(weekRows(4, 3, (n) => (n === 5 ? { materials: [1, 2, 3, 4, 5, 6].map((c) => ({ id: `M1.${c}`, tier: "must" as const, minutes: 100 })) } : {}))));
    let finish: PlanDraftEvent | undefined;
    for await (const event of streamPlanDraft({ topic: "Interviews", weeks: 6, daysPerWeek: 5, granularity: "week", hoursPerWeek: 6, materials: [bookOfSix()], split: SPLIT })) finish = event;
    if (finish?.type !== "finish") throw new Error("no finish");
    expect(finish.root.problems).toContain("Week 5 plans 10 h in a week of 6 h.");
    expect(finish.root.problems!.some((p) => p.includes("Month"))).toBe(false);
  });

  it("stops the other blocks and fails the draft when one block's call fails", async () => {
    let seen: AbortSignal | undefined;
    mockedStreamObject
      .mockReturnValueOnce(fakeStream([{ title: "A", summary: "s" }, { title: "B", summary: "s" }]))
      .mockImplementationOnce((options) => {
        seen = (options as { abortSignal?: AbortSignal }).abortSignal;
        return gatedStream(weekRows(1, 3), new Promise(() => {}));
      })
      .mockImplementationOnce((options) => {
        (options as { onError?: (e: { error: unknown }) => void }).onError?.({ error: new Error("overloaded") });
        return fakeStream([]);
      });
    await expect(async () => {
      for await (const event of streamPlanDraft({ topic: "Interviews", weeks: 6, daysPerWeek: 5, granularity: "week", materials: [], split: SPLIT })) void event;
    }).rejects.toThrow("overloaded");
    expect(seen?.aborted).toBe(true);
  });

  it("keeps one call for four weeks of week leaves, and blocks only week leaves", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekRows(1, 4)));
    for await (const event of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 5, granularity: "week", materials: [], split: SPLIT })) void event;
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    mockedStreamObject.mockReset();
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekRows(1, 8))).mockReturnValueOnce(fakeStream(weekRows(1, 5)));
    for await (const event of streamPlanDraft({ topic: "T", weeks: 8, daysPerWeek: 5, granularity: "day", materials: [], split: SPLIT })) void event;
    expect((mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt).toContain("Split the plan into 8 weeks");
  });
});

describe("item lists while drafting", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });
  const materials = [material("M1"), material("M2", { kind: "course", practice: LISTED_PROBLEMS })];
  const split = { readingShare: 50, practice: "problems", reason: "r", formats: [{ format: "problem-set" as const, share: 100, focus: "arrays", reason: "" }] };
  const ctx = { topic: "Interviews", weeks: 1, daysPerWeek: 5, granularity: "week" as const, materials, hoursPerWeek: 6, split };
  const row = (n: number) => ({ format: "problem-set" as const, id: "M2", task: PROBLEM_ITEMS[n - 1].title, done: "solved", minutes: 15, generated: false, itemFrom: n, itemTo: n });

  it("a week split by hand keeps each item as a one-item reservation", async () => {
    // A week leaf that did items 1–3 (easy, 15 min each) is split into three days.
    const tree = makeRoot([makeNode({ id: "w1", level: "week", title: "Arrays", summary: "s", len: 5, budgetHours: 6, practice: [row(1), row(2), row(3)] })]);
    const units: UnitDraft[] = [1, 2, 3].map((n) => ({ title: `D${n}`, summary: "s", practice: [{ format: "problem-set", id: `M2.${n}`, task: PROBLEM_ITEMS[n - 1].title, done: "solved", minutes: 30 }] }));
    mockedStreamObject.mockReturnValueOnce(fakeStream(units));
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree, nodeId: "w1", reason: "split", splitDays: 3, log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    const prompt = (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Reserved for this unit: M2 items 1–3; the items not yet done are below, one row each.");
    expect(prompt).toContain("  M2.2 242. Valid Anagram · Arrays & Hashing · easy · 15 min");
    // Each day keeps its item, timed by the item; nothing breaches, so there is no retry.
    expect(children.map((c) => c.practice)).toEqual([[row(1)], [row(2)], [row(3)]]);
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(calls[0].facts.filter((f) => f.startsWith("breach") || f.includes("not assigned"))).toEqual([]);
  });

  it("sizes the weeks' runs of a listed source in code: the model only says which weeks take it", async () => {
    // Three weeks, six hours, half practice: 3 h of Problems a week. The model puts M2 on weeks 1 and 2, the second with
    // a run past the list; week 3 takes none. The list's 495 min is cut at 247.5: item 12's middle falls on it, so
    // week 1 takes items 1–12 (260 min) and week 2 13–21 (235 min).
    const weeks: UnitDraft[] = [
      { title: "W1", summary: "s", practiceCovers: [{ format: "problem-set", id: "M2" }] },
      { title: "W2", summary: "s", practiceCovers: [{ format: "problem-set", id: "M2", from: 90, to: 200 }] },
      { title: "W3", summary: "s" },
    ];
    const days: UnitDraft[] = [1, 2, 3, 4, 5].map((n) => ({ title: `D${n}`, summary: "s" }));
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks)).mockReturnValueOnce(fakeStream(days));
    const calls: ModelCall[] = [];
    let root: PlanNode | null = null;
    for await (const e of streamPlanDraft({ ...ctx, weeks: 3, granularity: "day", log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") root = e.root;
    const prompt = (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("from item");
    const run = (from: number, to: number) => [{ format: "problem-set", id: "M2", note: null, itemFrom: from, itemTo: to }];
    expect(root!.children!.map((w) => w.practiceCovers)).toEqual([run(1, 12), run(13, 21), undefined]);
    // The weeks were drafted without time, which is reported, and their runs follow each week's share; the runs break no
    // rule, and the week's days are planned from items 1–12.
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    expect(calls[0].facts.filter((f) => f.startsWith("breach") || f.startsWith("dropped"))).toEqual(["W1", "W2", "W3"].map((_, i) => `breach: Week ${i + 1} has no time set for its activities.`));
    expect((mockedStreamObject.mock.calls[1][0] as { prompt: string }).prompt).toContain("Reserved for this unit: M2 items 1–12;");
  });

  it("reports a day's item outside its week's reservation and keeps it", async () => {
    const tree = makeRoot([makeNode({ id: "w1", level: "week", title: "Arrays", summary: "s", len: 5, budgetHours: 6, practice: [row(1), row(2)] })]);
    const units: UnitDraft[] = [
      { title: "D1", summary: "s", practice: [{ format: "problem-set", id: "M2.1", task: "Contains Duplicate", done: "solved", minutes: 15 }] },
      { title: "D2", summary: "s", practice: [{ format: "problem-set", id: "M2.9", task: "Longest Consecutive Sequence", done: "solved", minutes: 25 }, { format: "problem-set", id: "M2", task: "Arrays, problems 2–3", done: "solved", minutes: 30 }] },
    ];
    mockedStreamObject.mockReturnValueOnce(fakeStream(units));
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree, nodeId: "w1", reason: "split", splitDays: 2, log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(calls[0].facts).toContain('breach: Week 1 · Day 2 assigns Problems M2.9 "Longest Consecutive Sequence", which Week 1 did not reserve');
    expect(calls[0].facts).toContain("dropped unknown M2");
    expect(calls[0].facts.some((f) => f.startsWith("dropped Problems"))).toBe(false);
    expect(calls[0].facts).toContain("item 2 of M2 reserved by Week 1 but not assigned");
    expect(children[1].practice).toEqual([expect.objectContaining({ format: "problem-set", id: "M2", itemFrom: 9, itemTo: 9 })]);
  });
});

describe("the draft's time budget", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
    mockedGenerateObject.mockReset();
    respondAllocate();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const weekUnits = (n: number): UnitDraft[] => Array.from({ length: n }, (_, i) => ({ title: `W${i + 1}`, summary: "s" }));
  const dayUnits = (n: number): UnitDraft[] => Array.from({ length: n }, (_, i) => ({ title: `D${i + 1}`, summary: "s" }));
  const finishOf = (events: PlanDraftEvent[]) => {
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error("no finish");
    return finish;
  };

  it("gives the allocation and the outline the request's signal with the deadline, and one retry at most", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekUnits(4)));
    const signal = new AbortController().signal;
    for await (const e of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], signal, deadline: Date.now() + DRAFT_BUDGET_MS })) void e;
    const allocate = mockedGenerateObject.mock.calls[0][0] as { abortSignal?: AbortSignal; maxRetries?: number };
    expect(allocate.abortSignal).toBeInstanceOf(AbortSignal);
    expect(allocate.abortSignal).not.toBe(signal);
    expect(allocate.maxRetries).toBe(1);
    const outline = mockedStreamObject.mock.calls[0][0] as { abortSignal?: AbortSignal; maxRetries?: number };
    expect(outline.abortSignal).toBeInstanceOf(AbortSignal);
    expect(outline.maxRetries).toBe(1);
  });

  it("lets code allocate, with no call, when the outline needs what is left", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekUnits(4)));
    const events: PlanDraftEvent[] = [];
    for await (const e of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], deadline: Date.now() + OUTLINE_RESERVE_MS + 5_000 })) events.push(e);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "split")).toBe(true);
    expect(finishOf(events).root.children).toHaveLength(4);
  });

  it("keeps a level's breaching rows when little time is left, as at any other time", async () => {
    const all = AIE_MATERIALS.find((m) => m.id === "aie")!.toc!.chapters.map((_, i) => ({ id: `M1.${i + 1}`, tier: "must" as const, minutes: 100 }));
    mockedStreamObject.mockReturnValueOnce(fakeStream([{ title: "Everything", summary: "s", materials: all }]));
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    const split = { readingShare: 40, practice: "projects", reason: "r" };
    for await (const e of streamPlanDraft({ topic: "AI", weeks: 1, daysPerWeek: 7, granularity: "week", hoursPerWeek: 6, materials: AIE_MATERIALS, split, deadline: Date.now() + STEP_MIN_MS - 1_000, log: { onCall: (c) => void calls.push(c) } })) events.push(e);
    expect(calls[0].facts.some((f) => f.startsWith("breach:"))).toBe(true);
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    const root = finishOf(events).root;
    expect(root.children![0].materials).toHaveLength(all.length);
    expect(root.problems!.length).toBeGreaterThan(0);
  });

  it("leaves the first unit a heading when too little time is left to plan its children", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekUnits(4)));
    const events: PlanDraftEvent[] = [];
    for await (const e of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 5, granularity: "day", materials: [], split: SPLIT, deadline: Date.now() + STEP_MIN_MS - 1_000 })) events.push(e);
    expect(mockedStreamObject).toHaveBeenCalledTimes(1);
    expect(finishOf(events).root.children![0].children).toBeNull();
  });

  it("leaves the first unit a heading, its streamed children dropped, when they run past the deadline", async () => {
    const deadline = Date.now() + STEP_MIN_MS + 30_000;
    const clock = vi.spyOn(Date, "now");
    const late = {
      partialObjectStream: (async function* () {
        yield { units: dayUnits(2) };
        yield { units: dayUnits(3) };
        clock.mockReturnValue(deadline + 1);
        throw new DOMException("The operation timed out.", "TimeoutError");
      })(),
      object: new Promise(() => {}),
      usage: new Promise(() => {}),
      finishReason: new Promise(() => {}),
    } as unknown as ReturnType<typeof streamObject>;
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekUnits(4))).mockReturnValueOnce(late);
    const events: PlanDraftEvent[] = [];
    for await (const e of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 5, granularity: "day", materials: [], split: SPLIT, deadline })) events.push(e);
    expect(events.filter((e) => e.type === "node" && e.node.level === "day").length).toBeGreaterThan(0);
    const finish = finishOf(events);
    expect(finish.root.children).toHaveLength(4);
    expect(finish.root.children![0].children).toBeNull();
  });

  /** Every `AbortSignal.timeout` the draft makes, so a test can fire the deadline a call ran under. */
  function deadlineTimers(): AbortController[] {
    const timers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const timer = new AbortController();
      timers.push(timer);
      return timer.signal;
    });
    return timers;
  }

  /** A stream whose deadline fires as it starts: it fails with the deadline's own timeout. */
  function cutByDeadline(timers: AbortController[]) {
    return (opts: unknown) => {
      const timer = timers.find((t) => t.signal === (opts as { abortSignal?: AbortSignal }).abortSignal);
      if (!timer) throw new Error("the call did not run under the draft's deadline");
      timer.abort(new DOMException("The operation timed out.", "TimeoutError"));
      return failingStream(timer.signal.reason)(opts);
    };
  }

  it("reports no service failure for a level the draft's deadline cut off: the unit stays a heading", async () => {
    const timers = deadlineTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deadline = Date.now() + STEP_MIN_MS + 30_000;
    const clock = vi.spyOn(Date, "now");
    const cut = cutByDeadline(timers);
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekUnits(4))).mockImplementationOnce((opts: unknown) => {
      clock.mockReturnValue(deadline + 1);
      return cut(opts);
    });
    const services: ServiceEvent[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const e of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 5, granularity: "day", materials: [], split: SPLIT, deadline, log: { onService: (e) => void services.push(e) } })) events.push(e);
    expect(finishOf(events).root.children![0].children).toBeNull();
    expect(services).toEqual([]);
  });

  it("fails the draft as before when its children fail for another reason", async () => {
    const broken = {
      partialObjectStream: (async function* () {
        yield { units: dayUnits(1) };
        throw new Error("boom");
      })(),
      object: new Promise(() => {}),
      usage: new Promise(() => {}),
      finishReason: new Promise(() => {}),
    } as unknown as ReturnType<typeof streamObject>;
    mockedStreamObject.mockReturnValueOnce(fakeStream(weekUnits(4))).mockReturnValueOnce(broken);
    const run = async () => {
      for await (const e of streamPlanDraft({ topic: "Git", weeks: 4, daysPerWeek: 5, granularity: "day", materials: [], split: SPLIT, deadline: Date.now() + DRAFT_BUDGET_MS })) void e;
    };
    await expect(run()).rejects.toThrow("boom");
  });
});

describe("draftLevel's outline call", () => {
  beforeEach(() => {
    mockedStreamObject.mockReset();
  });
  const direct: ResolvedModel = { model: {} as never, id: "anthropic/claude-opus-5.5", keyOwner: "app" };
  const base = { topic: "Reading", weeks: 1, daysPerWeek: 1, granularity: "day" as const, hoursPerWeek: 1, outlineModel: direct };
  type Ctx = Parameters<typeof draftLevel>[0]["ctx"];
  const run = async (ctx: Ctx, units: UnitDraft[]) => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(units));
    const calls: ModelCall[] = [];
    let done: { units: UnitDraft[]; breaches: Breach[] } | null = null;
    for await (const e of draftLevel({ ctx, level: "day", spans: [1], log: { onCall: (c) => void calls.push(c) } })) if (e.type === "done") done = e;
    return { calls, done: done! };
  };

  it("runs the outline call at the effort the draft is given", async () => {
    const unit = { title: "D1", summary: "s" } as UnitDraft;
    expect((await run({ ...base, materials: [], effort: "low" }, [unit])).calls[0].effort).toBe("low");
    expect((await run({ ...base, materials: [] }, [unit])).calls[0].effort).toBe("high");
  });
  it("returns the model's own units and the typed breaches with the level", async () => {
    const chapters = Array.from({ length: 3 }, (_, i) => ({ n: i + 1, title: `Chapter ${i + 1}`, page: null, minutes: 100, sections: [] }));
    const book = material("M1", { kind: "book", minutes: 300, toc: { source: "catalogue", url: "u", printPages: false, end: null, chapters } });
    const unit = { title: "D1", summary: "s", materials: [{ id: "M1.1", tier: "must" as const, minutes: 999 }] } as UnitDraft;
    const { done } = await run({ ...base, materials: [book], split: { readingShare: 100, practice: "none", reason: "r" } }, [unit]);
    expect(done.units[0].materials![0].minutes).toBe(999);
    expect(done.breaches.map((b) => b.kind)).toContain("over-budget");
  });
  it("returns no breaches for a level without materials", async () => {
    const { done } = await run({ ...base, materials: [] }, [{ title: "D1", summary: "s" } as UnitDraft]);
    expect(done.breaches).toEqual([]);
    expect(done.units).toHaveLength(1);
  });
});

describe("a day draft against its parent's imported rows", () => {
  const aliases = aliasMaterials([{ id: "book" }]);
  const split = { readingShare: 50, practice: "recall", reason: "", formats: [{ format: "recall" as const, share: 100, focus: "terms", reason: "" }] };
  const parent = [{ format: "other" as const, id: null, note: null, task: "Merge or close the open branches in the repository", minutes: 100, imported: true }];
  const day = (task: string) => ({ title: "Day", summary: "s", practice: [{ format: "other", task, done: "Done", minutes: 100 }] }) as unknown as UnitDraft;
  const apply = (task: string) => {
    const node = makeNode({ level: "day", title: "Day", summary: "s", len: 1 });
    const out = applyUnitRefs(node, day(task), true, aliases, split, undefined, parent);
    return { node, out };
  };
  it("keeps a copy of a parent's imported other task as imported, exactly or by its first 24 characters", () => {
    for (const task of ["Merge or close the open branches in the repository", "Merge or close the open branches (day 1)"]) {
      const { node, out } = apply(task);
      expect(out.refused).toEqual([]);
      expect(node.practice).toMatchObject([{ format: "other", id: null, imported: true }]);
    }
  });
  it("still refuses a new other task that matches nothing", () => {
    const { node, out } = apply("Learn the guitar");
    expect(out.refused).toHaveLength(1);
    expect(node.practice).toBeUndefined();
  });
});
