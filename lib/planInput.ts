import { layout, makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { PlanNodeInput, PlanTreeInput } from "@/lib/schemas/plan";

interface NodeInputLike {
  id: string;
  level: PlanNodeInput["level"];
  title: string;
  summary: string;
  len: number;
  status?: PlanNodeInput["status"];
  budgetHours?: number | null;
  manualSplit?: boolean;
  children?: NodeInputLike[] | null;
}

function fromInput(input: NodeInputLike): PlanNode {
  return makeNode({
    id: input.id,
    level: input.level,
    title: input.title,
    summary: input.summary,
    len: input.len,
    status: input.status,
    budgetHours: input.budgetHours ?? null,
    manualSplit: input.manualSplit ?? false,
    children: input.children ? input.children.map(fromInput) : null,
  });
}

/** Rebuilds a laid-out tree from the validated request body. */
export function fromTreeInput(tops: PlanTreeInput): PlanNode {
  return layout(makeRoot(tops.map((t) => fromInput(t as NodeInputLike))));
}

/** Strips derived fields so a tree can be sent to the server as `planTreeInputSchema`. */
export function toTreeInput(root: PlanNode): PlanTreeInput {
  const strip = (node: PlanNode): PlanNodeInput => ({
    id: node.id,
    level: node.level,
    title: node.title,
    summary: node.summary,
    len: node.len,
    status: node.status,
    budgetHours: node.budgetHours,
    manualSplit: node.manualSplit,
    children: node.children ? (node.children.map(strip) as PlanNodeInput["children"]) : null,
  });
  return (root.children ?? []).map(strip);
}
