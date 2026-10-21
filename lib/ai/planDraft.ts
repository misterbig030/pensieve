import { streamObject } from "ai";
import { aliasMaterials, dropBreaches, levelChecks, resolveCoverRefs, resolveMaterialRefs, sizeChapterRows, type Breach, type MaterialAliases } from "@/lib/materials";
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
import { topUnitListSchema, unitListSchema, type UnitDraft } from "@/lib/schemas/plan";
import { normalizeSplit, readingShareOf, type PlanSplit } from "@/lib/studyTime";
import { buildGenerationLogRow, emitGenerationLog, type GenerationLogContext } from "./logged";
import { DEFAULT_OUTLINE_MODEL } from "./models";
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
export function nodeFor(unit: UnitDraft, level: PlanLevel, len: number, granularity: Granularity, aliases?: MaterialAliases, hoursPerWeek?: number): PlanNode {
  const leaf = unitsAreLeaves(level, granularity);
  const node = makeNode({
    level,
    title: unit.title,
    summary: unit.summary,
    len,
    budgetHours: leaf && level !== "day" ? budgetFor(1, hoursPerWeek) : null,
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
  /** Ask for the plan's time split along with the units (the top level of a new plan). */
  wantSplit?: boolean;
  /** The model that drafts the units, and who pays for it. */
  model: ResolvedModel;
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
  // A failed stream is reported through onError and the partial stream just ends; result.object would then never
  // settle. Keep the failure and throw it once the loop is over, so a provider refusal reaches the caller.
  let failure: unknown;
  const result = streamObject({
    model: input.model.model,
    schema: input.wantSplit ? topUnitListSchema : unitListSchema,
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
  /** The top level of a new plan: the drafter decides the time split in this call. */
  decideSplit?: boolean;
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
async function* draftLevel(input: DraftLevelInput): AsyncGenerator<{ type: "node"; node: PlanNode } | { type: "done"; nodes: PlanNode[]; costUsd: number; split: PlanSplit | null }> {
  const { ctx, level } = input;
  const leaf = unitsAreLeaves(level, ctx.granularity);
  const aliases = ctx.materials.length > 0 ? aliasMaterials(ctx.materials) : undefined;
  const promptInput: UnitsPromptInput = {
    topic: ctx.topic,
    instructions: ctx.instructions,
    materials: ctx.materials,
    granularity: ctx.granularity,
    hoursPerWeek: ctx.hoursPerWeek,
    daysPerWeek: ctx.daysPerWeek,
    split: ctx.split,
    decideSplit: input.decideSplit,
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
    final = units.map((unit, i) => {
      const node = nodes[i] ?? nodeFor(unit, level, spans[i], ctx.granularity, undefined, ctx.hoursPerWeek);
      node.title = unit.title;
      node.summary = unit.summary;
      node.len = spans[i];
      node.end = node.start + node.len - 1;
      if (node.budgetHours !== null) node.budgetHours = budgetFor(1, ctx.hoursPerWeek);
      if (aliases) unknown.push(...applyUnitRefs(node, unit, leaf, aliases));
      return node;
    });
    if (!aliases) return [];
    // Chapter rows take their minutes from the list before the budget is judged, so the checks see real sizes.
    if (leaf) sizeChapterRows(final, ctx.materials);
    const { root, placed } = placeForChecks(input.tree, input.parentId, final);
    // While the split is decided in this same call, there is no share to hold the units to yet.
    const checks = levelChecks({ root, nodes: placed, leaves: leaf, top: !input.parentId, materials: ctx.materials, unknownIds: unknown, hoursPerWeek: ctx.hoursPerWeek, daysPerWeek: ctx.daysPerWeek, readingShare: input.decideSplit ? null : readingShareOf(ctx.split) });
    breaches = checks.breaches;
    const facts = [...checks.facts, ...breaches.map((b) => `breach: ${b.text}`)];
    if (attempt === 2) {
      // Rows that still breach are dropped, the drops recorded, and the surviving chapter rows resized.
      facts.push(...dropBreaches(final, breaches));
      if (leaf) sizeChapterRows(final, ctx.materials);
    }
    return facts;
  };

  const prompt = buildUnitsPrompt(promptInput);
  const base = { expected: n, check, wantSplit: input.decideSplit, model: ctx.outlineModel, log: input.log };
  let costUsd = 0;
  let split: PlanSplit | null = null;
  for await (const event of streamUnits({ ...base, prompt, label })) {
    if (event.type === "unit") {
      const len = input.spans[nodes.length] ?? (level === "day" ? 1 : input.spans[input.spans.length - 1]);
      const node = nodeFor(event.unit, level, len, ctx.granularity, aliases, ctx.hoursPerWeek);
      nodes.push(node);
      yield { type: "node", node };
    } else {
      costUsd = event.costUsd;
      split = event.split;
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
          split = event.split ?? split;
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
  yield { type: "done", nodes: final, costUsd, split };
}

export const RETRY_HEADER = (n: number) => `Your previous answer broke these rules; return all ${n} units again, corrected:`;

export interface StreamPlanDraftInput extends Omit<PlanDraftRequest, "materials"> {
  /** The materials list research produced (the learner's own included). */
  materials: Material[];
  /** The model that drafts units; the app's outline model when omitted (eval, tests). */
  outlineModel?: ResolvedModel;
  log?: GenerationLogContext;
}

/**
 * Drafts a new plan: the top-level units, then the first unit's children, then the first grandchild's children while
 * the first branch is still made of headings. Later units stay headings until the learner reaches them.
 */
export async function* streamPlanDraft(input: StreamPlanDraftInput): AsyncGenerator<PlanDraftEvent> {
  const topLevel = topLevelFor(input.weeks);
  const root = makeRoot([]);
  let costUsd = 0;

  // A plan drafted against a given split keeps it; otherwise the drafter decides one with the top level.
  let split: PlanSplit | null = input.split ?? null;
  const decideSplit = split === null;

  const tops: PlanNode[] = [];
  const ctx = { ...input, outlineModel: input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL) };
  for await (const event of draftLevel({ ctx, decideSplit, level: topLevel, spans: topSpans(input.weeks, input.daysPerWeek), log: input.log })) {
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

  const deeper = { ...ctx, split };
  let parent: PlanNode | undefined = root.children?.[0];
  while (parent && !unitsAreLeaves(parent.level, input.granularity)) {
    const level = childLevel(parent.level)!;
    const spans = childSpans(parent, input.daysPerWeek);
    const kids: PlanNode[] = [];
    for await (const event of draftLevel({ ctx: deeper, level, spans, tree: root, parentId: parent.id, log: input.log })) {
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
  // A week split by hand: its Read table is the reservation its days are planned from, whatever the client sent.
  if (input.reason === "split" && node.materials) {
    node.covers = node.materials.map(({ id, note, chapter, activity, tier, minutes }) => ({ id, note, chapter, activity, tier, minutes }));
    delete node.materials;
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
  signal?: AbortSignal;
  log?: GenerationLogContext;
  /** Tests and the eval inject these; the app uses the defaults. */
  research?: Pick<ResearchMaterialsInput, "fetcher" | "books" | "caps" | "chapters">;
}

/**
 * One request, research then drafting: the research events stream first and end with the materials list, then the
 * plan drafts against it. The finish event's cost includes research.
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
