import {
  budgetFor,
  childLevel,
  cloneTree,
  findNode,
  isLocked,
  layout,
  makeNode,
  makeRoot,
  topLevelFor,
  walk,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import { revisedTreeSchema, type RevisedTree } from "@/lib/schemas/plan";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { DEFAULT_OUTLINE_MODEL } from "./models";
import { assignRefs, buildRevisionPrompt, type PlanPromptContext } from "./planPrompt";

export class LockedNodeError extends Error {
  constructor(label: string) {
    super(`The change would touch ${label}, which is already completed. Pick something later in the plan.`);
    this.name = "LockedNodeError";
  }
}

interface RevisedUnit {
  ref?: string;
  title: string;
  summary: string;
  days: number;
  children?: RevisedUnit[];
}

/**
 * Turns the model's revised tree back into `PlanNode`s. Kept nodes (by ref) keep their id and status; locked nodes
 * are restored verbatim from the original tree; new nodes get temporary ids. Throws when a locked node went missing.
 */
export function applyRevision(
  original: PlanNode,
  refs: Map<string, string>,
  revised: RevisedTree,
  lockBefore: number,
  granularity: Granularity,
): PlanNode {
  const byRef = new Map<string, PlanNode>();
  for (const [id, ref] of refs) {
    const node = findNode(original, id);
    if (node) byRef.set(ref, node);
  }
  const topLevel: PlanLevel = original.children?.[0]?.level ?? topLevelFor(original.len);
  const seen = new Set<string>();

  const convert = (unit: RevisedUnit, level: PlanLevel): PlanNode => {
    const kept = unit.ref ? byRef.get(unit.ref) : undefined;
    if (kept) seen.add(kept.id);
    if (kept && isLocked(kept, lockBefore)) return cloneTree(kept);
    const below = childLevel(level);
    const children = unit.children && below ? unit.children.map((c) => convert(c, below)) : null;
    const len = level === "day" ? 1 : Math.max(1, Math.round(unit.days));
    const leafWeek = children === null && level !== "day" && granularity === "week";
    return makeNode({
      id: kept?.id,
      level,
      title: unit.title,
      summary: unit.summary,
      len,
      status: kept?.status ?? "pending",
      budgetHours: leafWeek ? (kept?.budgetHours ?? budgetFor(len)) : null,
      manualSplit: kept?.manualSplit ?? false,
      children,
    });
  };

  const tops = revised.units.map((u) => convert(u, topLevel));
  const root = makeRoot(tops);

  walk(original, (node) => {
    if (node.id === original.id) return;
    if (isLocked(node, lockBefore) && !findNode(root, node.id)) throw new LockedNodeError(describe(original, node));
  });
  return layout(root);
}

function describe(root: PlanNode, node: PlanNode): string {
  return node.level === "day" ? `Day ${node.start}` : `"${node.title}"`;
}

export interface RevisePlanInput extends PlanPromptContext {
  tree: PlanNode;
  lockBefore: number;
  changeRequest: string;
  log?: GenerationLogContext;
}

export interface RevisePlanResult {
  tree: PlanNode;
  costUsd: number;
}

/** Runs one revision: the model returns the whole tree with refs, and `applyRevision` reconciles it. */
export async function revisePlanTree(input: RevisePlanInput): Promise<RevisePlanResult> {
  const tree = layout(cloneTree(input.tree));
  const refs = assignRefs(tree);
  const { object, costUsd } = await loggedGenerateObject(
    {
      model: DEFAULT_OUTLINE_MODEL,
      schema: revisedTreeSchema,
      prompt: buildRevisionPrompt({ ...input, tree, refs }),
    },
    { ...input.log, caller: "outline_revision" },
  );
  return { tree: applyRevision(tree, refs, object, input.lockBefore, input.granularity), costUsd };
}
