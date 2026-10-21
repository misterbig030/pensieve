import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
import { generateObject } from "ai";
import { aliasMaterials } from "@/lib/materials";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
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
