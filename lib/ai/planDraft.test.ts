import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";

vi.mock("ai", () => ({ streamObject: vi.fn() }));

import { streamObject } from "ai";
import type { ModelCall } from "./logged";
import { streamPlanDraft } from "./planDraft";
import type { PlanDraftEvent } from "@/lib/planChat";

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
  beforeEach(() => mockedStreamObject.mockReset());

  it("puts covers on headings and the Read table on leaves, drops unknown ids, and reports the checks", async () => {
    mockedStreamObject
      .mockReturnValueOnce(
        fakeStream([
          { title: "Foundations", summary: "a", covers: [{ id: "M1", note: "ch. 1–2" }, { id: "M9" }] },
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
      days: 28,
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
    expect(w1.covers).toEqual([{ id: "M1", note: "ch. 1–2" }]);
    expect(w2.covers).toEqual([{ id: "M1", note: "ch. 5" }]);
    expect(w1.children![0].materials).toEqual([
      { id: "M1", tier: "must", minutes: 40, note: "ch. 1" },
      { id: "M2", tier: "should", minutes: 10, note: null },
    ]);
    expect(calls[0].facts).toEqual(expect.arrayContaining(["dropped unknown M9", "backbone ch. 3, 4 not reserved"]));
    expect(calls[1].facts).toEqual(expect.arrayContaining(["no must: Day 2, Day 3, Day 4, Day 5, Day 6, Day 7"]));
    // The prompt for the week's days carries the week's reservation.
    const secondPrompt = mockedStreamObject.mock.calls[1][0] as { prompt: string };
    expect(secondPrompt.prompt).toContain("reserved: M1 (ch. 1–2)");
  });
});
