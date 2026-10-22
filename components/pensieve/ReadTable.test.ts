import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { budgetLine, byTier, chapterLabel, coverPracticeRows, partLabel, practiceRowsFor, readRowsFor, rowBrief } from "./ReadTable";

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

describe("practiceRowsFor", () => {
  const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
  it("keeps a source's row with its material and a generated row with none", () => {
    const rows = practiceRowsFor(
      [
        { format: "problem-set", id: "evals", task: "Problems 1-20", done: "checked against the solutions", minutes: 90, generated: false },
        { format: "design-exercise", id: null, task: "Design a rate limiter", done: "compared with the rubric", minutes: 50, generated: true },
      ],
      byId,
    );
    expect(rows.map((r) => [r.format, r.label, r.task, r.minutes, r.material?.id ?? null, r.generated])).toEqual([
      ["problem-set", "Problems", "Problems 1-20", 90, "evals", false],
      ["design-exercise", "Design", "Design a rate limiter", 50, null, true],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
  it("links a generated recall row to the reading it was made from", () => {
    const [row] = practiceRowsFor([{ format: "recall", id: "aie", task: "20 questions", done: "checked against the reading", minutes: 60, generated: true }], byId);
    expect(row.material?.id).toBe("aie");
    expect(row.generated).toBe(true);
  });
  it("drops a row whose source is not in the list, and reads nothing from no rows", () => {
    expect(practiceRowsFor([{ format: "lab", id: "gone", task: "Lab 1", done: "the check passes", minutes: 30, generated: false }], byId)).toEqual([]);
    expect(practiceRowsFor(undefined, byId)).toEqual([]);
  });
});

describe("coverPracticeRows", () => {
  const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
  it("shows a split week's kept reservations as rows without a done line, skipping covers that carry no task", () => {
    const rows = coverPracticeRows(
      [
        { format: "problem-set", id: "evals", note: null, task: "Problems 1-20", minutes: 90 },
        { format: "mock", id: null, note: null, task: "Mock interview", minutes: 45 },
        { format: "lab", id: "evals", note: "ch. 2" },
      ],
      byId,
    );
    expect(rows.map((r) => [r.task, r.minutes, r.done, r.generated])).toEqual([
      ["Problems 1-20", 90, "", false],
      ["Mock interview", 45, "", true],
    ]);
  });
});
