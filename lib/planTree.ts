/**
 * The plan is a tree of nodes. A node with children is a group (a month or a week); a node without children is a
 * leaf that holds content and check-ins. Leaves are usually days, but on week-granularity tracks a whole week is a
 * leaf with a time budget. Spans (`start`/`end`) are derived by `layout`, never stored.
 */

export type PlanLevel = "month" | "week" | "day";
export type NodeStatus = "pending" | "generated" | "completed";
export type Granularity = "day" | "week";
export type GranularityChoice = Granularity | "auto";

export interface PlanNode {
  id: string;
  level: PlanLevel;
  title: string;
  summary: string;
  /** Span in days. For groups this is recomputed from the children by `layout`. */
  len: number;
  status: NodeStatus;
  /** Week leaves carry a time budget in hours. */
  budgetHours: number | null;
  /** True when the learner split a week leaf into days by hand. */
  manualSplit: boolean;
  /** `null` means the node has not been planned in detail yet (a heading). */
  children: PlanNode[] | null;
  /** Track pages attach the sessions logged against a week leaf. */
  sessions?: { count: number; hours: number };
  /** 1-based day index of the first day, set by `layout`. */
  start: number;
  /** 1-based day index of the last day, set by `layout`. */
  end: number;
}

export const ROOT_ID = "root";
export const WEEK_DAYS = 7;
export const MONTH_DAYS = 28;

const LEVEL_RANK: Record<PlanLevel, number> = { day: 0, week: 1, month: 2 };

/**
 * Splits `total` days into spans of roughly `size`. Tails shorter than half a unit are absorbed into the other spans,
 * so a 30-day plan becomes 7,7,8,8 rather than four weeks and a two-day runt. Surplus days land on the last spans.
 */
export function splitSpans(total: number, size: number): number[] {
  if (total <= 0) return [];
  let count = Math.ceil(total / size);
  const tail = total - (count - 1) * size;
  if (count > 1 && tail < size / 2) count -= 1;
  const base = Math.floor(total / count);
  const extra = total % count;
  return Array.from({ length: count }, (_, i) => base + (i >= count - extra ? 1 : 0));
}

/** The unit the top of the plan is made of: days for a short plan, weeks for a month or two, months beyond. */
export function topLevelFor(days: number): PlanLevel {
  if (days <= 14) return "day";
  if (days <= 70) return "week";
  return "month";
}

export function resolveGranularity(choice: GranularityChoice, days: number): Granularity {
  if (choice === "auto") return days > 60 ? "week" : "day";
  return choice;
}

export function childLevel(level: PlanLevel): PlanLevel | null {
  if (level === "month") return "week";
  if (level === "week") return "day";
  return null;
}

/** Spans of the children a group of this level would have. */
export function childSpans(node: { level: PlanLevel; len: number }): number[] {
  if (node.level === "month") return splitSpans(node.len, WEEK_DAYS);
  if (node.level === "week") return Array.from({ length: node.len }, () => 1);
  return [];
}

/** Spans of the top-level units for a plan of `days` days. */
export function topSpans(days: number): number[] {
  const level = topLevelFor(days);
  if (level === "day") return Array.from({ length: days }, () => 1);
  if (level === "week") return splitSpans(days, WEEK_DAYS);
  return splitSpans(days, MONTH_DAYS);
}

/** Hours a week-sized leaf is budgeted for: about six hours per seven days. */
export function budgetFor(len: number): number {
  return Math.max(1, Math.round((len * 6) / 7));
}

export function isLeaf(node: PlanNode): boolean {
  return node.children === null;
}

/**
 * Assigns `start`/`end` to every node in place and recomputes group spans from their children. Nodes listed in
 * `keepLen` keep their span even while their children are still streaming in, so later units don't shift around.
 */
export function layout<T extends PlanNode>(node: T, start = 1, keepLen?: ReadonlySet<string>): T {
  node.start = start;
  if (node.children && node.children.length > 0) {
    let cursor = start;
    for (const child of node.children) {
      layout(child, cursor, keepLen);
      cursor = child.end + 1;
    }
    if (!keepLen?.has(node.id)) node.len = cursor - start;
  }
  node.end = node.start + node.len - 1;
  return node;
}

export function walk(
  node: PlanNode,
  fn: (node: PlanNode, parent: PlanNode | null, index: number) => void,
  parent: PlanNode | null = null,
  index = 0,
): void {
  fn(node, parent, index);
  node.children?.forEach((child, i) => walk(child, fn, node, i));
}

export function findNode(root: PlanNode, id: string): PlanNode | null {
  let found: PlanNode | null = null;
  walk(root, (n) => {
    if (n.id === id) found = n;
  });
  return found;
}

export function parentOf(root: PlanNode, id: string): PlanNode | null {
  let found: PlanNode | null = null;
  walk(root, (n, p) => {
    if (n.id === id) found = p;
  });
  return found;
}

export function leavesOf(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  walk(root, (n) => {
    if (n.children === null && n.id !== ROOT_ID) out.push(n);
  });
  return out;
}

/** Days completed under this node. A completed week leaf counts as its whole span. */
export function doneDays(node: PlanNode): number {
  if (node.children === null) return node.status === "completed" ? node.len : 0;
  return node.children.reduce((sum, child) => sum + doneDays(child), 0);
}

/** "Day 9" for a day leaf, otherwise "Week 2" / "Month 1" by position among its siblings. */
export function labelOf(root: PlanNode, node: PlanNode): string {
  if (node.level === "day") return `Day ${node.start}`;
  const parent = parentOf(root, node.id);
  const ordinal = parent ? parent.children!.indexOf(node) + 1 : 1;
  return `${capitalize(node.level)} ${ordinal}`;
}

export function spanOf(node: { start: number; end: number; len: number }): string {
  return node.len === 1 ? `Day ${node.start}` : `Day ${node.start}–${node.end}`;
}

/** A node is locked when every day in it is on or before the last completed day. */
export function isLocked(node: PlanNode, lockBefore: number): boolean {
  return lockBefore > 0 && node.end <= lockBefore;
}

/** The last day index that is completed in order from Day 1 — the boundary adjust mode may not cross. */
export function lockBoundary(root: PlanNode): number {
  let boundary = 0;
  for (const leaf of leavesOf(root)) {
    if (leaf.status === "completed") boundary = Math.max(boundary, leaf.end);
  }
  return boundary;
}

/** The first leaf that is not completed, in plan order. */
export function currentLeaf(root: PlanNode): PlanNode | null {
  return leavesOf(root).find((leaf) => leaf.status !== "completed") ?? null;
}

export function highestLevel(levels: PlanLevel[]): PlanLevel {
  return levels.reduce<PlanLevel>((best, level) => (LEVEL_RANK[level] > LEVEL_RANK[best] ? level : best), "day");
}

export function cloneTree<T extends PlanNode>(root: T): T {
  return JSON.parse(JSON.stringify(root)) as T;
}

export function makeRoot(children: PlanNode[]): PlanNode {
  return layout({
    id: ROOT_ID,
    level: "month",
    title: "",
    summary: "",
    len: children.reduce((sum, c) => sum + c.len, 0),
    status: "pending",
    budgetHours: null,
    manualSplit: false,
    children,
    start: 1,
    end: 0,
  });
}

let tempCounter = 0;
/** Ids for nodes that only exist in the browser until the plan is confirmed. */
export function tempNodeId(): string {
  tempCounter += 1;
  return `tmp-${Date.now().toString(36)}-${tempCounter}`;
}

export interface NewNodeInput {
  id?: string;
  level: PlanLevel;
  title: string;
  summary: string;
  len: number;
  budgetHours?: number | null;
  manualSplit?: boolean;
  children?: PlanNode[] | null;
  status?: NodeStatus;
}

export function makeNode(input: NewNodeInput): PlanNode {
  return {
    id: input.id ?? tempNodeId(),
    level: input.level,
    title: input.title,
    summary: input.summary,
    len: input.len,
    status: input.status ?? "pending",
    budgetHours: input.budgetHours ?? null,
    manualSplit: input.manualSplit ?? false,
    children: input.children ?? null,
    start: 1,
    end: input.len,
  };
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Lower-cases a leading capital when the title is a plain phrase ("Serving systems" → "serving systems"). */
export function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
