import type { CriterionBase, Group, Sample } from "./types";

/** What scoring needs of a criterion: the base fields plus who graded it and, for a judge, its dimension. */
export type ScoredCriterion = CriterionBase & { grader: "code" | "judge"; dimension?: string };

type Scored = Pick<Sample, "gate" | "results">;

const GROUPS: Group[] = ["materials", "structure", "practice", "quality"];

/**
 * The sample's score: the weight of the criteria met over the weight of the positive criteria, among those with a result
 * (and passing `filter`). A met criterion with a negative weight takes score away, so it can fall below 0. A failed gate
 * scores 0 and a void sample null, as does a score with no positive weight to divide by.
 */
export function sampleScore(
  sample: Scored,
  criteria: ScoredCriterion[],
  filter?: (criterion: ScoredCriterion) => boolean,
): number | null {
  if (sample.gate.status === "void") return null;
  if (sample.gate.status === "failed") return 0;
  const resultFor = new Map(sample.results.map((r) => [r.id, r]));
  let met = 0;
  let positive = 0;
  for (const criterion of criteria) {
    const result = resultFor.get(criterion.id);
    if (!result || (filter && !filter(criterion))) continue;
    if (criterion.weight > 0) positive += criterion.weight;
    if (result.met) met += criterion.weight;
  }
  return positive > 0 ? met / positive : null;
}

/** The score from the criteria a function decided, which does not depend on a judge. */
export function codeOnlyScore(sample: Scored, criteria: ScoredCriterion[]): number | null {
  return sampleScore(sample, criteria, (c) => c.grader === "code");
}

/** The score per group, and per judge dimension as `quality.<dimension>`; null where a group has no positive weight. */
export function groupScores(sample: Scored, criteria: ScoredCriterion[]): Record<string, number | null> {
  const scores: Record<string, number | null> = {};
  for (const group of GROUPS) scores[group] = sampleScore(sample, criteria, (c) => c.group === group);
  const dimensions = new Set<string>();
  for (const c of criteria) if (c.grader === "judge" && c.dimension) dimensions.add(c.dimension);
  for (const dimension of dimensions) {
    scores[`quality.${dimension}`] = sampleScore(sample, criteria, (c) => c.grader === "judge" && c.dimension === dimension);
  }
  return scores;
}
