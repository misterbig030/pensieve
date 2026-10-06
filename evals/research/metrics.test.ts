import { describe, expect, it } from "vitest";
import type { ModelCall } from "@/lib/ai/logged";
import type { Material } from "@/lib/schemas/material";
import { backboneHit, checkCounts, decide, mustIncludeRecall, sizeMetrics, summarize, type RunMetrics } from "./metrics";

function material(title: string, extra: Partial<Material> = {}): Material {
  return { id: title, origin: "research", type: "link", kind: "docs", url: "https://x", title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, ...extra };
}

describe("label metrics", () => {
  const list = [material("AI Engineering: Building Applications with Foundation Models", { kind: "book", backbone: true, author: "Chip Huyen" }), material("Building effective agents")];
  it("scores the backbone by title and author", () => {
    expect(backboneHit(list, { title: "AI Engineering", author: "Chip Huyen" })).toBe(true);
    expect(backboneHit(list, { title: "AI Engineering", author: "Someone Else" })).toBe(false);
    expect(backboneHit([material("x")], { title: "AI Engineering", author: "Chip Huyen" })).toBe(false);
    expect(backboneHit(list, undefined)).toBeNull();
  });
  it("measures mustInclude recall", () => {
    expect(mustIncludeRecall(list, [{ title: "Building effective agents" }, { title: "Your AI Product Needs Evals" }])).toBe(0.5);
    expect(mustIncludeRecall(list, [])).toBeNull();
  });
});

describe("checkCounts", () => {
  it("counts the code checks' facts", () => {
    const call = (facts: string[]) => ({ facts }) as unknown as ModelCall;
    expect(
      checkCounts([
        call(["4 of 4 units", "dropped unknown M9, M12"]),
        call(["Week 2 over budget: 400 of 360 min", "backbone ch. 2 after ch. 3 (Week 2)", "backbone ch. 3, 4 not reserved"]),
      ]),
    ).toEqual({ unknownRefs: 2, overBudgetLeaves: 1, chapterRegressions: 1, unreservedChapters: 1, overShareLeaves: 0 });
    expect(checkCounts([call(["Day 1 must-reading over the plan's share: 45 of about 15 min"])]).overShareLeaves).toBe(1);
  });
});

describe("decide", () => {
  const run = (arm: "A" | "C", verifiedRate: number, backbone: boolean): RunMetrics => ({
    recordId: "r", arm, run: 1, verifiedRate, proposed: 10, verified: 5, backboneHit: backbone, mustIncludeRecall: null, recency: 0,
    notice: null, unknownRefs: 0, overBudgetLeaves: 0, chapterRegressions: 0, unreservedChapters: 0, overShareLeaves: 0,
    sizedHours: 36, totalHours: 72, measuredShare: 0.5, unsizedShare: 0, coverage: null, costUsd: 0, latencyMs: 0,
    toolCalls: { searches: 0, fetches: 0, steps: 0 }, stoppedBy: null,
  });
  it("keeps arm A when it is no worse on backbone and within 10 points on verified rate", () => {
    const runs = [run("A", 0.7, true), run("C", 0.78, true)];
    expect(decide(summarize("A", runs), summarize("C", runs)).keepA).toBe(true);
  });
  it("flags arm C winning", () => {
    const runs = [run("A", 0.5, false), run("C", 0.8, true)];
    const d = decide(summarize("A", runs), summarize("C", runs));
    expect(d.keepA).toBe(false);
    expect(d.reasons).toHaveLength(2);
  });
});

describe("sizeMetrics", () => {
  it("totals the sized hours and the share code measured", () => {
    const list = [material("a", { minutes: 1320, minutesBasis: "measured" }), material("b", { minutes: 300, minutesBasis: "estimated" }), material("c")];
    expect(sizeMetrics(list)).toEqual({ sizedHours: 27, measuredShare: 0.5, unsizedShare: 1 / 3 });
    expect(sizeMetrics([material("c")])).toEqual({ sizedHours: 0, measuredShare: null, unsizedShare: 1 });
  });
});
