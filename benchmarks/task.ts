/**
 * The tasks the benchmark runs, each behind one interface: how to load its fixtures, run a sample, grade it and show it
 * to the judge. `run.ts` reads only this, so a task is added here and not there.
 */
import { renderMaterials } from "@/lib/ai/planPrompt";
import { DRAFT_TOPICS } from "@/evals/draft/topics";
import { CHARS_PER_TOKEN } from "./budget";
import { loadFixture, type AllocateFixture } from "./fixtures";
import { ALLOCATE_CRITERIA, codeResults as allocateCodeResults, renderAllocation, runAllocateSample, type AllocateCtx, type AllocateOutput } from "./tasks/allocate";
import { JUDGE_INSTRUCTIONS } from "./judge";
import { codeResults as outlineCodeResults, judgeCriteriaFor, OUTLINE_CRITERIA, OUTLINE_JUDGE_INSTRUCTIONS, renderOutline, runOutlineSample, type OutlineCtx, type OutlineOutput } from "./tasks/outline";
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
  /** What the judge is told it grades, sent after the rendered output; the cache key hashes it. */
  judgeInstructions: string;
  render(output: O, fixture: F): string;
  /** The tokens of the source run's call, for the estimate; null when it made none. */
  baseline(fixture: F): { inputTokens: number; outputTokens: number } | null;
  /** The routing group a fixture belongs to: outline, its call group; allocate has none. */
  groupOf?(fixture: F): string;
  /** About how long the judge's view of one sample on this fixture is, in characters, for the estimate. */
  judgeViewChars(fixture: F): number;
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
  // Byte for byte the instructions allocate was judged on before tasks had their own, so its cached answers still apply.
  judgeInstructions: JUDGE_INSTRUCTIONS,
  render: (output, fixture) => renderAllocation(output, fixture.input),
  baseline: (fixture) => fixture.baseline,
  // The rendered materials stand in for the allocation, as the estimate has always taken them.
  judgeViewChars: (fixture) => renderMaterials(fixture.input.materials).length,
  judgeDimensions: new Set(ALLOCATE_JUDGE_CRITERIA.map((c) => c.dimension)).size,
};

/** A level with no units: the judge's view of it is everything but the level as written. */
const EMPTY_LEVEL: OutlineOutput = { nodes: [], units: [], breaches: [], problems: [] };

const outline: BenchTask<OutlineFixture, OutlineOutput, OutlineCtx> = {
  name: "outline",
  role: "outline",
  criteria: OUTLINE_CRITERIA,
  loadFixture: loadOutlineFixture,
  ctxFor: (fixture) => ({ fixture }),
  runSample: (fixture, contestant) => runOutlineSample(fixture, contestant),
  codeResults: outlineCodeResults,
  judgeCriteria: judgeCriteriaFor,
  judgeInstructions: OUTLINE_JUDGE_INSTRUCTIONS,
  render: renderOutline,
  baseline: (fixture) => fixture.baseline,
  groupOf: (fixture) => fixture.group,
  // The view around the level (request, materials, tree, set-aside, budgets), and the level at the baseline's length.
  judgeViewChars: (fixture) => renderOutline(EMPTY_LEVEL, fixture).length + fixture.baseline.outputTokens * CHARS_PER_TOKEN,
  // A level is a leaf call or a heading call, so it is judged on that one dimension.
  judgeDimensions: 1,
};

export const TASKS: { allocate: BenchTask<AllocateFixture, AllocateOutput, AllocateCtx>; outline: BenchTask<OutlineFixture, OutlineOutput, OutlineCtx> } = { allocate, outline };
