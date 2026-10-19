import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { byTier, chapterLabel, partLabel, readRowsFor } from "./ReadTable";

describe("readRowsFor", () => {
  it("fills chapter, activity and a key per row", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const rows = readRowsFor(
      [
        { id: "aie", tier: "must", minutes: 35, note: "Post-Training; Sampling", chapter: 2 },
        { id: "aie", tier: "should", minutes: 20, note: null, chapter: 1, activity: "review" },
        { id: "evals", tier: "should", minutes: 79, note: null },
      ],
      byId,
    );
    expect(rows.map((r) => [r.key, r.activity, r.chapter?.title ?? null])).toEqual([
      ["aie#2", "read", "Understanding Foundation Models"],
      ["aie#1", "review", "Introduction to Building AI Applications with Foundation Models"],
      ["evals#0", "read", null],
    ]);
    expect(chapterLabel(rows[0].chapter!)).toBe("Ch. 2 Understanding Foundation Models");
    expect(chapterLabel({ ...rows[0].chapter!, n: null })).toBe("Understanding Foundation Models");
  });
  it("names the part as a phrase: the chapter, or a review of it", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const [read, review, whole, wholeReview] = readRowsFor(
      [
        { id: "aie", tier: "must", minutes: 35, note: null, chapter: 2 },
        { id: "aie", tier: "should", minutes: 20, note: null, chapter: 2, activity: "review" },
        { id: "evals", tier: "should", minutes: 79, note: null },
        { id: "evals", tier: "should", minutes: 20, note: null, activity: "review" },
      ],
      byId,
    );
    expect(partLabel(read)).toBe("Ch. 2 Understanding Foundation Models");
    expect(partLabel(review)).toBe("Review of Ch. 2 Understanding Foundation Models");
    expect(partLabel(whole)).toBeNull();
    expect(partLabel(wholeReview)).toBe("Review");
  });
});

describe("row order", () => {
  it("shows must rows before should rows, keeping the plan's order within a tier", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const rows = readRowsFor(
      [
        { id: "aie", tier: "should", minutes: 50, note: null, chapter: 2, activity: "review" },
        { id: "aie", tier: "must", minutes: 93, note: null, chapter: 3 },
        { id: "evals", tier: "should", minutes: 79, note: null },
        { id: "oaievals", tier: "must", minutes: 25, note: null },
      ],
      byId,
    );
    expect(rows.map((r) => r.key)).toEqual(["aie#3", "oaievals#0", "aie#2", "evals#0"]);
    expect([{ tier: "should" as const }, { tier: "must" as const }].sort(byTier).map((r) => r.tier)).toEqual(["must", "should"]);
  });
});
