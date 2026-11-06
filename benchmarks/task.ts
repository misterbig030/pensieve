/**
 * The tasks the benchmark runs, each behind one interface: how to load its fixtures, run a sample, grade it and show it
 * to the judge. `run.ts` reads only this, so a task is added here and not there.
 */
import type { Material } from "@/lib/schemas/material";
import { DRAFT_TOPICS } from "@/evals/draft/topics";
import { loadFixture, type AllocateFixture } from "./fixtures";
import { ALLOCATE_CRITERIA, codeResults as allocateCodeResults, renderAllocation, runAllocateSample, type AllocateCtx, type AllocateOutput } from "./tasks/allocate";
import { codeResults as outlineCodeResults, judgeCriteriaFor, OUTLINE_CRITERIA, renderOutline, runOutlineSample, type OutlineCtx, type OutlineOutput } from "./tasks/outline";
import { loadOutlineFixture, type OutlineFixture } from "./tasks/outlineFixtures";
import type { Contestant, Criterion, CriterionResult, JudgeCriterion, Role, Sample } from "./types";

export type TaskName = "allocate" | "outline";

export interface BenchTask<F extends { id: string }, O, C> {
  name: TaskName;
  /** Whose model the contestant changes. */
  role: Role;
  criteria: Criterion<O, C>[];
  loadFixture(id: string, root: string): F;
  ctxFor(fixture: F): C;
  runSample(fixture: F, contestant: Contestant): Promise<Pick<Sample<O>, "gate" | "output" | "calls" | "costUsd" | "estimatedCostUsd" | "ms">>;
  codeResults(output: O, ctx: C): CriterionResult[];
  /** The judge criteria that apply to this output: allocate, all of its judge criteria. */
  judgeCriteria(output: O, ctx: C): JudgeCriterion[];
  render(output: O, fixture: F): string;
  /** The tokens of the source run's call, for the estimate; null when it made none. */
  baseline(fixture: F): { inputTokens: number; outputTokens: number } | null;
  /** The routing group a fixture belongs to: outline, its call group; allocate has none. */
  groupOf?(fixture: F): string;
  /** The materials the fixture gives the model, whose rendered length stands in for the judged output's in the estimate. */
  materials(fixture: F): Material[];
  /** The judge calls one sample takes, one per dimension it is judged on, for the estimate. */
  judgeDimensions: number;
}

const ALLOCATE_JUDGE_CRITERIA = ALLOCATE_CRITERIA.filter((c): c is JudgeCriterion => c.grader === "judge");

const allocate: BenchTask<AllocateFixture, AllocateOutput, AllocateCtx> = {
  name: "allocate",
  role: "allocate",
  criteria: ALLOCATE_CRITERIA,
  loadFixture,
  ctxFor: (fixture) => ({ fixture, topic: DRAFT_TOPICS[fixture.topic] }),
  runSample: (fixture, contestant) => runAllocateSample(fixture, contestant),
  codeResults: allocateCodeResults,
  judgeCriteria: () => ALLOCATE_JUDGE_CRITERIA,
  render: (output, fixture) => renderAllocation(output, fixture.input),
  baseline: (fixture) => fixture.baseline,
  materials: (fixture) => fixture.input.materials,
  judgeDimensions: new Set(ALLOCATE_JUDGE_CRITERIA.map((c) => c.dimension)).size,
};

const outline: BenchTask<OutlineFixture, OutlineOutput, OutlineCtx> = {
  name: "outline",
  role: "outline",
  criteria: OUTLINE_CRITERIA,
  loadFixture: loadOutlineFixture,
  ctxFor: (fixture) => ({ fixture }),
  runSample: (fixture, contestant) => runOutlineSample(fixture, contestant),
  codeResults: outlineCodeResults,
  judgeCriteria: judgeCriteriaFor,
  render: renderOutline,
  baseline: (fixture) => fixture.baseline,
  groupOf: (fixture) => fixture.group,
  materials: (fixture) => fixture.materials,
  // A level is a leaf call or a heading call, so it is judged on that one dimension.
  judgeDimensions: 1,
};

export const TASKS: { allocate: BenchTask<AllocateFixture, AllocateOutput, AllocateCtx>; outline: BenchTask<OutlineFixture, OutlineOutput, OutlineCtx> } = { allocate, outline };
