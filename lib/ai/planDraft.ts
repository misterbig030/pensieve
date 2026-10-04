import { streamObject } from "ai";
import { aliasMaterials, levelFacts, resolveCoverRefs, resolveMaterialRefs, type MaterialAliases } from "@/lib/materials";
import type { PlanDraftEvent, PlanDraftRequest, PlanExpandEvent, PlanExpandRequest } from "@/lib/planChat";
import {
  budgetFor,
  childLevel,
  childSpans,
  cloneTree,
  findNode,
  labelOf,
  layout,
  makeNode,
  makeRoot,
  splitSpans,
  topLevelFor,
  topSpans,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { topUnitListSchema, unitListSchema, type UnitDraft } from "@/lib/schemas/plan";
import { normalizeSplit, readingShareOf, type PlanSplit } from "@/lib/studyTime";
import { buildGenerationLogRow, emitGenerationLog, type GenerationLogContext } from "./logged";
import { DEFAULT_OUTLINE_MODEL } from "./models";
import { buildUnitsPrompt, type UnitsPromptInput } from "./planPrompt";
import type { ResearchArm } from "./research/agent";
import { researchMaterials, type ResearchMaterialsInput } from "./research/pipeline";

/** Whether units at `level` are leaves on a plan of this granularity (days always; weeks on week-granularity plans). */
export function unitsAreLeaves(level: PlanLevel, granularity: Granularity): boolean {
  return level === "day" || (level === "week" && granularity === "week");
}

/** Builds a node for a drafted unit: leaves get a time budget when they are week-sized. */
export function nodeFor(unit: UnitDraft, level: PlanLevel, len: number, granularity: Granularity, aliases?: MaterialAliases, hoursPerWeek?: number): PlanNode {
  const leaf = unitsAreLeaves(level, granularity);
  const node = makeNode({
    level,
    title: unit.title,
    summary: unit.summary,
    len,
    budgetHours: leaf && level !== "day" ? budgetFor(len, hoursPerWeek) : null,
    children: null,
  });
  if (aliases) applyUnitRefs(node, unit, leaf, aliases);
  return node;
}

/**
 * Puts what the model wrote for references onto the node: leaves keep `materials` (their Read table), headings keep
 * `covers` (their reservation). Returns the ids that are not in the list; they are dropped.
 */
export function applyUnitRefs(node: PlanNode, unit: UnitDraft, leaf: boolean, aliases: MaterialAliases): string[] {
  delete node.covers;
  delete node.materials;
  if (leaf) {
    const { refs, unknown } = resolveMaterialRefs(unit.materials, aliases);
    if (refs.length > 0) node.materials = refs;
    return unknown;
  }
  const { refs, unknown } = resolveCoverRefs(unit.covers, aliases);
  if (refs.length > 0) node.covers = refs;
  return unknown;
}

/**
 * When the model returns a different number of units than asked, re-derive spans so the parent's length is kept
 * for week/month units and the count is honoured for days.
 */
export function reconcileSpans(spans: number[], count: number, level: PlanLevel): number[] {
  if (count === spans.length) return spans;
  if (level === "day") return Array.from({ length: count }, () => 1);
  const total = spans.reduce((a, b) => a + b, 0);
  return splitSpans(total, Math.max(1, Math.floor(total / count)));
}

interface StreamUnitsInput {
  prompt: string;
  /** For the admin panel: what this call plans ("Top level · 4 weeks"). */
  label: string;
  /** How many units the prompt asked for. */
  expected: number;
  /** Runs on the validated units before the call is reported; returns the checks to show beside the response. */
  check?: (units: UnitDraft[]) => string[];
  /** Ask for the plan's time split along with the units (the top level of a new plan). */
  wantSplit?: boolean;
  log?: GenerationLogContext;
}

/** What an admin reading the raw response should know first: whether the count came back as asked. */
export function unitFacts(returned: number, expected: number): string[] {
  const count = `${returned} of ${expected} units`;
  return returned === expected ? [count, "spans kept"] : [count, "spans re-split"];
}

type UnitEvent = { type: "unit"; unit: UnitDraft } | { type: "done"; units: UnitDraft[]; costUsd: number; split: PlanSplit | null };

/** Streams units as they fully arrive (the in-progress one is withheld), then the validated list with its cost. */
async function* streamUnits(input: StreamUnitsInput): AsyncGenerator<UnitEvent> {
  const startedAt = performance.now();
  const result = streamObject({ model: DEFAULT_OUTLINE_MODEL, schema: input.wantSplit ? topUnitListSchema : unitListSchema, prompt: input.prompt });
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
  const [object, usage, finishReason] = await Promise.all([result.object, result.usage, result.finishReason]);
  const row = buildGenerationLogRow({
    caller: "outline",
    model: DEFAULT_OUTLINE_MODEL,
    usage,
    latencyMs: Math.round(performance.now() - startedAt),
    trackId: input.log?.trackId,
    userId: input.log?.userId,
  });
  await emitGenerationLog(input.log?.onLog, row);
  const split = input.wantSplit ? normalizeSplit((object as { split?: Parameters<typeof normalizeSplit>[0] }).split) : null;
  const checks = input.check?.(object.units) ?? [];
  if (input.wantSplit) checks.unshift(split ? `split ${split.readingShare}% reading · ${split.practice}` : "no split returned");
  input.log?.onCall?.({
    ...row,
    label: input.label,
    system: null,
    prompt: input.prompt,
    response: JSON.stringify(object, null, 2),
    finishReason: finishReason ?? null,
    facts: [...unitFacts(object.units.length, input.expected), ...checks],
  });
  yield { type: "done", units: object.units, costUsd: row.costUsd, split };
}

interface DraftLevelInput {
  ctx: { topic: string; instructions?: string; materials: Material[]; granularity: Granularity; hoursPerWeek?: number; split?: PlanSplit | null };
  /** The top level of a new plan: the drafter decides the time split in this call. */
  decideSplit?: boolean;
  level: PlanLevel;
  spans: number[];
  startDay: number;
  totalDays: number;
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
async function* draftLevel(input: DraftLevelInput): AsyncGenerator<{ type: "node"; node: PlanNode } | { type: "done"; nodes: PlanNode[]; costUsd: number; split: PlanSplit | null }> {
  const { ctx, level } = input;
  const leaf = unitsAreLeaves(level, ctx.granularity);
  const aliases = ctx.materials.length > 0 ? aliasMaterials(ctx.materials) : undefined;
  const backboneId = ctx.materials.find((m) => m.backbone)?.id ?? null;
  const promptInput: UnitsPromptInput = {
    topic: ctx.topic,
    instructions: ctx.instructions,
    materials: ctx.materials,
    granularity: ctx.granularity,
    hoursPerWeek: ctx.hoursPerWeek,
    split: ctx.split,
    decideSplit: input.decideSplit,
    level,
    spans: input.spans,
    startDay: input.startDay,
    totalDays: input.totalDays,
    tree: input.tree,
    parentId: input.parentId,
    unitsAreLeaves: leaf,
  };
  const parentNode = input.tree && input.parentId ? findNode(input.tree, input.parentId) : null;
  const where = input.tree && parentNode ? labelOf(input.tree, parentNode) : "Top level";
  const n = input.spans.length;
  const label = `${where} · ${n} ${level}${n === 1 ? "" : "s"}`;
  const nodes: PlanNode[] = [];
  let final: PlanNode[] = [];

  // Reconciles spans and references once the whole level has validated, and states the checks in code.
  const check = (units: UnitDraft[]): string[] => {
    const spans = reconcileSpans(input.spans, units.length, level);
    const unknown: string[] = [];
    final = units.map((unit, i) => {
      const node = nodes[i] ?? nodeFor(unit, level, spans[i], ctx.granularity, undefined, ctx.hoursPerWeek);
      node.title = unit.title;
      node.summary = unit.summary;
      node.len = spans[i];
      node.end = node.start + node.len - 1;
      if (node.budgetHours !== null) node.budgetHours = budgetFor(node.len, ctx.hoursPerWeek);
      if (aliases) unknown.push(...applyUnitRefs(node, unit, leaf, aliases));
      return node;
    });
    if (!aliases) return [];
    const { root, placed } = placeForChecks(input.tree, input.parentId, final);
    // While the split is decided in this same call, there is no share to hold the units to yet.
    return levelFacts({ root, nodes: placed, leaves: leaf, top: !input.parentId, backboneId, unknownIds: unknown, hoursPerWeek: ctx.hoursPerWeek, readingShare: input.decideSplit ? null : readingShareOf(ctx.split) });
  };

  for await (const event of streamUnits({ prompt: buildUnitsPrompt(promptInput), label, expected: n, check, wantSplit: input.decideSplit, log: input.log })) {
    if (event.type === "unit") {
      const len = input.spans[nodes.length] ?? (level === "day" ? 1 : input.spans[input.spans.length - 1]);
      const node = nodeFor(event.unit, level, len, ctx.granularity, aliases, ctx.hoursPerWeek);
      nodes.push(node);
      yield { type: "node", node };
    } else {
      yield { type: "done", nodes: final, costUsd: event.costUsd, split: event.split };
    }
  }
}

export interface StreamPlanDraftInput extends Omit<PlanDraftRequest, "materials"> {
  /** The materials list research produced (the learner's own included). */
  materials: Material[];
  log?: GenerationLogContext;
}

/**
 * Drafts a new plan: the top-level units, then the first unit's children, then the first grandchild's children while
 * the first branch is still made of headings. Later units stay headings until the learner reaches them.
 */
export async function* streamPlanDraft(input: StreamPlanDraftInput): AsyncGenerator<PlanDraftEvent> {
  const total = input.days;
  const topLevel = topLevelFor(total);
  const root = makeRoot([]);
  let costUsd = 0;

  // A plan drafted against a given split keeps it; otherwise the drafter decides one with the top level.
  let split: PlanSplit | null = input.split ?? null;
  const decideSplit = split === null;

  const tops: PlanNode[] = [];
  for await (const event of draftLevel({ ctx: input, decideSplit, level: topLevel, spans: topSpans(total), startDay: 1, totalDays: total, log: input.log })) {
    if (event.type === "node") {
      tops.push(event.node);
      root.children = tops;
      layout(root);
      yield { type: "node", parentId: root.id, node: event.node };
    } else {
      root.children = event.nodes;
      layout(root);
      costUsd += event.costUsd;
      if (decideSplit && event.split) {
        split = event.split;
        yield { type: "split", split };
      }
    }
  }

  const ctx = { ...input, split };
  let parent: PlanNode | undefined = root.children?.[0];
  while (parent && !unitsAreLeaves(parent.level, input.granularity)) {
    const level = childLevel(parent.level)!;
    const spans = childSpans(parent);
    const kids: PlanNode[] = [];
    for await (const event of draftLevel({ ctx, level, spans, startDay: parent.start, totalDays: root.len, tree: root, parentId: parent.id, log: input.log })) {
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
  log?: GenerationLogContext;
}

/** Plans one heading (or splits one week leaf) into the level below it. */
export async function* streamExpandNode(input: StreamExpandNodeInput): AsyncGenerator<PlanExpandEvent> {
  const root = layout(input.tree);
  const node = findNode(root, input.nodeId);
  if (!node) throw new Error("Plan node not found");
  if (node.children) throw new Error("This unit is already planned in detail");
  const level = childLevel(node.level);
  if (!level) throw new Error("A day cannot be planned in more detail");
  const granularity: Granularity = input.reason === "split" ? "day" : input.granularity;
  const ctx = { ...input, granularity };
  const spans = childSpans(node);
  const kids: PlanNode[] = [];
  for await (const event of draftLevel({ ctx, level, spans, startDay: node.start, totalDays: root.len, tree: root, parentId: node.id, log: input.log })) {
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
  signal?: AbortSignal;
  log?: GenerationLogContext;
  /** Tests and the eval inject these; the app uses the defaults. */
  research?: Pick<ResearchMaterialsInput, "fetcher" | "books" | "caps">;
}

/**
 * One request, research then drafting: the research events stream first and end with the materials list, then the
 * plan drafts against it. The finish event's cost includes research.
 */
export async function* streamResearchedPlanDraft(input: StreamResearchedDraftInput): AsyncGenerator<PlanDraftEvent> {
  const outcome = yield* researchMaterials({
    brief: { topic: input.topic, instructions: input.instructions, days: input.days, hoursPerWeek: input.hoursPerWeek, sources: input.materials },
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
