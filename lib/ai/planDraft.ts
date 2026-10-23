import { streamObject } from "ai";
import {
  aliasMaterials,
  dropBreaches,
  levelChecks,
  noSourceFacts,
  resolveCoverRefs,
  resolveMaterialRefs,
  resolvePracticeCovers,
  resolvePracticeRefs,
  sizeChapterRows,
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
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { unitListSchema, type UnitDraft } from "@/lib/schemas/plan";
import { DEFAULT_HOURS_PER_WEEK, type PlanSplit } from "@/lib/studyTime";
import { buildGenerationLogRow, emitGenerationLog, type GenerationLogContext } from "./logged";
import { allocatePlan } from "./allocate";
import { DEFAULT_ALLOCATE_MODEL, DEFAULT_OUTLINE_MODEL } from "./models";
import { providerError } from "./providerError";
import { appModel, type ResolvedModel } from "./resolve";
import { buildUnitsPrompt, type UnitsPromptInput } from "./planPrompt";
import type { ResearchArm } from "./research/agent";
import { researchMaterials, type ResearchMaterialsInput } from "./research/pipeline";

/** Whether units at `level` are leaves on a plan of this granularity (days always; weeks on week-granularity plans). */
export function unitsAreLeaves(level: PlanLevel, granularity: Granularity): boolean {
  return level === "day" || (level === "week" && granularity === "week");
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
  if (aliases) applyUnitRefs(node, unit, leaf, aliases, split);
  return node;
}

/**
 * Puts what the model wrote for references onto the node: leaves keep `materials` (their Read table) and `practice`
 * (their practice rows), headings keep `covers` and `practiceCovers` (their reservations). Returns the ids that are not
 * in the list and the practice rows the rules refuse; both are dropped.
 */
export function applyUnitRefs(
  node: PlanNode,
  unit: UnitDraft,
  leaf: boolean,
  aliases: MaterialAliases,
  split?: PlanSplit | null,
): { unknown: string[]; refused: string[] } {
  delete node.covers;
  delete node.materials;
  delete node.practice;
  delete node.practiceCovers;
  if (leaf) {
    const reading = resolveMaterialRefs(unit.materials, aliases);
    if (reading.refs.length > 0) node.materials = reading.refs;
    const practice = resolvePracticeRefs(unit.practice, aliases, split, reading.refs.map((r) => r.id));
    if (practice.refs.length > 0) node.practice = practice.refs;
    return { unknown: [...reading.unknown, ...practice.unknown], refused: practice.refused };
  }
  const reading = resolveCoverRefs(unit.covers, aliases);
  if (reading.refs.length > 0) node.covers = reading.refs;
  const practice = resolvePracticeCovers(unit.practiceCovers, aliases, split);
  if (practice.refs.length > 0) node.practiceCovers = practice.refs;
  return { unknown: [...reading.unknown, ...practice.unknown], refused: [] };
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
  /** A retry: the units are not streamed, only the validated list is returned. */
  silent?: boolean;
  /** The model that drafts the units, and who pays for it. */
  model: ResolvedModel;
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
      if (!input.silent) yield { type: "unit", unit: unit as UnitDraft };
    }
  }
  if (failure !== undefined) throw failure;
  const [object, usage, finishReason] = await Promise.all([result.object, result.usage, result.finishReason]);
  const row = buildGenerationLogRow({
    caller: "outline",
    model: input.model.id,
    keyOwner: input.model.keyOwner,
    usage,
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
  yield { type: "done", units: object.units, costUsd: row.costUsd };
}

interface DraftLevelInput {
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
  };
  level: PlanLevel;
  spans: number[];
  tree?: PlanNode;
  parentId?: string;
  log?: GenerationLogContext;
}

/** The level's final nodes placed in a copy of the tree, so checks can name them by label. */
function placeForChecks(tree: PlanNode | undefined, parentId: string | undefined, nodes: PlanNode[]): { root: PlanNode; placed: PlanNode[] } {
  const copies = nodes.map((n) => cloneTree(n));
  if (!tree || !parentId) {
    const root = makeRoot(copies);
    return { root, placed: copies };
  }
  const root = cloneTree(tree);
  const parent = findNode(root, parentId);
  if (!parent) return { root, placed: [] };
  parent.children = copies;
  layout(root);
  return { root, placed: copies };
}

/** Drafts one level of units under `parentId` (or the top level), yielding each node as it lands. */
async function* draftLevel(input: DraftLevelInput): AsyncGenerator<{ type: "node"; node: PlanNode } | { type: "done"; nodes: PlanNode[]; costUsd: number }> {
  const { ctx, level } = input;
  const leaf = unitsAreLeaves(level, ctx.granularity);
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
    unitsAreLeaves: leaf,
  };
  const parentNode = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  const where = input.tree && parentNode ? fullLabelOf(input.tree, parentNode) : "Top level";
  const n = input.spans.length;
  const label = `${where} · ${n} ${level}${n === 1 ? "" : "s"}`;
  const nodes: PlanNode[] = [];
  let final: PlanNode[] = [];
  let breaches: Breach[] = [];
  let attempt = 1;

  // Reconciles spans and references once the whole level has validated, and states the checks in code. On the
  // retry, rows that still breach are dropped; on either attempt, chapter rows take their minutes from the list.
  const check = (units: UnitDraft[]): string[] => {
    const spans = reconcileSpans(input.spans, units.length, level, ctx.daysPerWeek);
    const unknown: string[] = [];
    const refused: string[] = [];
    final = units.map((unit, i) => {
      const node = nodes[i] ?? nodeFor(unit, level, spans[i], ctx.granularity, undefined, ctx.hoursPerWeek);
      node.title = unit.title;
      node.summary = unit.summary;
      node.len = spans[i];
      node.end = node.start + node.len - 1;
      if (node.budgetHours !== null) node.budgetHours = budgetFor(1, ctx.hoursPerWeek);
      if (aliases) {
        const out = applyUnitRefs(node, unit, leaf, aliases, ctx.split);
        unknown.push(...out.unknown);
        refused.push(...out.refused);
      }
      return node;
    });
    if (!aliases) return [];
    const practiceFacts = [...noSourceFacts(ctx.split, ctx.materials), ...(refused.length > 0 ? [`refused ${refused.join("; ")}`] : [])];
    // The checks run without materials too: a plan with no sources can still have practice written without one.
    // Chapter rows take their minutes from the list before the budget is judged, so the checks see real sizes.
    if (leaf) sizeChapterRows(final, ctx.materials);
    const { root, placed } = placeForChecks(input.tree, input.parentId, final);
    const checks = levelChecks({ root, nodes: placed, leaves: leaf, top: !input.parentId, materials: ctx.materials, unknownIds: unknown, hoursPerWeek: ctx.hoursPerWeek, daysPerWeek: ctx.daysPerWeek, split: ctx.split });
    breaches = checks.breaches;
    const facts = [...checks.facts, ...practiceFacts, ...breaches.map((b) => `breach: ${b.text}`)];
    if (attempt === 2) {
      // Rows that still breach are dropped, the drops recorded, and the surviving chapter rows resized.
      facts.push(...dropBreaches(final, breaches));
      if (leaf) sizeChapterRows(final, ctx.materials);
    }
    return facts;
  };

  const prompt = buildUnitsPrompt(promptInput);
  const base = { expected: n, check, model: ctx.outlineModel, log: input.log };
  let costUsd = 0;
  for await (const event of streamUnits({ ...base, prompt, label })) {
    if (event.type === "unit") {
      const len = input.spans[nodes.length] ?? (level === "day" ? 1 : input.spans[input.spans.length - 1]);
      const node = nodeFor(event.unit, level, len, ctx.granularity, aliases, ctx.hoursPerWeek, ctx.split);
      nodes.push(node);
      yield { type: "node", node };
    } else {
      costUsd = event.costUsd;
    }
  }

  // One retry with the breaches quoted, its units not streamed; the first answer stays on screen until it lands.
  if (breaches.length > 0) {
    attempt = 2;
    const corrections = [RETRY_HEADER(n), ...breaches.map((b) => `- ${b.text}`)].join("\n");
    try {
      for await (const event of streamUnits({ ...base, prompt: `${prompt}\n${corrections}`, label: `${label} (retry)`, silent: true })) {
        if (event.type === "done") {
          costUsd += event.costUsd;
        }
      }
    } catch (error) {
      // On the user's own key a provider refusal is theirs to hear about; otherwise the first answer stands, pruned.
      if (ctx.outlineModel.keyOwner === "user" && providerError(error)) throw error;
      console.error(`[draft] retry failed for ${label}`, error);
      dropBreaches(final, breaches);
      if (leaf) sizeChapterRows(final, ctx.materials);
    }
  }
  yield { type: "done", nodes: final, costUsd };
}

export const RETRY_HEADER = (n: number) => `Your previous answer broke these rules; return all ${n} units again, corrected:`;

export interface StreamPlanDraftInput extends Omit<PlanDraftRequest, "materials"> {
  /** The materials list research produced (the learner's own included). */
  materials: Material[];
  /** The model that drafts units; the app's outline model when omitted (eval, tests). */
  outlineModel?: ResolvedModel;
  /** The model that allocates the plan's time after research; the app's allocate model when omitted (eval, tests). */
  allocateModel?: ResolvedModel;
  /** A request that goes away stops the allocation. */
  signal?: AbortSignal;
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
    });
    split = allocated.split;
    materials = allocated.materials;
    costUsd += allocated.costUsd;
    yield { type: "allocated", materials, dropped: allocated.dropped, coverage: allocated.coverage };
    yield { type: "split", split };
  }

  const tops: PlanNode[] = [];
  const ctx = { ...input, materials, split, outlineModel };
  for await (const event of draftLevel({ ctx, level: topLevel, spans: topSpans(input.weeks, input.daysPerWeek), log: input.log })) {
    if (event.type === "node") {
      tops.push(event.node);
      root.children = tops;
      layout(root);
      yield { type: "node", parentId: root.id, node: event.node };
    } else {
      root.children = event.nodes;
      layout(root);
      costUsd += event.costUsd;
    }
  }

  let parent: PlanNode | undefined = root.children?.[0];
  while (parent && !unitsAreLeaves(parent.level, input.granularity)) {
    const level = childLevel(parent.level)!;
    const spans = childSpans(parent, input.daysPerWeek);
    const kids: PlanNode[] = [];
    for await (const event of draftLevel({ ctx, level, spans, tree: root, parentId: parent.id, log: input.log })) {
      if (event.type === "node") {
        kids.push(event.node);
        parent.children = kids;
        layout(root);
        yield { type: "node", parentId: parent.id, node: event.node };
      } else {
        parent.children = event.nodes;
        layout(root);
        costUsd += event.costUsd;
      }
    }
    parent = parent.children?.[0];
  }

  yield { type: "finish", root: layout(root), costUsd };
}

export interface StreamExpandNodeInput extends Omit<PlanExpandRequest, "tree"> {
  tree: PlanNode;
  /** The model that drafts the children; the app's outline model when omitted. */
  outlineModel?: ResolvedModel;
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
  // client sent. Reading keeps its tier and minutes; practice keeps its task and minutes.
  if (input.reason === "split" && node.materials) {
    node.covers = node.materials.map(({ id, note, chapter, activity, tier, minutes }) => ({ id, note, chapter, activity, tier, minutes }));
    delete node.materials;
    node.manualSplit = true;
  }
  if (input.reason === "split" && node.practice) {
    node.practiceCovers = node.practice.map(({ format, id, task, minutes }) => ({ format, id, note: null, task, minutes }));
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
      yield { type: "finish", children: event.nodes, costUsd: event.costUsd };
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
  log?: GenerationLogContext;
  /** Tests and the eval inject these; the app uses the defaults. */
  research?: Pick<ResearchMaterialsInput, "fetcher" | "books" | "caps" | "chapters">;
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
    log: input.log,
    ...input.research,
  });
  for await (const event of streamPlanDraft({ ...input, materials: outcome.materials })) {
    if (event.type === "finish") yield { ...event, costUsd: event.costUsd + outcome.costUsd };
    else yield event;
  }
}
