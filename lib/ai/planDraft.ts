import { streamObject } from "ai";
import type { z } from "zod";
import {
  aliasMaterials,
  levelChecks,
  noSourceFacts,
  pickedFormats,
  plainUnitText,
  resolveCoverRefs,
  resolveMaterialRefs,
  resolvePracticeCovers,
  resolvePracticeRefs,
  sizeChapterRows,
  sizeItemRuns,
  type Breach,
  type MaterialAliases,
} from "@/lib/materials";
import type { PlanDraftEvent, PlanDraftRequest, PlanExpandEvent, PlanExpandRequest } from "@/lib/planChat";
import {
  budgetFor,
  childLevel,
  childSpans,
  cloneTree,
  findNode,
  fullLabelOf,
  layout,
  makeNode,
  makeRoot,
  topLevelFor,
  topSpans,
  walk,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { PracticeFormat } from "@/lib/practice";
import type { Material } from "@/lib/schemas/material";
import { capProblems, MAX_UNIT_MINUTES, unitListSchema, type UnitDraft, type UnitTime, type unitTimeDraftSchema } from "@/lib/schemas/plan";
import { DEFAULT_HOURS_PER_WEEK, type PlanSplit } from "@/lib/studyTime";
import { buildGenerationLogRow, effortSettings, emitGenerationLog, type GenerationLogContext } from "./logged";
import { reportServiceFailure } from "./serviceEvents";
import { allocatePlan } from "./allocate";
import { DEFAULT_ALLOCATE_MODEL, DEFAULT_OUTLINE_MODEL, OUTLINE_EFFORT, type ReasoningEffort } from "./models";
import { appModel, type ResolvedModel } from "./resolve";
import { buildUnitsPrompt, type UnitsPromptInput } from "./planPrompt";
import type { ResearchArm } from "./research/agent";
import { researchMaterials, type ResearchMaterialsInput } from "./research/pipeline";

/**
 * The draft's time budget, inside the route's 300 s with room for the last events. Measured on 2026-10-24 (SDE, 8
 * weeks, Opus at high effort): research 59 s, the allocation 20 s, the weeks 36 s, the first week's days 47 s. A level
 * is called once (what breaks a rule is reported, not re-asked). Research runs first and takes what it takes; what is
 * left is shared out below.
 */
export const DRAFT_BUDGET_MS = 285_000;
/** The longest the allocation may run; past it, code allocates and the plan is all reading. */
export const ALLOCATE_TIMEOUT_MS = 90_000;
/** Kept back from the allocation for the top-level outline, which the draft cannot do without. */
export const OUTLINE_RESERVE_MS = 90_000;
/** The least time left to start the first unit's children; with less, the step is skipped. */
export const STEP_MIN_MS = 60_000;
/** Outline calls retry a failed request once at most: a second Opus attempt eats the time the next level needs. */
const OUTLINE_MAX_RETRIES = 1;
/**
 * The most top-level week leaves one call writes. Past it, the weeks are drafted in blocks (`weekLeafBlocks`): one call
 * reserves each block's share of the plan as headings, then each block's weeks are written at once, in parallel.
 * Measured on 2026-11-05 (MLE interview, 8 week leaves, Opus 5.5, one call): at high effort it reasoned 141 s (11k
 * tokens) before its first week, then wrote 10k tokens of Read tables and practice rows at about 14 s a week, 250 s in
 * all; at medium effort 63 s, then the same 113 s of writing. The draft had 195 s left after research and the allocation.
 */
export const LEAF_CALL_MAX_WEEKS = 4;
/** The most weeks one block's call writes, when the weeks are drafted in blocks. */
export const LEAF_BLOCK_WEEKS = 3;

/**
 * The blocks a top level of week leaves is drafted in, as weeks per block: one block (one call) up to
 * `LEAF_CALL_MAX_WEEKS`, past it as few blocks of at most `LEAF_BLOCK_WEEKS` as hold the weeks, the longer ones last.
 */
export function weekLeafBlocks(weeks: number): number[] {
  if (weeks <= LEAF_CALL_MAX_WEEKS) return [weeks];
  const count = Math.ceil(weeks / LEAF_BLOCK_WEEKS);
  const base = Math.floor(weeks / count);
  const extra = weeks % count;
  return Array.from({ length: count }, (_, i) => base + (i >= count - extra ? 1 : 0));
}

/** Milliseconds left before `deadline`; null when the draft has no deadline (tests, the eval, expanding a unit). */
function timeLeft(deadline: number | undefined): number | null {
  return deadline === undefined ? null : deadline - Date.now();
}

/** The request's signal, also aborting after `ms` when there is a deadline. */
function within(signal: AbortSignal | undefined, ms: number | null): AbortSignal | undefined {
  if (ms === null) return signal;
  const timeout = AbortSignal.timeout(Math.max(1, ms));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Whether units at `level` are leaves on a plan of this granularity (days always; weeks on week-granularity plans). */
export function unitsAreLeaves(level: PlanLevel, granularity: Granularity): boolean {
  return level === "day" || (level === "week" && granularity === "week");
}

/**
 * A heading's time as the model wrote it, as the node keeps it: practice by format, a format given twice summed. Formats
 * not in `picked` (the split's picks the units can be given) are left out and returned. Each activity is held to
 * `MAX_UNIT_MINUTES`, what a saved unit may keep, so a slip does not fail the plan's save; `timeOverLimit` tells it.
 */
export function toUnitTime(draft: z.infer<typeof unitTimeDraftSchema>, picked: readonly PracticeFormat[]): { time: UnitTime; unpicked: PracticeFormat[] } {
  const practice: UnitTime["practice"] = {};
  const unpicked: PracticeFormat[] = [];
  // A streamed unit is not validated yet: its practice may be missing until the level is in.
  for (const { format, minutes } of draft.practice ?? []) {
    if (!picked.includes(format)) {
      if (!unpicked.includes(format)) unpicked.push(format);
      continue;
    }
    practice[format] = Math.min(MAX_UNIT_MINUTES, (practice[format] ?? 0) + minutes);
  }
  return { time: { reading: Math.min(MAX_UNIT_MINUTES, draft.reading), practice }, unpicked };
}

/** Whether the model wrote more minutes for one of a heading's activities than a saved unit may keep (`toUnitTime` clamps them). */
export function timeOverLimit(draft: z.infer<typeof unitTimeDraftSchema>): boolean {
  const byFormat = new Map<PracticeFormat, number>();
  for (const { format, minutes } of draft.practice ?? []) byFormat.set(format, (byFormat.get(format) ?? 0) + minutes);
  return draft.reading > MAX_UNIT_MINUTES || [...byFormat.values()].some((m) => m > MAX_UNIT_MINUTES);
}

/** The admin fact for headings whose time was clamped: none when no unit's was. */
export function clampedTimeFacts(times: (z.infer<typeof unitTimeDraftSchema> | undefined)[]): string[] {
  const n = times.filter((t) => t && timeOverLimit(t)).length;
  return n > 0 ? [`clamped time to ${MAX_UNIT_MINUTES} min an activity on ${n} unit${n === 1 ? "" : "s"}`] : [];
}

/** Builds a node for a drafted unit: leaves get a time budget when they are week-sized. */
export function nodeFor(
  unit: UnitDraft,
  level: PlanLevel,
  len: number,
  granularity: Granularity,
  aliases?: MaterialAliases,
  hoursPerWeek?: number,
  split?: PlanSplit | null,
  picked?: readonly PracticeFormat[],
): PlanNode {
  const leaf = unitsAreLeaves(level, granularity);
  const node = makeNode({
    level,
    title: unit.title,
    summary: unit.summary,
    len,
    budgetHours: leaf && level !== "day" ? budgetFor(1, hoursPerWeek) : null,
    children: null,
  });
  if (aliases) applyUnitRefs(node, unit, leaf, aliases, split, picked);
  return node;
}

/**
 * Puts what the model wrote for references onto the node: leaves keep `materials` (their Read table) and `practice`
 * (their practice rows), headings keep `covers` and `practiceCovers` (their reservations; a listed source's without a
 * run, which `sizeItemRuns` sizes once the level is in) and `time` (the minutes the unit gives each activity, for the
 * formats in `picked`, the split's picks by default). Leaves never carry `time`. Returns the ids that are not in the
 * list, the practice rows the rules refuse and the formats a heading's time named that the split did not pick; all are
 * dropped.
 */
export function applyUnitRefs(
  node: PlanNode,
  unit: UnitDraft,
  leaf: boolean,
  aliases: MaterialAliases,
  split?: PlanSplit | null,
  picked: readonly PracticeFormat[] = pickedFormats(split),
): { unknown: string[]; refused: string[]; unpicked: PracticeFormat[] } {
  delete node.covers;
  delete node.materials;
  delete node.practice;
  delete node.practiceCovers;
  delete node.time;
  if (leaf) {
    const reading = resolveMaterialRefs(unit.materials, aliases);
    if (reading.refs.length > 0) node.materials = reading.refs;
    const practice = resolvePracticeRefs(unit.practice, aliases, split, reading.refs.map((r) => r.id));
    if (practice.refs.length > 0) node.practice = practice.refs;
    return { unknown: [...reading.unknown, ...practice.unknown], refused: practice.refused, unpicked: [] };
  }
  const reading = resolveCoverRefs(unit.covers, aliases);
  if (reading.refs.length > 0) node.covers = reading.refs;
  // A listed source's runs are sized in code once the level is in (`sizeItemRuns`): the model only chose the units.
  const practice = resolvePracticeCovers(unit.practiceCovers, aliases, split, { sized: true });
  if (practice.refs.length > 0) node.practiceCovers = practice.refs;
  // A heading the model gave no time stays without: the checks report it.
  const time = unit.time ? toUnitTime(unit.time, picked) : null;
  if (time) node.time = time.time;
  return { unknown: [...reading.unknown, ...practice.unknown], refused: [], unpicked: time?.unpicked ?? [] };
}

/**
 * When the model returns a different number of units than asked, re-derive spans so the count is honoured and every
 * unit stays whole weeks of the usual length: days are one day each, weeks the usual number of days, and months
 * share the asked weeks between them (at least a week each).
 */
export function reconcileSpans(spans: number[], count: number, level: PlanLevel, daysPerWeek: number): number[] {
  if (count === spans.length) return spans;
  if (level === "day") return Array.from({ length: count }, () => 1);
  if (level === "week") return Array.from({ length: count }, () => daysPerWeek);
  const weeks = Math.max(count, Math.round(spans.reduce((a, b) => a + b, 0) / daysPerWeek));
  const base = Math.floor(weeks / count);
  const extra = weeks % count;
  return Array.from({ length: count }, (_, i) => (base + (i >= count - extra ? 1 : 0)) * daysPerWeek);
}

interface StreamUnitsInput {
  prompt: string;
  /** For the admin panel: what this call plans ("Top level · 4 weeks"). */
  label: string;
  /** How many units the prompt asked for. */
  expected: number;
  /** Runs on the validated units before the call is reported; returns the checks to show beside the response. */
  check?: (units: UnitDraft[]) => string[];
  /** The model that drafts the units, and who pays for it. */
  model: ResolvedModel;
  /** The call's reasoning effort; `OUTLINE_EFFORT` when absent. */
  effort?: ReasoningEffort;
  /** Stops the call: the request going away, or the draft's deadline. */
  signal?: AbortSignal;
  log?: GenerationLogContext;
}

/** What an admin reading the raw response should know first: whether the count came back as asked. */
export function unitFacts(returned: number, expected: number): string[] {
  const count = `${returned} of ${expected} units`;
  return returned === expected ? [count, "spans kept"] : [count, "spans re-split"];
}

type UnitEvent = { type: "unit"; unit: UnitDraft } | { type: "done"; units: UnitDraft[]; costUsd: number };

/** Streams units as they fully arrive (the in-progress one is withheld), then the validated list with its cost. */
async function* streamUnits(input: StreamUnitsInput): AsyncGenerator<UnitEvent> {
  const startedAt = performance.now();
  // A failed stream is reported through onError and the partial stream just ends; result.object would then never
  // settle. Keep the failure and throw it once the loop is over, so a provider refusal reaches the caller.
  let failure: unknown;
  const result = streamObject({
    model: input.model.model,
    schema: unitListSchema,
    prompt: input.prompt,
    ...effortSettings(input.effort ?? OUTLINE_EFFORT, input.model.id),
    maxRetries: OUTLINE_MAX_RETRIES,
    ...(input.signal ? { abortSignal: input.signal } : {}),
    onError: ({ error }) => {
      failure = error;
    },
  });
  let sent = 0;
  for await (const partial of result.partialObjectStream) {
    const units = (partial.units ?? []).filter((u): u is Partial<UnitDraft> => u != null);
    const complete = units.length - 1;
    while (sent < complete) {
      const unit = units[sent];
      if (typeof unit.title !== "string" || typeof unit.summary !== "string") break;
      sent += 1;
      yield { type: "unit", unit: unit as UnitDraft };
    }
  }
  if (failure !== undefined) throw failure;
  const [object, usage, finishReason, providerMetadata] = await Promise.all([result.object, result.usage, result.finishReason, result.providerMetadata]);
  const row = buildGenerationLogRow({
    caller: "outline",
    model: input.model.id,
    effort: input.effort ?? OUTLINE_EFFORT,
    keyOwner: input.model.keyOwner,
    usage,
    providerMetadata,
    latencyMs: Math.round(performance.now() - startedAt),
    trackId: input.log?.trackId,
    userId: input.log?.userId,
  });
  await emitGenerationLog(input.log?.onLog, row);
  const checks = input.check?.(object.units) ?? [];
  input.log?.onCall?.({
    ...row,
    label: input.label,
    system: null,
    prompt: input.prompt,
    response: JSON.stringify(object, null, 2),
    finishReason: finishReason ?? null,
    facts: [...unitFacts(object.units.length, input.expected), ...checks],
  });
  yield { type: "done", units: object.units, costUsd: row.costUsd ?? 0 };
}

export interface DraftLevelInput {
  ctx: {
    topic: string;
    instructions?: string;
    materials: Material[];
    granularity: Granularity;
    weeks: number;
    daysPerWeek: number;
    hoursPerWeek?: number;
    split?: PlanSplit | null;
    outlineModel: ResolvedModel;
    /** The outline call's reasoning effort; `OUTLINE_EFFORT` when absent. */
    effort?: ReasoningEffort;
    /** The request's signal: a client that goes away stops the calls. */
    signal?: AbortSignal;
    /** When the draft must be done (epoch ms); absent, no budget. */
    deadline?: number;
  };
  level: PlanLevel;
  spans: number[];
  tree?: PlanNode;
  parentId?: string;
  /**
   * Top level only (no `parentId`): the plan's first units, done or started, kept as they are before the ones drafted
   * (a re-draft). The prompt lists them as fixed and gives the drafted units what is left of the plan; what they reserve
   * or do is taken; the checks see them in the tree, and hold the drafted units alone to stating their time. `spans`
   * covers only the rest of the plan. The drafted nodes come back without them.
   */
  keep?: PlanNode[];
  log?: GenerationLogContext;
  /** The signal the level's call runs under; the request's with the draft's deadline when omitted. */
  signal?: AbortSignal;
  /** What the admin panel calls the call; where it plans and how many units when omitted ("Top level · 4 weeks"). */
  label?: string;
}

/**
 * The level's final nodes placed in a copy of the tree, so checks can name them by label. At the top level, units kept
 * before them (`keep`) come first, copied too, as `kept`.
 */
function placeForChecks(tree: PlanNode | undefined, parentId: string | undefined, nodes: PlanNode[], keep: PlanNode[] = []): { root: PlanNode; placed: PlanNode[]; kept: PlanNode[] } {
  const copies = nodes.map((n) => cloneTree(n));
  if (!tree || !parentId) {
    const kept = keep.map((n) => cloneTree(n));
    const root = makeRoot([...kept, ...copies]);
    return { root, placed: copies, kept };
  }
  const root = cloneTree(tree);
  const parent = findNode(root, parentId);
  if (!parent) return { root, placed: [], kept: [] };
  parent.children = copies;
  layout(root);
  return { root, placed: copies, kept: [] };
}

/**
 * Drafts one level of units under `parentId` (or the top level) in one call, yielding each node as it lands. The level
 * is checked once and kept as written: what breaks a rule comes back as the learner's `problems`, never fixed in code.
 */
export async function* draftLevel(input: DraftLevelInput): AsyncGenerator<{ type: "node"; node: PlanNode } | { type: "done"; nodes: PlanNode[]; problems: string[]; costUsd: number; units: UnitDraft[]; breaches: Breach[] }> {
  const { ctx, level } = input;
  const leaf = unitsAreLeaves(level, ctx.granularity);
  const keep = input.parentId ? [] : (input.keep ?? []);
  // References are resolved when there are materials, or practice to assign (rows written without a source).
  const aliases = ctx.materials.length > 0 || (ctx.split?.formats ?? []).length > 0 ? aliasMaterials(ctx.materials) : undefined;
  const promptInput: UnitsPromptInput = {
    topic: ctx.topic,
    instructions: ctx.instructions,
    materials: ctx.materials,
    granularity: ctx.granularity,
    hoursPerWeek: ctx.hoursPerWeek,
    daysPerWeek: ctx.daysPerWeek,
    split: ctx.split,
    level,
    spans: input.spans,
    weeks: ctx.weeks,
    tree: input.tree,
    parentId: input.parentId,
    ...(keep.length > 0 ? { keep } : {}),
    unitsAreLeaves: leaf,
  };
  const parentNode = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  const where = input.tree && parentNode ? fullLabelOf(input.tree, parentNode) : "Top level";
  const n = input.spans.length;
  const label = input.label ?? `${where} · ${n} ${level}${n === 1 ? "" : "s"}`;
  const picked = pickedFormats(ctx.split, ctx.materials);
  const nodes: PlanNode[] = [];
  let final: PlanNode[] = [];
  let problems: string[] = [];
  let breaches: Breach[] = [];
  let units: UnitDraft[] = [];

  // Reconciles spans and references once the whole level has validated, sizes chapter rows and item runs, and states
  // the checks in code: the facts for the admin panel, the breaches as the learner's problems.
  const check = (units: UnitDraft[]): string[] => {
    const spans = reconcileSpans(input.spans, units.length, level, ctx.daysPerWeek);
    const unknown: string[] = [];
    const refused: string[] = [];
    const unpicked = new Set<PracticeFormat>();
    final = units.map((unit, i) => {
      const node = nodes[i] ?? nodeFor(unit, level, spans[i], ctx.granularity, undefined, ctx.hoursPerWeek);
      node.title = unit.title;
      node.summary = unit.summary;
      node.len = spans[i];
      node.end = node.start + node.len - 1;
      if (node.budgetHours !== null) node.budgetHours = budgetFor(1, ctx.hoursPerWeek);
      if (aliases) {
        const out = applyUnitRefs(node, unit, leaf, aliases, ctx.split, picked);
        unknown.push(...out.unknown);
        refused.push(...out.refused);
        for (const f of out.unpicked) unpicked.add(f);
      }
      return node;
    });
    if (!aliases) return [];
    const practiceFacts = [
      ...noSourceFacts(ctx.split, ctx.materials),
      ...(refused.length > 0 ? [`refused ${refused.join("; ")}`] : []),
      ...(unpicked.size > 0 ? [`dropped time for unpicked ${[...unpicked].join(", ")}`] : []),
      ...(leaf ? [] : clampedTimeFacts(units.map((u) => u.time))),
    ];
    // The checks run without materials too: a plan with no sources can still have practice written without one.
    // Chapter rows take their minutes from the list before the budget is judged, so the checks see real sizes.
    if (leaf) sizeChapterRows(final, ctx.materials);
    const { root, placed, kept } = placeForChecks(input.tree, input.parentId, final, keep);
    // Headings: each listed source's runs are sized by the units' time before the checks, which then hold by construction.
    const sizing = leaf ? [] : sizeItemRuns({ root, nodes: placed, materials: ctx.materials, split: ctx.split, hoursPerWeek: ctx.hoursPerWeek, daysPerWeek: ctx.daysPerWeek });
    if (!leaf) {
      placed.forEach((p, i) => {
        if (p.practiceCovers) final[i].practiceCovers = p.practiceCovers.map((c) => ({ ...c }));
        else delete final[i].practiceCovers;
      });
    }
    // Kept units are checked with the level, so the plan's totals count them; their rows were saved, and only the
    // drafted units are held to stating their time.
    const drafted = new Set(placed.map((n) => n.id));
    const keptIds = new Set<string>();
    for (const n of kept) walk(n, (d) => void keptIds.add(d.id));
    const checks = levelChecks({
      root,
      nodes: [...kept, ...placed],
      leaves: leaf,
      top: !input.parentId,
      materials: ctx.materials,
      unknownIds: unknown,
      hoursPerWeek: ctx.hoursPerWeek,
      daysPerWeek: ctx.daysPerWeek,
      split: ctx.split,
      drafted: kept.length > 0 ? (node) => drafted.has(node.id) : true,
      ...(kept.length > 0 ? { saved: (node: PlanNode) => keptIds.has(node.id) } : {}),
    });
    // A breach of a kept unit's own (its index among the kept, which come first) is the learner's to see nowhere: the unit
    // can't change, and it is measured against today's settings. It stays a fact for the admin panel. Plan-wide
    // breaches (index -1) count the kept units' time and stay problems.
    const fixed = (index: number) => index >= 0 && index < kept.length;
    breaches = checks.breaches;
    problems = capProblems(checks.problems.filter((_, i) => !fixed(checks.breaches[i].index)));
    const facts = [...checks.facts, ...sizing, ...practiceFacts, ...checks.breaches.map((b) => `${fixed(b.index) ? "kept unit" : "breach"}: ${b.text}`)];
    // After the checks, which read notes as written: ids the model copied from its prompt are put in words for the learner.
    const plain = final.reduce((sum, node) => sum + plainUnitText(node, ctx.materials, aliases), 0);
    if (plain > 0) facts.push(`ids put in words in ${plain} field${plain === 1 ? "" : "s"}`);
    return facts;
  };

  const prompt = buildUnitsPrompt(promptInput);
  let costUsd = 0;
  const signal = input.signal ?? within(ctx.signal, timeLeft(ctx.deadline));
  for await (const event of streamUnits({ prompt, label, expected: n, check, model: ctx.outlineModel, effort: ctx.effort, log: input.log, signal })) {
    if (event.type === "unit") {
      const len = input.spans[nodes.length] ?? (level === "day" ? 1 : input.spans[input.spans.length - 1]);
      const node = nodeFor(event.unit, level, len, ctx.granularity, aliases, ctx.hoursPerWeek, ctx.split, picked);
      if (aliases) plainUnitText(node, ctx.materials, aliases);
      nodes.push(node);
      yield { type: "node", node };
    } else {
      costUsd = event.costUsd;
      units = event.units;
    }
  }
  yield { type: "done", nodes: final, problems, costUsd, units, breaches };
}

/** Puts a level's problems on the node it was planned inside, within their limits; none leaves the node without `problems`. */
export function setProblems(node: PlanNode, problems: string[]): void {
  if (problems.length > 0) node.problems = capProblems(problems);
  else delete node.problems;
}

/**
 * Plans `first` down to the plan's finest units along its first branch: its children, then its first child's, while
 * the branch is still made of headings and the draft's time allows. Each planned parent keeps its level's problems.
 * Yields each node as it lands and returns the calls' cost. Past the deadline the unit being planned stays a heading.
 */
export async function* draftFirstBranch(
  ctx: DraftLevelInput["ctx"],
  root: PlanNode,
  first: PlanNode | undefined,
  log?: GenerationLogContext,
): AsyncGenerator<{ type: "node"; parentId: string; node: PlanNode }, number> {
  let costUsd = 0;
  let parent = first;
  while (parent && !unitsAreLeaves(parent.level, ctx.granularity)) {
    const left = timeLeft(ctx.deadline);
    if (left !== null && left < STEP_MIN_MS) break;
    const level = childLevel(parent.level)!;
    const spans = childSpans(parent, ctx.daysPerWeek);
    const kids: PlanNode[] = [];
    const signal = within(ctx.signal, left);
    try {
      for await (const event of draftLevel({ ctx, level, spans, tree: root, parentId: parent.id, log, signal })) {
        if (event.type === "node") {
          kids.push(event.node);
          parent.children = kids;
          layout(root);
          yield { type: "node", parentId: parent.id, node: event.node };
        } else {
          parent.children = event.nodes;
          setProblems(parent, event.problems);
          layout(root);
          costUsd += event.costUsd;
        }
      }
    } catch (error) {
      // Past the deadline the unit stays a heading, its streamed children dropped; any other failure is the draft's.
      if (ctx.signal?.aborted || ctx.deadline === undefined || Date.now() < ctx.deadline) throw error;
      // A level the draft's deadline cut off did not fail on Anthropic.
      reportServiceFailure(log, error, "outline level", signal);
      console.error(`[draft] out of time planning ${parent.title}; it stays a heading`, error);
      parent.children = null;
      layout(root);
      break;
    }
    parent = parent.children?.[0];
  }
  return costUsd;
}

/**
 * Drafts a top level of week leaves in blocks of weeks (`weekLeafBlocks`), so no one call writes them all: one call
 * plans the blocks as month headings, each reserving its share of the plan, then every block's weeks are written under
 * its reservation at once. The weeks come out at the top level, sent in order as they land (the first block's live, a
 * later block's once those before it are in); the headings are dropped. The joined weeks are checked against the plan,
 * as one call's would be, and their problems put on `root`. One block's failure stops the others and fails the draft.
 *
 * With `keep` (a re-draft), the plan's first weeks are fixed: the headings and every block are planned after them and
 * may not take what they hold, the root's children are the kept weeks then the drafted ones, and a kept week's own
 * breaches stay facts, as `draftLevel` keeps them. The drafted weeks come back without the kept ones.
 */
export async function* draftWeekBlocks(
  ctx: DraftLevelInput["ctx"],
  root: PlanNode,
  blocks: number[],
  log?: GenerationLogContext,
  keep: PlanNode[] = [],
): AsyncGenerator<{ type: "node"; parentId: string; node: PlanNode }, { nodes: PlanNode[]; problems: string[]; costUsd: number }> {
  let costUsd = 0;
  let heads: PlanNode[] = [];
  const total = blocks.reduce((sum, w) => sum + w, 0);
  const label = `Top level · ${total} weeks in ${blocks.length} blocks`;
  for await (const event of draftLevel({ ctx, level: "month", spans: blocks.map((w) => w * ctx.daysPerWeek), keep, log, label })) {
    if (event.type === "done") {
      heads = event.nodes;
      costUsd += event.costUsd;
    }
  }
  // The blocks are planned in a tree that holds the kept weeks first, so what those hold is taken.
  const tree = layout(makeRoot([...keep.map((n) => cloneTree(n)), ...heads]));

  const stop = new AbortController();
  const signal = within(ctx.signal ? AbortSignal.any([ctx.signal, stop.signal]) : stop.signal, timeLeft(ctx.deadline));
  type Block = { nodes: PlanNode[]; final: PlanNode[] | null };
  const states: Block[] = heads.map(() => ({ nodes: [], final: null }));
  let failure: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  let first = keep.length + 1;
  // Every block's call starts now, in order; the loop below sends their weeks in order.
  heads.forEach((head, i) => {
    const spans = childSpans(head, ctx.daysPerWeek);
    const last = first + spans.length - 1;
    const label = spans.length === 1 ? `Week ${first} · 1 week` : `Weeks ${first}–${last} · ${spans.length} weeks`;
    first = last + 1;
    void (async () => {
      try {
        for await (const event of draftLevel({ ctx, level: "week", spans, tree, parentId: head.id, log, signal, label })) {
          if (event.type === "node") states[i].nodes.push(event.node);
          else {
            states[i].final = event.nodes;
            costUsd += event.costUsd;
          }
          notify();
        }
      } catch (error) {
        failure ??= { error };
        stop.abort();
        notify();
      }
    })();
  });

  try {
    for (const state of states) {
      let sent = 0;
      for (;;) {
        if (failure) throw (failure as { error: unknown }).error;
        // A level's last unit comes only with the level: the block's weeks are its final list once it is in.
        const landed = state.final ?? state.nodes;
        while (sent < landed.length) yield { type: "node", parentId: root.id, node: landed[sent++] };
        if (state.final) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    }
  } finally {
    // A failed block, or a consumer that stopped reading, leaves no call running.
    stop.abort();
  }

  const weeks = states.flatMap((s) => s.final!);
  root.children = [...keep, ...weeks];
  layout(root);
  // As one call with kept units checks them (`draftLevel`): with the level, so the plan's totals count them, and only the
  // drafted weeks held to their time. A kept week's own breach can't be fixed and is no problem.
  const drafted = new Set(weeks.map((n) => n.id));
  const keptIds = new Set<string>();
  for (const n of keep) walk(n, (d) => void keptIds.add(d.id));
  const checks = levelChecks({
    root,
    nodes: [...keep, ...weeks],
    leaves: true,
    top: true,
    materials: ctx.materials,
    unknownIds: [],
    hoursPerWeek: ctx.hoursPerWeek,
    daysPerWeek: ctx.daysPerWeek,
    split: ctx.split,
    drafted: keep.length > 0 ? (node) => drafted.has(node.id) : true,
    ...(keep.length > 0 ? { saved: (node: PlanNode) => keptIds.has(node.id) } : {}),
  });
  const problems = capProblems(checks.problems.filter((_, i) => !(checks.breaches[i].index >= 0 && checks.breaches[i].index < keep.length)));
  setProblems(root, problems);
  return { nodes: weeks, problems, costUsd };
}

export interface StreamPlanDraftInput extends Omit<PlanDraftRequest, "materials"> {
  /** The materials list research produced (the learner's own included). */
  materials: Material[];
  /** The model that drafts units; the app's outline model when omitted (eval, tests). */
  outlineModel?: ResolvedModel;
  /** The model that allocates the plan's time after research; the app's allocate model when omitted (eval, tests). */
  allocateModel?: ResolvedModel;
  /** A request that goes away stops the allocation and the outline calls. */
  signal?: AbortSignal;
  /** When the draft must be done (epoch ms): the steps share what is left, and drop what does not fit. */
  deadline?: number;
  log?: GenerationLogContext;
}

/**
 * Drafts a new plan: the allocation (unless a split is given), then the top-level units, then the first unit's
 * children, then the first grandchild's children while the first branch is still made of headings. Later units stay
 * headings until the learner reaches them.
 */
export async function* streamPlanDraft(input: StreamPlanDraftInput): AsyncGenerator<PlanDraftEvent> {
  const topLevel = topLevelFor(input.weeks);
  const root = makeRoot([]);
  let costUsd = 0;

  const outlineModel = input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL);
  // A plan drafted against a given split keeps it and its materials. Otherwise the allocation runs now, with the
  // materials in hand: it cuts each to the part the plan uses, and the units below are drafted from those parts.
  let split = input.split ?? null;
  let materials = input.materials;
  if (!split) {
    const allocated = await allocatePlan({
      topic: input.topic,
      instructions: input.instructions,
      weeks: input.weeks,
      daysPerWeek: input.daysPerWeek,
      hoursPerWeek: input.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
      materials,
      model: input.allocateModel ?? appModel(DEFAULT_ALLOCATE_MODEL),
      log: input.log,
      signal: input.signal,
      // The allocation gets what the outline does not need, up to its own limit.
      ...(input.deadline !== undefined ? { timeoutMs: Math.min(ALLOCATE_TIMEOUT_MS, timeLeft(input.deadline)! - OUTLINE_RESERVE_MS) } : {}),
    });
    split = allocated.split;
    materials = allocated.materials;
    costUsd += allocated.costUsd;
    yield { type: "allocated", materials, dropped: allocated.dropped, coverage: allocated.coverage };
    yield { type: "split", split };
  }

  const tops: PlanNode[] = [];
  const ctx = { ...input, materials, split, outlineModel };
  // Many week leaves are too much writing for one call within the draft's time: they are drafted in blocks.
  const blocks = topLevel === "week" && unitsAreLeaves(topLevel, input.granularity) ? weekLeafBlocks(input.weeks) : [];
  if (blocks.length > 1) {
    costUsd += (yield* draftWeekBlocks(ctx, root, blocks, input.log)).costUsd;
    yield { type: "finish", root: layout(root), costUsd };
    return;
  }
  for await (const event of draftLevel({ ctx, level: topLevel, spans: topSpans(input.weeks, input.daysPerWeek), log: input.log })) {
    if (event.type === "node") {
      tops.push(event.node);
      root.children = tops;
      layout(root);
      yield { type: "node", parentId: root.id, node: event.node };
    } else {
      root.children = event.nodes;
      setProblems(root, event.problems);
      layout(root);
      costUsd += event.costUsd;
    }
  }

  // The first unit's children, while the draft's time allows: a unit left as a heading is planned when it is reached.
  costUsd += yield* draftFirstBranch(ctx, root, root.children?.[0], input.log);

  yield { type: "finish", root: layout(root), costUsd };
}

export interface StreamExpandNodeInput extends Omit<PlanExpandRequest, "tree"> {
  tree: PlanNode;
  /** The model that drafts the children; the app's outline model when omitted. */
  outlineModel?: ResolvedModel;
  /** A request that goes away stops the call. */
  signal?: AbortSignal;
  log?: GenerationLogContext;
}

/** Plans one heading (or splits one week leaf) into the level below it. */
export async function* streamExpandNode(input: StreamExpandNodeInput): AsyncGenerator<PlanExpandEvent> {
  const root = layout(cloneTree(input.tree));
  const node = findNode(root, input.nodeId);
  if (!node) throw new Error("Plan node not found");
  if (node.children) throw new Error("This unit is already planned in detail");
  const level = childLevel(node.level);
  if (!level) throw new Error("A day cannot be planned in more detail");
  // A week split by hand: its Read table and practice rows are the reservation its days are planned from, whatever the
  // client sent. Reading keeps its tier and minutes; practice keeps its task and minutes, and an item row becomes a
  // reservation of that one item.
  if (input.reason === "split" && node.materials) {
    node.covers = node.materials.map(({ id, note, chapter, activity, tier, minutes }) => ({ id, note, chapter, activity, tier, minutes }));
    delete node.materials;
    node.manualSplit = true;
  }
  if (input.reason === "split" && node.practice) {
    node.practiceCovers = node.practice.map(({ format, id, task, minutes, itemFrom, itemTo, imported }) => ({ format, id, note: null, task, minutes, ...(itemFrom && itemTo ? { itemFrom, itemTo } : {}), ...(imported ? { imported: true } : {}) }));
    delete node.practice;
    node.manualSplit = true;
  }
  // A week split into a number of days other than its own takes that length before its days are planned.
  if (input.reason === "split" && input.splitDays && input.splitDays !== node.len) {
    node.len = input.splitDays;
    layout(root);
  }
  const granularity: Granularity = input.reason === "split" ? "day" : input.granularity;
  const ctx = { ...input, granularity, outlineModel: input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL) };
  const spans = childSpans(node, input.daysPerWeek);
  const kids: PlanNode[] = [];
  for await (const event of draftLevel({ ctx, level, spans, tree: root, parentId: node.id, log: input.log })) {
    if (event.type === "node") {
      kids.push(event.node);
      yield { type: "child", node: event.node };
    } else {
      yield { type: "finish", children: event.nodes, problems: event.problems, costUsd: event.costUsd };
    }
  }
}

export interface StreamResearchedDraftInput extends PlanDraftRequest {
  /** The research arm; null when no search provider is configured. */
  arm: ResearchArm | null;
  /** The model that drafts units after research; the app's outline model when omitted. */
  outlineModel?: ResolvedModel;
  /** The model that allocates the plan's time after research; the app's allocate model when omitted. */
  allocateModel?: ResolvedModel;
  signal?: AbortSignal;
  /** When the draft must be done (epoch ms); research runs first, and the steps after it share what is left. */
  deadline?: number;
  log?: GenerationLogContext;
  /** Tests and the eval inject these; the app uses the defaults. */
  research?: Pick<ResearchMaterialsInput, "fetcher" | "books" | "caps" | "structure">;
}

/**
 * One request: the research events stream and end with the materials list, then the allocation divides the plan's time
 * over those materials (its `allocated` and `split` events come next), then the plan drafts against the allocated
 * parts. The finish event's cost includes research and the allocation.
 */
export async function* streamResearchedPlanDraft(input: StreamResearchedDraftInput): AsyncGenerator<PlanDraftEvent> {
  const outcome = yield* researchMaterials({
    brief: { topic: input.topic, instructions: input.instructions, weeks: input.weeks, daysPerWeek: input.daysPerWeek, hoursPerWeek: input.hoursPerWeek, sources: input.materials },
    arm: input.arm,
    signal: input.signal,
    deadline: input.deadline,
    log: input.log,
    ...input.research,
  });
  for await (const event of streamPlanDraft({ ...input, materials: outcome.materials })) {
    if (event.type === "finish") yield { ...event, costUsd: event.costUsd + outcome.costUsd };
    else yield event;
  }
}
