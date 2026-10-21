import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";

// Only streamObject is faked; the error classes stay real so provider refusals are recognised.
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamObject: vi.fn() }));

import { streamObject } from "ai";
import { APICallError } from "@ai-sdk/provider";
import type { ModelCall } from "./logged";
import { streamExpandNode, streamPlanDraft } from "./planDraft";
import type { ResolvedModel } from "./resolve";
import type { PlanDraftEvent, PlanExpandEvent } from "@/lib/planChat";
import type { PlanNode } from "@/lib/planTree";
import { AIE_MATERIALS, aiePlan } from "@/lib/__fixtures__/aiEngineeringPlan";

const mockedStreamObject = vi.mocked(streamObject);

function fakeStream(units: UnitDraft[]) {
  return {
    partialObjectStream: (async function* () {
      for (let i = 1; i <= units.length; i++) yield { units: units.slice(0, i) };
    })(),
    object: Promise.resolve({ units }),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 }),
    finishReason: Promise.resolve("stop"),
  } as unknown as ReturnType<typeof streamObject>;
}

function material(id: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "docs", url: `https://example.com/${id}`, title: id, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, ...extra };
}

describe("streamPlanDraft with materials", () => {
  beforeEach(() => {
    // Braces matter: a returned mock would be called by the runner as a cleanup hook, with no arguments.
    mockedStreamObject.mockReset();
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

describe("streamPlanDraft and the time split", () => {
  beforeEach(() => {
    // Braces matter: a returned mock would be called by the runner as a cleanup hook, with no arguments.
    mockedStreamObject.mockReset();
  });

  function fakeTop(units: UnitDraft[], split: unknown) {
    const stream = fakeStream(units) as unknown as { object: Promise<unknown> };
    stream.object = Promise.resolve({ split, units });
    return stream as unknown as ReturnType<typeof streamObject>;
  }
  const weeks = (n: number): UnitDraft[] => Array.from({ length: n }, (_, i) => ({ title: `W${i + 1}`, summary: "s" }));

  it("takes the split from the top level, announces it, and budgets weeks from the learner's hours", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeTop(weeks(4), { readingShare: 84.6, practice: "writing summaries.", reason: "A knowledge topic." }));
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "The French Revolution", weeks: 4, daysPerWeek: 7, granularity: "week", hoursPerWeek: 10, materials: [], log: { onCall: (c) => void calls.push(c) } })) events.push(event);

    expect(events.find((e) => e.type === "split")).toEqual({ type: "split", split: { readingShare: 85, practice: "writing summaries", reason: "A knowledge topic." } });
    const finish = events.at(-1);
    expect(finish?.type === "finish" && finish.root.children!.map((n) => n.budgetHours)).toEqual([10, 10, 10, 10]);
    expect(calls[0].prompt).toContain('as "split"');
    expect(calls[0].facts).toContain("split 85% reading · writing summaries");
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
    expect(calls.length).toBe(mockedStreamObject.mock.calls.length);
    for (const c of calls) {
      expect(c.model).toBe("anthropic/claude-haiku-4.5");
      expect(c.keyOwner).toBe("user");
    }
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

  it("drafts on without a split when the model returns none", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeTop(weeks(4), undefined));
    const calls: ModelCall[] = [];
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", materials: [], log: { onCall: (c) => void calls.push(c) } })) events.push(event);
    expect(events.some((e) => e.type === "split")).toBe(false);
    expect(events.at(-1)?.type).toBe("finish");
    expect(calls[0].facts).toContain("no split returned");
  });

  it("keeps a split it is given and does not ask for another", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks(4)));
    const calls: ModelCall[] = [];
    const split = { readingShare: 50, practice: "building", reason: "" };
    const events: PlanDraftEvent[] = [];
    for await (const event of streamPlanDraft({ topic: "T", weeks: 4, daysPerWeek: 7, granularity: "week", split, materials: [], log: { onCall: (c) => void calls.push(c) } })) events.push(event);
    expect(events.some((e) => e.type === "split")).toBe(false);
    expect(calls[0].prompt).not.toContain('as "split"');
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

  it("retries once, silently, when a level breaches, and keeps the corrected answer", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 1, 2, 2, 3, 3, 4]))).mockReturnValueOnce(fakeStream(dayUnits([1, 1, 1, 2, 2, 2, 2])));
    const calls: ModelCall[] = [];
    const events: PlanExpandEvent[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) events.push(e);
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "child")).toHaveLength(6); // the last unit arrives with done, and the retry streamed nothing
    const retryPrompt = (mockedStreamObject.mock.calls[1][0] as { prompt: string }).prompt;
    expect(retryPrompt).toContain("Your previous answer broke these rules; return all 7 units again, corrected:\n- ");
    expect(retryPrompt).toContain("- Week 1 · Day 5 reads M1.3, which Week 1 did not reserve");
    // Sized before the check, two 20-minute rows on a 107-minute chapter are 54 and 53 minutes against a 20-minute share.
    expect(retryPrompt).toContain("- Week 1 · Day 1's must-reading is 54 min against a budget of about 20 min");
    expect(calls.map((c) => c.label)).toEqual(["Week 1 · 7 days", "Week 1 · 7 days (retry)"]);
    expect(calls[0].facts).toContain("breach: Week 1 · Day 5 reads M1.3, which Week 2 holds");
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error("no finish");
    expect(finish.children.map((d) => d.materials![0].chapter)).toEqual([1, 1, 1, 2, 2, 2, 2]);
    expect(finish.children.map((d) => d.materials![0].minutes)).toEqual([36, 36, 35, 35, 35, 35, 35]); // sized from 107 and 140
  });
  it("a hand-split week's Read table is its reservation even when the client has not converted it", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3]))).mockReturnValueOnce(fakeStream(dayUnits([1, 2])));
    const calls: ModelCall[] = [];
    // The real client sends the tree before splitWeek runs: week 1 still carries `materials`.
    for await (const e of streamExpandNode({ ...ctx, tree: aiePlan(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) void e;
    const firstPrompt = (mockedStreamObject.mock.calls[0][0] as { prompt: string }).prompt;
    expect(firstPrompt).toContain("This unit's reservation, the only resources its days may use: M1.1–M1.2.");
    expect(calls[0].facts).toContain("breach: Week 1 · Day 2 reads M1.3, which Week 1 did not reserve");
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
  });
  it("sizes chapter rows from the list before judging the budget", async () => {
    const week = (title: string, ids: string[], minutes: number[]) => ({ title, summary: "s", materials: ids.map((id, i) => ({ id, tier: "must" as const, minutes: minutes[i] })) });
    // The model wrote flat 60-minute rows; the chapters are 107 and 140 minutes.
    const weeks = [week("W1", ["M1.1", "M1.2"], [60, 60]), week("W2", ["M1.3"], [60]), week("W3", ["M1.4"], [60]), week("W4", ["M1.5"], [60])];
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks)).mockReturnValueOnce(fakeStream(weeks));
    const calls: ModelCall[] = [];
    for await (const _ of streamPlanDraft({ ...ctx, weeks: 4, daysPerWeek: 7, granularity: "week", log: { onCall: (c) => void calls.push(c) } })) void _;
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    expect(calls[0].facts).toContain("breach: Week 1's must-reading is 247 min against a budget of about 144 min");
  });
  it("drops rows that still breach after the retry and records the drops", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3]))).mockReturnValueOnce(fakeStream(dayUnits([1, 3])));
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    expect(children[1].materials).toBeUndefined();
    expect(calls[1].facts).toEqual(expect.arrayContaining(["dropped M1.3 from Week 1 · Day 2: outside", "dropped M1.3 from Week 1 · Day 2: overlap"]));
  });
  it("an over-budget leaf triggers the retry and then stays a fact", async () => {
    const week = (title: string, ids: string[], minutes: number[]) => ({ title, summary: "s", materials: ids.map((id, i) => ({ id, tier: "must" as const, minutes: minutes[i] })) });
    const weeks = [week("W1", ["M1.1", "M1.2"], [107, 140]), week("W2", ["M1.3"], [93]), week("W3", ["M1.4"], [126]), week("W4", ["M1.5"], [98])];
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks)).mockReturnValueOnce(fakeStream(weeks));
    const calls: ModelCall[] = [];
    for await (const _ of streamPlanDraft({ ...ctx, weeks: 4, daysPerWeek: 7, granularity: "week", log: { onCall: (c) => void calls.push(c) } })) void _;
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    expect(calls[1].facts).toContain("breach: Week 1's must-reading is 247 min against a budget of about 144 min");
    expect(calls[1].facts.some((f) => f.startsWith("dropped"))).toBe(false);
  });
  it("splits a week into the number of days picked, each a share of that week", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 1, 2])));
    const calls: ModelCall[] = [];
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", splitDays: 3, log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    const prompt = mockedStreamObject.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Its 3 days cover, in order:");
    // Six hours over three days is two hours a day, 40% of it must-reading.
    expect(prompt).toContain("3. Day 3 — budget about 2 h, so about 50 min of must-reading");
    expect(prompt).not.toContain("4. Day 4");
    expect(children.map((c) => c.len)).toEqual([1, 1, 1]);
    expect(calls[0].facts).toContain("3 of 3 units");
  });
  it("a failed retry keeps the first answer with its drops on the app's key and rethrows a refusal on the user's", async () => {
    const refusal = new APICallError({ message: "credit balance is too low", url: "u", requestBodyValues: {}, statusCode: 400, responseBody: "", isRetryable: false });
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3]))).mockImplementationOnce(failingStream(refusal));
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split" })) if (e.type === "finish") children = e.children;
    expect(children).toHaveLength(2);
    expect(children[1].materials).toBeUndefined();
    mockedStreamObject.mockReset();
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3]))).mockImplementationOnce(failingStream(refusal));
    const outlineModel = { id: "anthropic/claude-sonnet-5-5", model: {}, keyOwner: "user" } as unknown as ResolvedModel;
    await expect(
      (async () => {
        for await (const _ of streamExpandNode({ ...ctx, outlineModel, tree: tree(), nodeId: "w1", reason: "split" })) void _;
      })(),
    ).rejects.toBe(refusal);
  });
});
