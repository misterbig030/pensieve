/**
 * The plan is a tree of nodes. A node with children is a group (a month or a week); a node without children is a
 * leaf that holds content and check-ins. Leaves are usually days, but on week-granularity tracks a whole week is a
 * leaf with a time budget. Spans (`start`/`end`) are derived by `layout`, never stored.
 *
 * Lengths count study days. A plan is so many weeks long and each week has its own number of study days: the
 * learner's usual number, or the one they picked when they split it. Time is counted in weeks, whatever a week's day
 * count (see `weeksOf`).
 */

import type { CoverRef, MaterialRef, PracticeCover, PracticeRef } from "@/lib/schemas/material";

export type PlanLevel = "month" | "week" | "day";
export type NodeStatus = "pending" | "generated" | "completed";
export type Granularity = "day" | "week";
export type GranularityChoice = Granularity | "auto";

export interface PlanNode {
  id: string;
  level: PlanLevel;
  title: string;
  summary: string;
  /** Span in study days. For groups this is recomputed from the children by `layout`. */
  len: number;
  status: NodeStatus;
  /** Week leaves carry a time budget in hours. */
  budgetHours: number | null;
  /** True when the learner split a week leaf into days by hand. */
  manualSplit: boolean;
  /** `null` means the node has not been planned in detail yet (a heading). */
  children: PlanNode[] | null;
  /** Headings: material the units inside will read, reserved in order (no tier or minutes). */
  covers?: CoverRef[];
  /** Leaves: the Read table. */
  materials?: MaterialRef[];
  /** Headings: practice sources the units inside will use, reserved in order. */
  practiceCovers?: PracticeCover[];
  /** Leaves: the practice rows. */
  practice?: PracticeRef[];
  /** Track pages attach the sessions logged against a week leaf. */
  sessions?: { count: number; hours: number };
  /** 1-based index of the first study day across the plan, set by `layout`. Internal: the learner sees days by week. */
  start: number;
  /** 1-based index of the last study day across the plan, set by `layout`. */
  end: number;
}

export const ROOT_ID = "root";
/** Study days in a week for a learner who has not said otherwise. Tracks saved before the setting existed have 7. */
export const DEFAULT_DAYS_PER_WEEK = 5;
export const MAX_DAYS_PER_WEEK = 7;
/** Weeks in a month-sized heading. */
export const MONTH_WEEKS = 4;
export const MAX_WEEKS = 52;

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

/** The unit the top of the plan is made of: days for a one-week plan, weeks up to ten weeks, months beyond. */
export function topLevelFor(weeks: number): PlanLevel {
  if (weeks <= 1) return "day";
  if (weeks <= 10) return "week";
  return "month";
}

export function resolveGranularity(choice: GranularityChoice, weeks: number): Granularity {
  if (choice === "auto") return weeks > 8 ? "week" : "day";
  return choice;
}

export function childLevel(level: PlanLevel): PlanLevel | null {
  if (level === "month") return "week";
  if (level === "week") return "day";
  return null;
}

/**
 * Spans of the children a group of this level would have: a month's weeks of `daysPerWeek` days each, a week's days.
 * A month saved before the setting existed may not be whole weeks; its tail is spread over its weeks.
 */
export function childSpans(node: { level: PlanLevel; len: number }, daysPerWeek: number): number[] {
  if (node.level === "month") return splitSpans(node.len, daysPerWeek);
  if (node.level === "week") return Array.from({ length: node.len }, () => 1);
  return [];
}

/** Spans of the top-level units for a plan of `weeks` weeks at `daysPerWeek` study days each. */
export function topSpans(weeks: number, daysPerWeek: number): number[] {
  const level = topLevelFor(weeks);
  if (level === "day") return Array.from({ length: daysPerWeek }, () => 1);
  if (level === "week") return Array.from({ length: weeks }, () => daysPerWeek);
  return splitSpans(weeks, MONTH_WEEKS).map((w) => w * daysPerWeek);
}

/** What a learner who has not said otherwise is assumed to study: six hours a week. */
export const DEFAULT_HOURS_PER_WEEK = 6;

/** Hours a unit spanning `weeks` weeks is budgeted for: the learner's weekly hours, times the weeks. */
export function budgetFor(weeks: number, hoursPerWeek: number = DEFAULT_HOURS_PER_WEEK): number {
  return Math.max(1, Math.round(weeks * hoursPerWeek));
}

/**
 * How many weeks of the learner's time a node spans. A week is one week whatever its day count; a day is its week's
 * share (at the top of a one-week plan, a share of the usual week); a month is its weeks, counted from its children
 * once planned and from its length before. The root is the whole plan.
 */
export function weeksOf(root: PlanNode, node: PlanNode, daysPerWeek: number): number {
  if (node.level === "week" && node.id !== ROOT_ID) return 1;
  if (node.level === "day") return 1 / daysInWeekOf(root, node, daysPerWeek);
  if (node.children && node.children.length > 0) return node.children.reduce((sum, c) => sum + weeksOf(root, c, daysPerWeek), 0);
  return node.len / daysPerWeek;
}

/**
 * The plan's weeks while the units in `planning` are being planned: each counts as it was before, since its streamed
 * children are only part of it.
 */
export function settledWeeks(root: PlanNode, planning: readonly string[], daysPerWeek: number): number {
  const ids = planning.filter((id) => id !== root.id);
  if (ids.length === 0) return weeksOf(root, root, daysPerWeek);
  const copy = cloneTree(root);
  for (const id of ids) {
    const node = findNode(copy, id);
    if (node) node.children = null;
  }
  return weeksOf(copy, copy, daysPerWeek);
}

/** The tree with the node of `snapshot`'s id put back as the snapshot, as it was before a change that failed. */
export function replaceNode<T extends PlanNode>(root: T, snapshot: PlanNode): T {
  const next = cloneTree(root);
  const parent = parentOf(next, snapshot.id);
  if (parent?.children) parent.children = parent.children.map((c) => (c.id === snapshot.id ? cloneTree(snapshot) : c));
  return next;
}

/** Study days in the week a day belongs to: its week's length, or the usual number at the top of a one-week plan. */
export function daysInWeekOf(root: PlanNode, node: PlanNode, daysPerWeek: number): number {
  const parent = parentOf(root, node.id);
  return parent && parent.level === "week" && parent.id !== root.id ? Math.max(1, parent.len) : daysPerWeek;
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

/** "Day 3" / "Week 2" / "Month 1" by position among its siblings: a week's days run from Day 1. */
export function labelOf(root: PlanNode, node: PlanNode): string {
  const parent = parentOf(root, node.id);
  const ordinal = parent ? parent.children!.indexOf(node) + 1 : 1;
  return `${capitalize(node.level)} ${ordinal}`;
}

/** "Week 2 · Day 3" for a day inside a week, otherwise the node's own label: how a day is named outside its week. */
export function fullLabelOf(root: PlanNode, node: PlanNode): string {
  const own = labelOf(root, node);
  if (node.level !== "day") return own;
  const parent = parentOf(root, node.id);
  return parent && parent.id !== root.id && parent.level === "week" ? `${labelOf(root, parent)} · ${own}` : own;
}

/** "5 days" for a week, "4 weeks" for a month, empty for a day. */
export function spanOf(root: PlanNode, node: PlanNode, daysPerWeek: number): string {
  if (node.level === "day") return "";
  const n = node.level === "week" ? node.len : Math.round(weeksOf(root, node, daysPerWeek));
  const noun = node.level === "week" ? "day" : "week";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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

/** Whether a childless node is a heading (to be planned later) rather than a leaf the learner works at. */
export function isHeading(node: PlanNode): boolean {
  return node.children === null && node.level !== "day" && node.budgetHours === null;
}

/** The leaves a learner works at, in plan order: `leavesOf` without the headings still to be planned. */
export function workLeaves(root: PlanNode): PlanNode[] {
  return leavesOf(root).filter((leaf) => !isHeading(leaf));
}

/** The work leaves just before and after this one. */
export function neighbours(root: PlanNode, id: string): { prev: PlanNode | null; next: PlanNode | null } {
  const leaves = workLeaves(root);
  const i = leaves.findIndex((leaf) => leaf.id === id);
  if (i < 0) return { prev: null, next: null };
  return { prev: leaves[i - 1] ?? null, next: leaves[i + 1] ?? null };
}

/**
 * The node the plan page shows: the one asked for when it exists below the root, else the current leaf, else the last
 * leaf of a finished plan, else the first unit.
 */
export function resolveSelected(root: PlanNode, id: string | undefined): PlanNode {
  const asked = id && id !== root.id ? findNode(root, id) : null;
  return asked ?? currentLeaf(root) ?? workLeaves(root).at(-1) ?? root.children?.[0] ?? root;
}

/** The units on the path to the current leaf, which the plan's outline opens first. */
export function initialOpen(root: PlanNode, currentLeafId: string | null): Set<string> {
  const open = new Set<string>();
  let parent = currentLeafId ? parentOf(root, currentLeafId) : null;
  while (parent && parent.id !== root.id) {
    open.add(parent.id);
    parent = parentOf(root, parent.id);
  }
  return open;
}

/**
 * The tree with every open week and month that is not planned yet re-lengthened for a new usual number of days.
 * Weeks already split keep their days; completed and locked units keep theirs. The days at the top of a one-week plan
 * are its units, not a length, so they are left alone; the time card does not offer a new number there.
 */
export function relength<T extends PlanNode>(root: T, from: number, to: number, lockBefore = 0): T {
  const next = cloneTree(root);
  if (from === to) return next;
  walk(next, (node) => {
    if (node.id === ROOT_ID || node.children !== null || node.level === "day") return;
    if (node.status === "completed" || isLocked(node, lockBefore)) return;
    node.len = node.level === "week" ? to : Math.max(1, Math.round(node.len / from)) * to;
  });
  return layout(next);
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
  covers?: CoverRef[];
  materials?: MaterialRef[];
  practiceCovers?: PracticeCover[];
  practice?: PracticeRef[];
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
    ...(input.covers && input.covers.length > 0 ? { covers: input.covers } : {}),
    ...(input.materials && input.materials.length > 0 ? { materials: input.materials } : {}),
    ...(input.practiceCovers && input.practiceCovers.length > 0 ? { practiceCovers: input.practiceCovers } : {}),
    ...(input.practice && input.practice.length > 0 ? { practice: input.practice } : {}),
    start: 1,
    end: input.len,
  };
}

export interface PlanningStep {
  nodeId: string;
  reason: "expand" | "split";
  /** "Planning Month 2", "Splitting Week 2 of Month 1". */
  label: string;
}

/** Whether units at `level` are the plan's leaves: days always, weeks on a week plan. */
function leafLevel(level: PlanLevel, granularity: Granularity): boolean {
  return level === "day" || (level === "week" && granularity === "week");
}

/** The next unit to plan in detail, in plan order: an unplanned heading, or a week leaf to split into days. Null when every unit is planned to days. */
export function nextPlanningStep(root: PlanNode, granularity: Granularity): PlanningStep | null {
  let step: PlanningStep | null = null;
  walk(root, (node, parent) => {
    if (step || node.id === root.id || node.level === "day" || node.children !== null) return;
    const reason = leafLevel(node.level, granularity) ? "split" : "expand";
    const where = parent && parent.id !== root.id ? ` of ${labelOf(root, parent)}` : "";
    step = { nodeId: node.id, reason, label: `${reason === "split" ? "Splitting" : "Planning"} ${labelOf(root, node)}${where}` };
  });
  return step;
}

/** How many planning steps are left: every unplanned unit above day, plus the weeks each unplanned month will have. */
export function planningStepsLeft(root: PlanNode, daysPerWeek: number): number {
  let n = 0;
  walk(root, (node) => {
    if (node.id === root.id || node.level === "day" || node.children !== null) return;
    n += 1;
    if (node.level === "month") n += childSpans(node, daysPerWeek).length;
  });
  return n;
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Lower-cases a leading capital when the title is a plain phrase ("Serving systems" → "serving systems"). */
export function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
