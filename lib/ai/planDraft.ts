import { streamObject } from "ai";
import type { PlanDraftEvent, PlanDraftRequest, PlanExpandEvent, PlanExpandRequest } from "@/lib/planChat";
import {
  budgetFor,
  childLevel,
  childSpans,
  findNode,
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
import { unitListSchema, type UnitDraft } from "@/lib/schemas/plan";
import { buildGenerationLogRow, emitGenerationLog, type GenerationLogContext } from "./logged";
import { DEFAULT_OUTLINE_MODEL } from "./models";
import { buildUnitsPrompt, type UnitsPromptInput } from "./planPrompt";

/** Whether units at `level` are leaves on a plan of this granularity (days always; weeks on week-granularity plans). */
export function unitsAreLeaves(level: PlanLevel, granularity: Granularity): boolean {
  return level === "day" || (level === "week" && granularity === "week");
}

/** Builds a node for a drafted unit: leaves get a time budget when they are week-sized. */
export function nodeFor(unit: UnitDraft, level: PlanLevel, len: number, granularity: Granularity): PlanNode {
  const leaf = unitsAreLeaves(level, granularity);
  return makeNode({
    level,
    title: unit.title,
    summary: unit.summary,
    len,
    budgetHours: leaf && level !== "day" ? budgetFor(len) : null,
    children: null,
  });
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
  log?: GenerationLogContext;
}

type UnitEvent = { type: "unit"; unit: UnitDraft } | { type: "done"; units: UnitDraft[]; costUsd: number };

/** Streams units as they fully arrive (the in-progress one is withheld), then the validated list with its cost. */
async function* streamUnits(input: StreamUnitsInput): AsyncGenerator<UnitEvent> {
  const startedAt = performance.now();
  const result = streamObject({ model: DEFAULT_OUTLINE_MODEL, schema: unitListSchema, prompt: input.prompt });
  let sent = 0;
  for await (const partial of result.partialObjectStream) {
    const units = (partial.units ?? []).filter((u): u is Partial<UnitDraft> => u != null);
    const complete = units.length - 1;
    while (sent < complete) {
      const unit = units[sent];
      if (typeof unit.title !== "string" || typeof unit.summary !== "string") break;
      sent += 1;
      yield { type: "unit", unit: { title: unit.title, summary: unit.summary } };
    }
  }
  const [object, usage] = await Promise.all([result.object, result.usage]);
  const row = buildGenerationLogRow({
    caller: "outline",
    model: DEFAULT_OUTLINE_MODEL,
    usage,
    latencyMs: Math.round(performance.now() - startedAt),
    trackId: input.log?.trackId,
    userId: input.log?.userId,
  });
  await emitGenerationLog(input.log?.onLog, row);
  yield { type: "done", units: object.units, costUsd: row.costUsd };
}

interface DraftLevelInput {
  ctx: PlanDraftRequest;
  level: PlanLevel;
  spans: number[];
  startDay: number;
  totalDays: number;
  tree?: PlanNode;
  parentId?: string;
  log?: GenerationLogContext;
}

/** Drafts one level of units under `parentId` (or the top level), yielding each node as it lands. */
async function* draftLevel(input: DraftLevelInput): AsyncGenerator<{ type: "node"; node: PlanNode } | { type: "done"; nodes: PlanNode[]; costUsd: number }> {
  const { ctx, level } = input;
  const promptInput: UnitsPromptInput = {
    topic: ctx.topic,
    instructions: ctx.instructions,
    sources: ctx.sources,
    granularity: ctx.granularity,
    level,
    spans: input.spans,
    startDay: input.startDay,
    totalDays: input.totalDays,
    tree: input.tree,
    parentId: input.parentId,
    unitsAreLeaves: unitsAreLeaves(level, ctx.granularity),
  };
  const nodes: PlanNode[] = [];
  for await (const event of streamUnits({ prompt: buildUnitsPrompt(promptInput), log: input.log })) {
    if (event.type === "unit") {
      const len = input.spans[nodes.length] ?? (level === "day" ? 1 : input.spans[input.spans.length - 1]);
      const node = nodeFor(event.unit, level, len, ctx.granularity);
      nodes.push(node);
      yield { type: "node", node };
    } else {
      const spans = reconcileSpans(input.spans, event.units.length, level);
      const final = event.units.map((unit, i) => {
        const existing = nodes[i];
        const node = existing ?? nodeFor(unit, level, spans[i], ctx.granularity);
        node.title = unit.title;
        node.summary = unit.summary;
        node.len = spans[i];
        node.end = node.start + node.len - 1;
        if (node.budgetHours !== null) node.budgetHours = budgetFor(node.len);
        return node;
      });
      yield { type: "done", nodes: final, costUsd: event.costUsd };
    }
  }
}

export interface StreamPlanDraftInput extends PlanDraftRequest {
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

  const tops: PlanNode[] = [];
  for await (const event of draftLevel({ ctx: input, level: topLevel, spans: topSpans(total), startDay: 1, totalDays: total, log: input.log })) {
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
    const spans = childSpans(parent);
    const kids: PlanNode[] = [];
    for await (const event of draftLevel({ ctx: input, level, spans, startDay: parent.start, totalDays: root.len, tree: root, parentId: parent.id, log: input.log })) {
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
