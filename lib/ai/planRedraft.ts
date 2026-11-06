import {
  childLevel,
  childSpans,
  cloneTree,
  findNode,
  isLocked,
  layout,
  MONTH_WEEKS,
  splitSpans,
  topLevelFor,
  topSpans,
  walk,
  weeksOf,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { capProblems } from "@/lib/schemas/plan";
import type { PlanSplit } from "@/lib/studyTime";
import type { GenerationLogContext } from "./logged";
import { DEFAULT_OUTLINE_MODEL } from "./models";
import { draftFirstBranch, draftLevel, draftWeekBlocks, setProblems, unitsAreLeaves, weekLeafBlocks, type DraftLevelInput } from "./planDraft";
import { describe, LockedNodeError } from "./planRevision";
import { appModel, type ResolvedModel } from "./resolve";

/** What a re-draft replaces: the whole open part of the plan, or one level (the top level, or a heading's children). */
export type RedraftScope = { kind: "plan" } | { kind: "level"; parentId: string | null };

export interface RedraftInput {
  topic: string;
  instructions?: string;
  materials: Material[];
  granularity: Granularity;
  /** The plan's whole length in weeks, the kept units' included. */
  weeks: number;
  daysPerWeek: number;
  hoursPerWeek?: number;
  split?: PlanSplit | null;
  tree: PlanNode;
  /** Days on or before this are behind the learner and locked. */
  lockBefore: number;
  scope: RedraftScope;
  /** The model that drafts the units; the app's outline model when omitted. */
  outlineModel?: ResolvedModel;
  log?: GenerationLogContext;
  signal?: AbortSignal;
  /** When the re-draft must be done (epoch ms): the first branch is planned only while there is time, as in a new draft. */
  deadline?: number;
}

/**
 * Nothing in the plan is left to re-draft: every unit is done or started, or the plan's weeks have shrunk to the units
 * kept. The message is the learner's.
 */
export class NothingToRedraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToRedraftError";
  }
}

export interface RedraftResult {
  tree: PlanNode;
  /** Every level this call drafted, its problems in order: the top level's (or the heading's) first. */
  problems: string[];
  costUsd: number;
}

/**
 * Whether a unit is done or started: completed, starting on or before the last locked day (a locked unit does too), or
 * holding a completed unit.
 */
function isStarted(unit: PlanNode, lockBefore: number): boolean {
  let started = unit.status === "completed" || (lockBefore > 0 && unit.start <= lockBefore);
  walk(unit, (n) => {
    if (n.status === "completed") started = true;
  });
  return started;
}

/**
 * The spans of the top-level units after the kept ones, to the plan's end: days one each, weeks the usual number of
 * days, months the rest of the weeks split as a new plan's are.
 */
function restSpans(root: PlanNode, keep: PlanNode[], level: PlanLevel, weeks: number, daysPerWeek: number): number[] {
  if (level === "day") return topSpans(weeks, daysPerWeek).slice(keep.length);
  const left = Math.round(weeks - keep.reduce((sum, unit) => sum + weeksOf(root, unit, daysPerWeek), 0));
  if (left <= 0) return [];
  if (level === "week") return Array.from({ length: left }, () => daysPerWeek);
  return splitSpans(left, MONTH_WEEKS).map((w) => w * daysPerWeek);
}

/** Runs one level's call to its end; the streamed nodes are not needed, only the level as checked. */
async function draftWhole(input: DraftLevelInput): Promise<{ nodes: PlanNode[]; problems: string[]; costUsd: number }> {
  for await (const event of draftLevel(input)) if (event.type === "done") return event;
  throw new Error("The outline ended without its units");
}

/** Runs the blocks of a re-draft's week leaves to their end, as `draftWhole` runs one call. */
async function draftBlocksWhole(ctx: DraftLevelInput["ctx"], root: PlanNode, blocks: number[], keep: PlanNode[], log?: GenerationLogContext) {
  const run = draftWeekBlocks(ctx, root, blocks, log, keep);
  let step = await run.next();
  while (!step.done) step = await run.next();
  return step.value;
}

/**
 * Re-drafts the open part of a plan through the outline, as a first draft is drafted: same prompt, sizing and checks,
 * and what breaks a rule comes back as problems on the node the level was planned inside. What the learner has done or
 * started stays as it is.
 *
 * - `plan`, or `level` at the top (`parentId: null`): the top-level units up to the last one done or started are kept
 *   unchanged (`keep`); the rest of the plan is re-drafted after them, in blocks when more than `LEAF_CALL_MAX_WEEKS`
 *   week leaves are left (`draftWeekBlocks`). `plan` then plans the first new unit's first branch, as a new plan's first
 *   unit is.
 * - `level` with a heading: the heading stays and its children are re-drafted. A completed or locked heading or child
 *   throws `LockedNodeError` before any call.
 */
export async function redraftPlan(input: RedraftInput): Promise<RedraftResult> {
  const root = layout(cloneTree(input.tree));
  const outlineModel = input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL);
  const ctx: DraftLevelInput["ctx"] = {
    topic: input.topic,
    instructions: input.instructions,
    materials: input.materials,
    granularity: input.granularity,
    weeks: input.weeks,
    daysPerWeek: input.daysPerWeek,
    hoursPerWeek: input.hoursPerWeek,
    split: input.split,
    outlineModel,
    signal: input.signal,
    deadline: input.deadline,
  };
  const { scope } = input;

  if (scope.kind === "level" && scope.parentId !== null) {
    const parent = findNode(root, scope.parentId);
    if (!parent || parent.id === root.id) throw new Error("Plan node not found");
    const level = childLevel(parent.level);
    if (!level || (unitsAreLeaves(parent.level, input.granularity) && !parent.children)) throw new Error(`${describe(root, parent)} has no level below it to re-draft`);
    walk(parent, (n) => {
      if (n.status === "completed" || isLocked(n, input.lockBefore)) throw new LockedNodeError(describe(root, n));
    });
    if (input.lockBefore > 0 && parent.start <= input.lockBefore) throw new LockedNodeError(describe(root, parent));
    // The old children go first, so the prompt and the checks do not count what they held as taken.
    parent.children = null;
    layout(root);
    const children = await draftWhole({ ctx, level, spans: childSpans(parent, input.daysPerWeek), tree: root, parentId: parent.id, log: input.log });
    parent.children = children.nodes;
    setProblems(parent, children.problems);
    layout(root);
    return { tree: root, problems: children.problems, costUsd: children.costUsd };
  }

  const tops = root.children ?? [];
  let last = -1;
  tops.forEach((unit, i) => {
    if (isStarted(unit, input.lockBefore)) last = i;
  });
  const keep = tops.slice(0, last + 1);
  const level = tops[0]?.level ?? topLevelFor(input.weeks);
  const spans = restSpans(root, keep, level, input.weeks, input.daysPerWeek);
  if (spans.length === 0 && keep.length === tops.length) throw new NothingToRedraftError("Every unit of the plan is done or started, so there is nothing left to re-draft.");
  if (spans.length === 0) throw new NothingToRedraftError("The plan is no longer than the units already done or started, so there is nothing left to re-draft. Make the plan longer to plan more.");
  root.children = keep;
  layout(root);
  // Many week leaves left are too much writing for one call within the re-draft's time: they are drafted in blocks after
  // the kept weeks, as a new draft's are.
  const blocks = level === "week" && unitsAreLeaves(level, input.granularity) ? weekLeafBlocks(spans.length) : [];
  const top = blocks.length > 1 ? await draftBlocksWhole(ctx, root, blocks, keep, input.log) : await draftWhole({ ctx, level, spans, keep, log: input.log });
  root.children = [...keep, ...top.nodes];
  setProblems(root, top.problems);
  layout(root);
  const problems = [...top.problems];
  let costUsd = top.costUsd;

  if (scope.kind === "plan") {
    const first = top.nodes[0];
    const branch = draftFirstBranch(ctx, root, first, input.log);
    let step = await branch.next();
    while (!step.done) step = await branch.next();
    costUsd += step.value;
    for (let p: PlanNode | undefined = first; p?.children; p = p.children[0]) problems.push(...(p.problems ?? []));
  }
  return { tree: layout(root), problems: capProblems(problems), costUsd };
}
