import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { budgetLine, byTier, chapterLabel, partLabel, readRowsFor, rowBrief } from "./ReadTable";

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

describe("rowBrief", () => {
  it("names the chapter by number and the sections after it; a whole resource by its title", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const [chapter, review, whole] = readRowsFor(
      [
        { id: "aie", tier: "must", minutes: 55, note: "The Rise of AI Engineering; Foundation Model Use Cases", chapter: 1 },
        { id: "aie", tier: "should", minutes: 20, note: "Modeling; Post-Training", chapter: 2, activity: "review" },
        { id: "evals", tier: "should", minutes: 79, note: "whole essay" },
      ],
      byId,
    );
    expect(rowBrief(chapter)).toEqual({ head: "Ch. 1", detail: "The Rise of AI Engineering; Foundation Model Use Cases" });
    expect(rowBrief(review)).toEqual({ head: "Review of ch. 2", detail: "Modeling; Post-Training" });
    expect(rowBrief(whole)).toEqual({ head: "AI Evals: Everything You Need to Know", detail: "whole essay" });
    expect(rowBrief({ ...chapter, chapter: { ...chapter.chapter!, n: null } })).toEqual({ head: "Introduction to Building AI Applications with Foundation Models", detail: "The Rise of AI Engineering; Foundation Model Use Cases" });
  });
});

describe("budgetLine", () => {
  it("gives reading, practice and the budget as one line", () => {
    expect(budgetLine({ readingMinutes: 191, practiceMinutes: 169, budgetMinutes: 360 })).toBe("3 h 11 reading · 2 h 49 practice · 6 h");
  });
  it("says reading against the budget when the unit has no practice rows", () => {
    expect(budgetLine({ readingMinutes: 191, practiceMinutes: 0, budgetMinutes: 360 })).toBe("3 h 11 of 6 h reading");
  });
});
