import type { ModelCall } from "@/lib/ai/logged";
import type { AiModelId, ReasoningEffort } from "@/lib/ai/models";

/** The generation steps a contestant can be given a model for. */
export type Role = "allocate" | "outline" | "research";
export interface RoleModel {
  model: AiModelId;
  effort: ReasoningEffort;
}
/** A named assignment of models to roles; a role left out runs the app's default. */
export interface Contestant {
  name: string;
  roles: Partial<Record<Role, RoleModel>>;
}

/** What a criterion is about: which materials, how the plan is laid out, the practice, and the judged quality. */
export type Group = "materials" | "structure" | "practice" | "quality";

/** What every criterion has; `weight` is negative for a thing the plan must not do. */
export interface CriterionBase {
  id: string;
  group: Group;
  weight: number;
  text: string;
}
/** A criterion a function decides. `applies` leaves it out of the score when the fixture does not call for it. */
export interface CodeCriterion<O, C> extends CriterionBase {
  grader: "code";
  applies?: (ctx: C) => boolean;
  check: (output: O, ctx: C) => { met: boolean; evidence: string };
}
/** A criterion a judge model decides, scored under one quality dimension. */
export interface JudgeCriterion extends CriterionBase {
  grader: "judge";
  dimension: string;
}
export type Criterion<O, C> = CodeCriterion<O, C> | JudgeCriterion;

export interface CriterionResult {
  id: string;
  met: boolean;
  evidence: string;
  grader: "code" | "judge";
  /** The judge model, for a judge result. */
  judge?: AiModelId;
}

/** Whether a sample counts: it ran to the end, it failed, or the run itself was unusable and the sample is dropped. */
export type Gate = { status: "completed" } | { status: "failed"; reason: string } | { status: "void"; reason: string };

/** One contestant's output on one fixture in one epoch, with what it cost and how it scored. */
export interface Sample<O = unknown> {
  task: string;
  fixture: string;
  contestant: string;
  epoch: number;
  gate: Gate;
  output: O | null;
  calls: ModelCall[];
  costUsd: number;
  ms: number;
  /** Code results always; judge results once judged. */
  results: CriterionResult[];
  /** False when the cap stopped judging. */
  judged: boolean;
  /** Only on the second judge's samples. */
  secondJudge?: CriterionResult[];
}
