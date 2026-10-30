import { describe, expect, it } from "vitest";
import { codeOnlyScore, groupScores, sampleScore, type ScoredCriterion } from "./score";
import type { CriterionResult, Gate } from "./types";

const crit: ScoredCriterion[] = [
  { id: "a", group: "materials", weight: 5, text: "a", grader: "code" },
  { id: "b", group: "structure", weight: 3, text: "b", grader: "code" },
  { id: "c", group: "materials", weight: -5, text: "c", grader: "code" },
];

const result = (id: string, met: boolean, grader: "code" | "judge" = "code"): CriterionResult => ({ id, met, evidence: "", grader });
const met = (id: string) => result(id, true);
const unmet = (id: string) => result(id, false);
const sample = (gate: Gate, results: CriterionResult[]) => ({ gate, results });
const completed = (results: CriterionResult[]) => sample({ status: "completed" }, results);

describe("sampleScore", () => {
  it("is met weight over positive weight", () => {
    // a(+5) b(+3) c(−5); met a and c → (5 − 5) / 8
    expect(sampleScore(completed([met("a"), unmet("b"), met("c")]), crit)).toBe(0);
    expect(sampleScore(completed([met("a"), met("b"), unmet("c")]), crit)).toBe(1);
  });

  it("can go below zero", () => {
    expect(sampleScore(completed([unmet("a"), unmet("b"), met("c")]), crit)).toBe(-0.625);
  });

  it("scores a failed gate 0 and a void sample null", () => {
    expect(sampleScore(sample({ status: "failed", reason: "no plan" }, []), crit)).toBe(0);
    expect(sampleScore(sample({ status: "void", reason: "timeout" }, [met("a")]), crit)).toBeNull();
  });

  it("leaves out criteria that did not apply", () => {
    // no result for b: a met = 5 / 5
    expect(sampleScore(completed([met("a"), unmet("c")]), crit)).toBe(1);
  });

  it("is null when no positive weight is left to divide by", () => {
    expect(sampleScore(completed([met("c")]), crit)).toBeNull();
    expect(sampleScore(completed([]), crit)).toBeNull();
  });

  it("scores only the criteria the filter passes", () => {
    expect(sampleScore(completed([met("a"), unmet("b")]), crit, (c) => c.group === "structure")).toBe(0);
  });
});

describe("codeOnlyScore", () => {
  it("ignores judge results", () => {
    const criteria: ScoredCriterion[] = [
      { id: "a", group: "materials", weight: 2, text: "a", grader: "code" },
      { id: "j", group: "quality", weight: 2, text: "j", grader: "judge", dimension: "coverage" },
    ];
    const s = completed([met("a"), result("j", false, "judge")]);
    expect(sampleScore(s, criteria)).toBe(0.5);
    expect(codeOnlyScore(s, criteria)).toBe(1);
  });
});

describe("groupScores", () => {
  const criteria: ScoredCriterion[] = [
    { id: "m", group: "materials", weight: 2, text: "m", grader: "code" },
    { id: "s", group: "structure", weight: 1, text: "s", grader: "code" },
    { id: "q1", group: "quality", weight: 1, text: "q1", grader: "judge", dimension: "coverage" },
    { id: "q2", group: "quality", weight: 3, text: "q2", grader: "judge", dimension: "pacing" },
  ];

  it("scores groups and judge dimensions apart", () => {
    const s = completed([met("m"), unmet("s"), result("q1", true, "judge"), result("q2", false, "judge")]);
    expect(groupScores(s, criteria)).toEqual({
      materials: 1,
      structure: 0,
      practice: null,
      quality: 0.25,
      "quality.coverage": 1,
      "quality.pacing": 0,
    });
  });

  it("is null for a group or dimension with no results", () => {
    const scores = groupScores(completed([met("m")]), criteria);
    expect(scores.structure).toBeNull();
    expect(scores["quality.coverage"]).toBeNull();
  });
});
