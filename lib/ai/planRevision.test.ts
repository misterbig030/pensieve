import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
import { generateObject } from "ai";
import { aliasMaterials } from "@/lib/materials";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { LISTED_PROBLEMS, PROBLEM_ITEMS } from "@/lib/__fixtures__/problemList";
import type { Material, PracticeCover, PracticeRef } from "@/lib/schemas/material";
import type { PlanNode } from "@/lib/planTree";
import type { ModelCall } from "./logged";
import { assignRefs } from "./planPrompt";
import { applyRevision, LockedNodeError, revisePlanTree, spanFor } from "./planRevision";
import { reconcileSpans } from "./planDraft";

const mockedGenerateObject = vi.mocked(generateObject);

function tree() {
  return layout(
    makeRoot([
      makeNode({
        id: "w1",
        level: "week",
        title: "Fundamentals",
        summary: "s1",
        len: 2,
        children: [
          makeNode({ id: "d1", level: "day", title: "Intro", summary: "a", len: 1, status: "completed" }),
          makeNode({ id: "d2", level: "day", title: "Metrics", summary: "b", len: 1, status: "generated" }),
        ],
      }),
      makeNode({ id: "w2", level: "week", title: "GPUs", summary: "s2", len: 7 }),
      makeNode({ id: "w3", level: "week", title: "Serving", summary: "s3", len: 7 }),
    ]),
  );
}

describe("applyRevision", () => {
  it("keeps ids and statuses for echoed refs and mints ids for new units", () => {
    const original = tree();
    const refs = assignRefs(original); // w1=n1 d1=n2 d2=n3 w2=n4 w3=n5
    const result = applyRevision(
      original,
      refs,
      {
        units: [
          { ref: "n1", title: "Fundamentals", summary: "s1", days: 2, children: [{ ref: "n2", title: "Intro", summary: "a", days: 1 }, { ref: "n3", title: "Metrics, revised", summary: "b2", days: 1 }] },
          { ref: "n5", title: "Serving", summary: "s3", days: 7 },
          { ref: "n4", title: "GPUs", summary: "s2", days: 7 },
          { title: "Mock rounds", summary: "s4", days: 7 },
        ],
      },
      0,
      "day",
    );
    expect(result.children!.map((c) => c.id)).toEqual(["w1", "w3", "w2", expect.stringMatching(/^tmp-/)]);
    expect(result.children![0].children![1].title).toBe("Metrics, revised");
    expect(result.children![0].children![1].status).toBe("generated");
    expect(result.children![0].children![0].status).toBe("completed");
    expect(result.len).toBe(23);
    expect(result.children![1].start).toBe(3);
    expect(result.children![3].level).toBe("week");
    expect(result.children![3].children).toBeNull();
  });

  it("restores locked nodes verbatim even if the model edited them", () => {
    const original = tree();
    const refs = assignRefs(original);
    const result = applyRevision(
      original,
      refs,
      {
        units: [
          { ref: "n1", title: "Fundamentals", summary: "s1", days: 2, children: [{ ref: "n2", title: "Intro CHANGED", summary: "x", days: 1 }, { ref: "n3", title: "Metrics", summary: "b", days: 1 }] },
          { ref: "n4", title: "GPUs", summary: "s2", days: 7 },
          { ref: "n5", title: "Serving", summary: "s3", days: 7 },
        ],
      },
      1,
      "day",
    );
    expect(result.children![0].children![0].title).toBe("Intro");
  });

  it("rejects a revision that drops a locked node", () => {
    const original = tree();
    const refs = assignRefs(original);
    expect(() =>
      applyRevision(
        original,
        refs,
        { units: [{ ref: "n1", title: "Fundamentals", summary: "s1", days: 1, children: [{ ref: "n3", title: "Metrics", summary: "b", days: 1 }] }, { ref: "n4", title: "GPUs", summary: "s2", days: 7 }] },
        1,
        "day",
      ),
    ).toThrow(LockedNodeError);
  });

  it("forces day units to one day and gives week leaves a week's budget on week plans", () => {
    const original = layout(makeRoot([makeNode({ id: "w1", level: "week", title: "A", summary: "a", len: 7, budgetHours: 6 })]));
    const refs = assignRefs(original);
    const result = applyRevision(
      original,
      refs,
      { units: [{ ref: "n1", title: "A", summary: "a", days: 7 }, { title: "B", summary: "b", days: 8 }, { title: "C", summary: "c", days: 3, children: [{ title: "C1", summary: "c1", days: 2 }] }] },
      0,
      "week",
      undefined,
      10,
    );
    expect(result.children![0].budgetHours).toBe(6);
    expect(result.children![1].budgetHours).toBe(10);
    expect(result.children![2].budgetHours).toBeNull();
    expect(result.children![2].children![0].len).toBe(1);
    expect(result.children![2].len).toBe(1);
  });

  it("gives a new week the usual number of days and a kept week its own, whatever the model wrote", () => {
    const original = layout(makeRoot([makeNode({ id: "w1", level: "week", title: "A", summary: "a", len: 3 }), makeNode({ id: "m1", level: "month", title: "M", summary: "m", len: 20 })]));
    const refs = assignRefs(original);
    const result = applyRevision(
      original,
      refs,
      { units: [{ ref: "n1", title: "A", summary: "a", days: 7 }, { title: "B", summary: "b", days: 7 }] },
      0,
      "day",
      undefined,
      6,
      5,
    );
    expect(result.children!.map((c) => c.len)).toEqual([3, 5]);
    expect(spanFor("month", 23, undefined, 5)).toBe(25);
    // A kept month the model left alone keeps its days, even a month saved before the setting; one it resized takes whole weeks.
    expect(spanFor("month", 20, original.children![1], 5)).toBe(20);
    expect(spanFor("month", 30, makeNode({ id: "old", level: "month", title: "M", summary: "m", len: 30 }), 7)).toBe(30);
    expect(spanFor("month", 10, original.children![1], 5)).toBe(10);
    expect(spanFor("month", 7, original.children![1], 5)).toBe(5);
    expect(spanFor("day", 4, undefined, 5)).toBe(1);
  });
});

describe("reconcileSpans", () => {
  it("keeps spans when the count matches", () => {
    expect(reconcileSpans([7, 7, 8, 8], 4, "week", 7)).toEqual([7, 7, 8, 8]);
  });
  it("gives every week the usual number of days when the model returned a different number of weeks", () => {
    expect(reconcileSpans([5, 5, 5, 5, 5, 5], 5, "week", 5)).toEqual([5, 5, 5, 5, 5]);
    expect(reconcileSpans([5, 5, 5, 5, 5, 5], 7, "week", 5)).toEqual([5, 5, 5, 5, 5, 5, 5]);
  });
  it("shares the asked weeks between a different number of months, in whole weeks", () => {
    // Twelve weeks at five days asked as three months; the model wrote two.
    expect(reconcileSpans([20, 20, 20], 2, "month", 5)).toEqual([30, 30]);
    expect(reconcileSpans([20, 20, 20], 7, "month", 5)).toEqual([5, 5, 10, 10, 10, 10, 10]);
    expect(reconcileSpans([20, 20, 20], 13, "month", 5).every((s) => s === 5)).toBe(true);
  });
  it("honours the count for days", () => {
    expect(reconcileSpans([1, 1, 1, 1, 1, 1, 1], 6, "day", 7)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("applyRevision with materials", () => {
  const toc = { source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: Array.from({ length: 4 }, (_, i) => ({ n: i + 1, title: `C${i + 1}`, page: null, minutes: null, sections: [] })) };
  const aliases = aliasMaterials([{ id: "uuid-book", toc }, { id: "uuid-talk" }]);
  function withRefs() {
    return layout(
      makeRoot([
        makeNode({ id: "d1", level: "day", title: "Intro", summary: "a", len: 1, materials: [{ id: "uuid-talk", tier: "must", minutes: 20, note: null }] }),
        makeNode({ id: "d2", level: "day", title: "Metrics", summary: "b", len: 1, materials: [{ id: "uuid-book", tier: "must", minutes: 40, note: "ch. 1" }] }),
      ]),
    );
  }

  it("edits an assignment without touching the others", () => {
    const original = withRefs();
    const refs = assignRefs(original);
    const result = applyRevision(
      original,
      refs,
      {
        units: [
          { ref: "n1", title: "Intro", summary: "a", days: 1, materials: [{ id: "M2", tier: "should", minutes: 20 }] },
          { ref: "n2", title: "Metrics", summary: "b", days: 1 },
        ],
      },
      0,
      "day",
      aliases,
    );
    expect(result.children![0].materials).toEqual([{ id: "uuid-talk", tier: "should", minutes: 20, note: null, chapter: null, activity: "read" }]);
    // Left out: the kept node keeps its references.
    expect(result.children![1].materials).toEqual([{ id: "uuid-book", tier: "must", minutes: 40, note: "ch. 1" }]);
  });

  it("keeps a split week's Read table when the model writes its covers back", () => {
    const original = layout(
      makeRoot([
        makeNode({
          id: "w1",
          level: "week",
          title: "Split",
          summary: "s",
          len: 2,
          manualSplit: true,
          covers: [
            { id: "uuid-book", note: null, chapter: 2, tier: "must", minutes: 140 },
            { id: "uuid-talk", note: null, tier: "should", minutes: 20 },
          ],
          children: [makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1 }), makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1 })],
        }),
        makeNode({ id: "w2", level: "week", title: "Later", summary: "l", len: 5, covers: [{ id: "uuid-book", note: null, chapter: 3 }] }),
      ]),
    );
    const result = applyRevision(
      original,
      assignRefs(original),
      {
        units: [
          // The model sees and writes only ids and notes; it rewrote the talk's note.
          { ref: "n1", title: "Split", summary: "s", days: 2, covers: [{ id: "M1.2" }, { id: "M2", note: "first half" }], children: [{ ref: "n2", title: "A", summary: "a", days: 1 }, { ref: "n3", title: "B, lighter", summary: "b", days: 1 }] },
          { ref: "n4", title: "Later", summary: "l", days: 5, covers: [{ id: "M1.3" }, { id: "M1.4" }] },
        ],
      },
      0,
      "day",
      aliases,
      6,
      5,
    );
    expect(result.children![0].covers!.map((r) => [r.id, r.chapter, r.note, r.tier, r.minutes])).toEqual([
      ["uuid-book", 2, null, "must", 140],
      ["uuid-talk", null, "first half", "should", 20],
    ]);
    // A heading's reservation stays a reservation: no tier for its rows, old or new.
    expect(result.children![1].covers!.every((r) => r.tier === undefined)).toBe(true);
  });

  it("drops unknown ids and keeps covers only on headings", () => {
    const original = withRefs();
    const result = applyRevision(
      original,
      assignRefs(original),
      {
        units: [
          { ref: "n1", title: "Intro", summary: "a", days: 1, materials: [{ id: "M7", tier: "must", minutes: 5 }], covers: [{ id: "M1" }] },
          { ref: "n2", title: "Metrics", summary: "b", days: 1 },
        ],
      },
      0,
      "day",
      aliases,
    );
    expect(result.children![0].materials).toBeUndefined();
    expect(result.children![0].covers).toBeUndefined();
  });

  it("resolves chapter ids on revised units", () => {
    const original = withRefs();
    const result = applyRevision(
      original,
      assignRefs(original),
      {
        units: [
          { ref: "n1", title: "Intro", summary: "a", days: 1, materials: [{ id: "M1.2", tier: "must", minutes: 40 }] },
          { ref: "n2", title: "Metrics", summary: "b", days: 1 },
        ],
      },
      0,
      "day",
      aliases,
    );
    expect(result.children![0].materials).toEqual([{ id: "uuid-book", tier: "must", minutes: 40, note: null, chapter: 2, activity: "read" }]);
  });
});

describe("applyRevision with practice", () => {
  const source = (format: "problem-set" | "lab") => ({ format, items: 150, perItemMinutes: 10, minutes: null, answers: true });
  // M1 is reading, M2 a problem list, M3 a lab.
  const aliases = aliasMaterials([{ id: "book" }, { id: "neet", practice: source("problem-set") }, { id: "git-lab", practice: source("lab") }]);
  const split = {
    readingShare: 50,
    practice: "problems and recall",
    reason: "",
    formats: [
      { format: "problem-set" as const, share: 60, focus: "arrays", reason: "" },
      { format: "recall" as const, share: 40, focus: "key terms", reason: "" },
    ],
  };
  const row = { format: "problem-set" as const, id: "neet", task: "Arrays 1-6", done: "All six solved", minutes: 40, generated: false };
  function withPractice() {
    return layout(
      makeRoot([
        makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, materials: [{ id: "book", tier: "must", minutes: 30, note: null }], practice: [row] }),
        makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1 }),
      ]),
    );
  }
  const revise = (original: ReturnType<typeof withPractice>, units: Parameters<typeof applyRevision>[2]["units"]) =>
    applyRevision(original, assignRefs(original), { units }, 0, "day", aliases, undefined, 7, split);

  it("keeps a leaf's practice when the model leaves it out", () => {
    const result = revise(withPractice(), [
      { ref: "n1", title: "A, renamed", summary: "a", days: 1 },
      { ref: "n2", title: "B", summary: "b", days: 1 },
    ]);
    expect(result.children![0].practice).toEqual([row]);
  });

  it("takes a rewritten practice list through the resolver: a generated recall row from the unit's reading, a refused row dropped", () => {
    const result = revise(withPractice(), [
      {
        ref: "n1",
        title: "A",
        summary: "a",
        days: 1,
        materials: [{ id: "M1", tier: "must", minutes: 30 }],
        practice: [
          { format: "problem-set", id: "M2", task: "Arrays 7-12", done: "Solved", minutes: 30 },
          { format: "recall", id: "M1", task: "Six questions on the chapter", done: "Answered from memory", minutes: 10 },
          { format: "lab", id: "M3", task: "Not a pick", done: "x", minutes: 20 },
          { format: "problem-set", id: "M9", task: "Unknown source", done: "x", minutes: 20 },
        ],
      },
      { ref: "n2", title: "B", summary: "b", days: 1 },
    ]);
    expect(result.children![0].practice).toEqual([
      { format: "problem-set", id: "neet", task: "Arrays 7-12", done: "Solved", minutes: 30, generated: false },
      { format: "recall", id: "book", task: "Six questions on the chapter", done: "Answered from memory", minutes: 10, generated: true },
    ]);
  });

  it("keeps a heading's practice reservations when the model leaves them out, and puts practice only on leaves", () => {
    const original = layout(
      makeRoot([
        makeNode({ id: "w1", level: "week", title: "W", summary: "w", len: 7, practiceCovers: [{ format: "problem-set", id: "neet", note: "Arrays" }] }),
      ]),
    );
    const result = revise(original, [
      { ref: "n1", title: "W", summary: "w", days: 7 },
    ]);
    expect(result.children![0].practiceCovers).toEqual([{ format: "problem-set", id: "neet", note: "Arrays" }]);
    const rewritten = revise(original, [
      { ref: "n1", title: "W", summary: "w", days: 7, practiceCovers: [{ format: "problem-set", id: "M2", note: "Trees" }, { format: "lab", id: "M3" }], practice: [{ format: "problem-set", id: "M2", task: "t", done: "d", minutes: 5 }] },
    ]);
    // The lab is no pick, so its reservation is dropped; a heading takes no practice rows.
    expect(rewritten.children![0].practiceCovers).toEqual([{ format: "problem-set", id: "neet", note: "Trees" }]);
    expect(rewritten.children![0].practice).toBeUndefined();
  });

  it("keeps a split week's reservation task and minutes when the model writes them back with ids only", () => {
    const original = layout(
      makeRoot([
        makeNode({
          id: "w1",
          level: "week",
          title: "Split",
          summary: "s",
          len: 2,
          manualSplit: true,
          practiceCovers: [
            { format: "problem-set", id: "neet", note: null, task: "Arrays 1-6", minutes: 40 },
          ],
          children: [makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1 }), makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1 })],
        }),
      ]),
    );
    const result = revise(original, [
      {
        ref: "n1",
        title: "Split",
        summary: "s",
        days: 2,
        practiceCovers: [{ format: "problem-set", id: "M2", note: "Arrays, harder" }],
        children: [{ ref: "n2", title: "A", summary: "a", days: 1 }, { ref: "n3", title: "B", summary: "b", days: 1 }],
      },
    ]);
    expect(result.children![0].practiceCovers).toEqual([{ format: "problem-set", id: "neet", note: "Arrays, harder", task: "Arrays 1-6", minutes: 40 }]);
  });

  it("keeps a split week's generated reservations when the model rewrites the list, which it cannot name them in", () => {
    const generated = { format: "problem-set" as const, id: null, note: null, task: "Six warm-up questions", minutes: 15 };
    const original = layout(
      makeRoot([
        makeNode({
          id: "w1",
          level: "week",
          title: "Split",
          summary: "s",
          len: 2,
          manualSplit: true,
          practiceCovers: [{ format: "problem-set", id: "neet", note: null, task: "Arrays 1-6", minutes: 40 }, generated],
          children: [makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1 }), makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1 })],
        }),
      ]),
    );
    const result = revise(original, [
      {
        ref: "n1",
        title: "Split, renamed",
        summary: "s",
        days: 2,
        practiceCovers: [{ format: "problem-set", id: "M2" }],
        children: [{ ref: "n2", title: "A", summary: "a", days: 1 }, { ref: "n3", title: "B", summary: "b", days: 1 }],
      },
    ]);
    expect(result.children![0].practiceCovers).toEqual([{ format: "problem-set", id: "neet", note: null, task: "Arrays 1-6", minutes: 40 }, generated]);
  });

  it("keeps a split week's generated recall reservation, which cites its reading, when the model writes it back by id", () => {
    const recall = { format: "recall" as const, id: "book", note: null, task: "Six questions on hashing", minutes: 15 };
    const original = layout(
      makeRoot([
        makeNode({
          id: "w1",
          level: "week",
          title: "Split",
          summary: "s",
          len: 2,
          manualSplit: true,
          practiceCovers: [{ format: "problem-set", id: "neet", note: null, task: "Arrays 1-6", minutes: 40 }, recall],
          children: [makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1 }), makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1 })],
        }),
      ]),
    );
    // The prompt asks the model to keep each row's format and source id, so it writes the recall row back as M1.
    const result = revise(original, [
      {
        ref: "n1",
        title: "Split",
        summary: "s",
        days: 2,
        practiceCovers: [{ format: "problem-set", id: "M2" }, { format: "recall", id: "M1" }],
        children: [{ ref: "n2", title: "A", summary: "a", days: 1 }, { ref: "n3", title: "B", summary: "b", days: 1 }],
      },
    ]);
    expect(result.children![0].practiceCovers).toEqual([{ format: "problem-set", id: "neet", note: null, task: "Arrays 1-6", minutes: 40 }, recall]);
  });
});

describe("revisePlanTree checks the whole tree", () => {
  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });

  it("keeps a plan saved before chapters: whole-book rows with chapter notes survive a rename", async () => {
    const legacy = layout(
      makeRoot([
        makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, materials: [{ id: "aie", tier: "must", minutes: 40, note: "Ch. 1 Introduction" }] }),
        makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1, materials: [{ id: "aie", tier: "must", minutes: 40, note: "Ch. 2 Understanding Foundation Models" }] }),
      ]),
    );
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        units: [
          { ref: "n1", title: "A", summary: "a", days: 1, materials: [{ id: "M1", tier: "must", minutes: 40, note: "Ch. 1 Introduction" }] },
          { ref: "n2", title: "B, renamed", summary: "b", days: 1, materials: [{ id: "M1", tier: "must", minutes: 40, note: "Ch. 2 Understanding Foundation Models" }] },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
      finishReason: "stop",
    } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const calls: ModelCall[] = [];
    const { tree } = await revisePlanTree({ topic: "t", materials: AIE_MATERIALS, granularity: "day", hoursPerWeek: 6, daysPerWeek: 7, tree: legacy, lockBefore: 0, changeRequest: "rename day 2", log: { onCall: (c) => void calls.push(c) } });
    expect(calls[0].facts.filter((f) => f.startsWith("dropped"))).toEqual([]);
    expect(tree.children!.map((d) => d.materials?.length)).toEqual([1, 1]);
  });

  it("drops a duplicated resource and a bare book id after one call, with facts", async () => {
    const two = layout(
      makeRoot([
        makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, materials: [{ id: "aie", tier: "must", minutes: 107, note: null, chapter: 1 }] }),
        makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1 }),
      ]),
    );
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        units: [
          { ref: "n1", title: "A", summary: "a", days: 1, materials: [{ id: "M1.1", tier: "must", minutes: 107 }, { id: "M2", tier: "should", minutes: 12 }] },
          { ref: "n2", title: "B", summary: "b", days: 1, materials: [{ id: "M2", tier: "should", minutes: 12 }, { id: "M1", tier: "should", minutes: 10 }, { id: "M3", tier: "should", minutes: 79 }] },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
      finishReason: "stop",
    } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const calls: ModelCall[] = [];
    const { tree } = await revisePlanTree({ topic: "t", materials: AIE_MATERIALS, granularity: "day", hoursPerWeek: 6, daysPerWeek: 7, tree: two, lockBefore: 0, changeRequest: "x", log: { onCall: (c) => void calls.push(c) } });
    expect(calls).toHaveLength(1);
    expect(calls[0].facts).toEqual(
      expect.arrayContaining(["breach: Day 2 reads M2, which Day 1 holds", "breach: Day 2 refers to M1 as a whole; use its chapters", "dropped M2 from Day 2: overlap", "dropped M1 from Day 2: whole-book"]),
    );
    expect(tree.children![1].materials).toEqual([{ id: "evals", tier: "should", minutes: 79, note: null, chapter: null, activity: "read" }]);
  });
});

describe("applyRevision with an item list", () => {
  const aliases = aliasMaterials([{ id: "book" }, { id: "neet", practice: LISTED_PROBLEMS }]);
  const split = { readingShare: 50, practice: "problems", reason: "", formats: [{ format: "problem-set" as const, share: 100, focus: "arrays", reason: "" }] };
  // Saved before item lists: a row naming the source without an item. And one item row.
  const old = { format: "problem-set" as const, id: "neet", task: "Arrays 1-3", done: "Solved", minutes: 45, generated: false };
  const anagram = { format: "problem-set" as const, id: "neet", task: "Group Anagrams", done: "Solved", minutes: 25, generated: false, itemFrom: 4, itemTo: 4 };

  it("keeps a saved row without an item when the model writes it back, and an item row by its alias", () => {
    const original = layout(makeRoot([makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, practice: [old, anagram] })]));
    const result = applyRevision(
      original,
      assignRefs(original),
      {
        units: [
          {
            ref: "n1",
            title: "A, renamed",
            summary: "a",
            days: 1,
            practice: [
              { format: "problem-set", id: "M2", task: "Arrays 1-3", done: "Solved", minutes: 45 },
              { format: "problem-set", id: "M2.4", task: "Group Anagrams", done: "Solved", minutes: 25 },
            ],
          },
        ],
      },
      0,
      "day",
      aliases,
      undefined,
      7,
      split,
    );
    expect(result.children![0].practice).toEqual([old, anagram]);
  });
});

describe("revisePlanTree holds rows it adds or changes to the drafting rules, and saved ones to facts", () => {
  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });
  const material = (id: string, extra: Partial<Material>): Material => ({ id, origin: "research", type: "link", kind: "course", url: `https://example.com/${id}`, title: id, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, ...extra });
  // M1 reading, M2 the 21-problem list (P), M3 a problem list without items (Q).
  const materials = [material("book", { kind: "book" }), material("P", { practice: LISTED_PROBLEMS }), material("Q", { practice: { format: "problem-set", items: 40, perItemMinutes: 10, minutes: null, answers: true } })];
  const split = { readingShare: 50, practice: "problems", reason: "", formats: [{ format: "problem-set" as const, share: 100, focus: "arrays", reason: "" }] };
  const item = (n: number, task = PROBLEM_ITEMS[n - 1].title): PracticeRef => ({ format: "problem-set", id: "P", task, done: "solved", minutes: 15, generated: false, itemFrom: n, itemTo: n });
  const old: PracticeRef = { format: "problem-set", id: "P", task: "Arrays 1-3", done: "solved", minutes: 45, generated: false };
  const run = (from: number, to: number): PracticeCover => ({ format: "problem-set", id: "P", note: null, itemFrom: from, itemTo: to });
  const day = (id: string, practice: PracticeRef[] = []) => makeNode({ id, level: "day", title: id, summary: "s", len: 1, practice });
  /**
   * Saved: week 1 reserves items 1–3, its days did item 1, an itemless row and item 3; week 2 reserves 3–6 and the
   * unlisted Q, its first day repeats item 3; week 3 reserves nothing. Refs: w1 n1, d1 n2, d2 n3, w2 n4, e1 n5, e2 n6, w3 n7, f1 n8.
   */
  const saved = () =>
    layout(
      makeRoot([
        makeNode({ id: "w1", level: "week", title: "W1", summary: "s", len: 2, practiceCovers: [run(1, 3)], children: [day("d1", [item(1)]), day("d2", [old, item(3)])] }),
        makeNode({ id: "w2", level: "week", title: "W2", summary: "s", len: 2, practiceCovers: [run(3, 6), { format: "problem-set", id: "Q", note: "Graphs" }], children: [day("e1", [item(3)]), day("e2")] }),
        makeNode({ id: "w3", level: "week", title: "W3", summary: "s", len: 1, children: [day("f1")] }),
      ]),
    );
  type Draft = { format: string; id?: string; task: string; done: string; minutes: number };
  const row = (id: string, task: string): Draft => ({ format: "problem-set", id, task, done: "solved", minutes: 15 });
  /** The model's answer: every unit echoed, with these practice lists on days e1, e2 and f1. */
  const answer = (e1: Draft[], e2: Draft[], f1: Draft[], d2: Draft[] = [row("M2", "Arrays 1-3"), row("M2.3", "Two Sum")]) => ({
    units: [
      { ref: "n1", title: "W1", summary: "s", days: 2, children: [{ ref: "n2", title: "d1", summary: "s", days: 1 }, { ref: "n3", title: "d2", summary: "s", days: 1, practice: d2 }] },
      { ref: "n4", title: "W2", summary: "s", days: 2, children: [{ ref: "n5", title: "e1", summary: "s", days: 1, practice: e1 }, { ref: "n6", title: "e2", summary: "s", days: 1, practice: e2 }] },
      { ref: "n7", title: "W3", summary: "s", days: 1, children: [{ ref: "n8", title: "f1", summary: "s", days: 1, practice: f1 }] },
    ],
  });
  const revise = async (object: unknown) => {
    mockedGenerateObject.mockResolvedValueOnce({ object, usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 }, finishReason: "stop" } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const calls: ModelCall[] = [];
    const { tree } = await revisePlanTree({ topic: "t", materials, granularity: "day", daysPerWeek: 5, split, tree: saved(), lockBefore: 0, changeRequest: "x", log: { onCall: (c) => void calls.push(c) } });
    const days = (tree.children ?? []).flatMap((w) => w.children ?? []);
    const practiceOf = (id: string) => days.find((d: PlanNode) => d.id === id)?.practice;
    return { facts: calls[0].facts, practiceOf };
  };

  it("drops an itemless row it adds, a repeated item and a source reserved elsewhere, and keeps saved rows with facts", async () => {
    const { facts, practiceOf } = await revise(
      answer([row("M2.3", "Two Sum")], [row("M2", "Queue problems"), row("M2.3", "Two Sum")], [row("M2.7", "Product of Array Except Self"), row("M3", "Graphs 1-3")]),
    );
    // (a) A new itemless row of a listed source is unknown: it never reaches the plan. (b) A new repeat of item 3 is dropped.
    expect(practiceOf("e2")).toBeUndefined();
    // (c) Week 3 reserved nothing, and both sources are reserved by other weeks: its new rows are dropped.
    expect(practiceOf("f1")).toBeUndefined();
    expect(facts).toEqual(
      expect.arrayContaining([
        'dropped Problems M2.3 "Two Sum" from Week 2 · Day 2: practice-overlap',
        'dropped Problems M2.7 "Product of Array Except Self" from Week 3 · Day 1: practice-outside',
        'dropped Problems "Graphs 1-3" from Week 3 · Day 1: practice-outside',
      ]),
    );
    // (d) The saved itemless row and the saved repeat stay, stated as facts only.
    // (The model wrote 15 min for the itemless row; minutes do not make a row new.)
    expect(practiceOf("d2")).toEqual([{ ...old, minutes: 15 }, item(3)]);
    expect(practiceOf("e1")).toEqual([item(3)]);
    expect(facts).toEqual(
      expect.arrayContaining(['Week 2 · Day 1 assigns Problems M2.3 "Two Sum", which Week 1 · Day 2 already assigns', 'Week 1 · Day 2 assigns Problems "Arrays 1-3" from M2 without an item']),
    );
    expect(facts.filter((f) => f.startsWith("dropped") && (f.includes("Week 1") || f.includes("Week 2 · Day 1")))).toEqual([]);
  });

  it("holds a saved row whose task the model edited to the drafting rules", async () => {
    const { facts, practiceOf } = await revise(answer([row("M2.3", "Two Sum, again")], [], []));
    // (e) Changed, so the repeat of item 3 is a breach and is dropped.
    expect(practiceOf("e1")).toBeUndefined();
    expect(facts).toContain('dropped Problems M2.3 "Two Sum, again" from Week 2 · Day 1: practice-overlap');
    // An itemless saved row the model rewrote with another task is new too, so it is unknown and goes.
    const edited = await revise(answer([row("M2.3", "Two Sum")], [], [], [row("M2", "Arrays 1-3 and Queue"), row("M2.3", "Two Sum")]));
    expect(edited.practiceOf("d2")).toEqual([item(3)]);
  });
});
