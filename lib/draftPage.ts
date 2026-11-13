import { practiceRowsFor, readRowsFor, rowBrief } from "@/components/pensieve/ReadTable";
import { budgetFor, capitalize, initialOpen, isLocked, labelOf, leavesOf, parentOf, ROOT_ID, topLevelFor, topSpans, weeksOf, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { weeksLabel } from "@/lib/studyTime";

/**
 * Decisions the redesigned draft page shares between its parts: how long the plan reads, what a row says, which rows
 * start open, and how the finished part of a plan is described. Pure; the components only render what these return.
 */

/** "6 months", "5 days": the plan's length in its top units once drafted, else the weeks the learner set. */
export function lengthLabel(weeks: number, daysPerWeek: number, tops: PlanNode[]): string {
  const level = tops[0]?.level ?? topLevelFor(weeks);
  if (tops.length === 0 && level === "day") return weeksLabel(weeks);
  const n = tops.length > 0 ? tops.length : topSpans(weeks, daysPerWeek).length;
  return `${n} ${level}${n === 1 ? "" : "s"}`;
}

/** Hours a unit is planned for: its own budget, else its share of the learner's weekly hours. */
export function unitHours(root: PlanNode, node: PlanNode, hoursPerWeek: number, daysPerWeek: number): number {
  return node.budgetHours ?? budgetFor(weeksOf(root, node, daysPerWeek), hoursPerWeek);
}

/** A row's one line: a heading's summary, or what a unit with work reads and does ("Ch. 1 · Ch. 2 · Problems (7)"). */
export function rowLine(node: PlanNode, byId: ReadonlyMap<string, Material>): string {
  const read = readRowsFor(node.materials, byId);
  const practice = practiceRowsFor(node.practice, byId);
  if (read.length === 0 && practice.length === 0) return node.summary;
  const reads = [...new Set(read.map((r) => rowBrief(r).head))];
  const counts = new Map<string, number>();
  for (const p of practice) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  const does = [...counts].map(([label, n]) => `${label} (${n})`);
  return [...reads, ...does].join(" · ");
}

/** The rows open before the learner touches any: the first unit (and its first week in a month plan), or the way to the current day. */
export function defaultOpen(root: PlanNode, mode: "create" | "adjust", currentLeafId: string | null): Set<string> {
  if (mode === "adjust") {
    const open = initialOpen(root, currentLeafId);
    if (currentLeafId) open.add(currentLeafId);
    return open;
  }
  const first = root.children?.[0];
  const open = new Set<string>();
  if (!first) return open;
  open.add(first.id);
  if (first.level === "month" && first.children?.[0]) open.add(first.children[0].id);
  return open;
}

/** The defaults with the learner's own opening (true) and closing (false) laid over them. */
export function openRows(root: PlanNode, mode: "create" | "adjust", currentLeafId: string | null, toggles: ReadonlyMap<string, boolean>): Set<string> {
  const open = defaultOpen(root, mode, currentLeafId);
  for (const [id, on] of toggles) {
    if (on) open.add(id);
    else open.delete(id);
  }
  return open;
}

function nextLeaf(root: PlanNode, lockBefore: number): PlanNode | null {
  return leavesOf(root).find((leaf) => leaf.start === lockBefore + 1) ?? null;
}

/** Where changes start: "Day 3 of Week 3", or a week leaf's own label; null when nothing is left to change. */
export function nextLeafLabel(root: PlanNode, lockBefore: number): string | null {
  const leaf = nextLeaf(root, lockBefore);
  if (!leaf) return null;
  const parent = parentOf(root, leaf.id);
  if (leaf.level === "day" && parent?.level === "week" && parent.id !== ROOT_ID) return `${labelOf(root, leaf)} of ${labelOf(root, parent)}`;
  return labelOf(root, leaf);
}

const ALL_DONE = "Every day of this plan is done, so there is nothing left to change.";

/** "Weeks 1–2 and the first 2 days of Week 3 are done and stay as they are.": the finished part, before `next`. */
function doneSentence(root: PlanNode, lockBefore: number, next: PlanNode): string {
  const tops = root.children ?? [];
  const locked = tops.filter((t) => isLocked(t, lockBefore));
  const parts: string[] = [];
  if (locked.length === 1) parts.push(labelOf(root, locked[0]));
  else if (locked.length > 1) parts.push(`${capitalize(locked[0].level)}s 1–${locked.length}`);
  const top = tops.find((t) => t.start <= next.start && next.end <= t.end);
  const partial = top && top.start <= lockBefore ? lockBefore - top.start + 1 : 0;
  if (top && partial > 0) parts.push(`the first ${partial === 1 ? "day" : `${partial} days`} of ${labelOf(root, top)}`);
  const single = (locked.length === 1 && partial === 0) || (locked.length === 0 && partial === 1);
  const done = parts.join(" and ");
  return `${capitalize(done)} ${single ? "is" : "are"} done and ${single ? "stays" : "stay"} as ${single ? "it is" : "they are"}.`;
}

/** What adjust mode says about the finished part of the plan; null when nothing is done yet. */
export function lockLine(root: PlanNode, lockBefore: number): string | null {
  if (lockBefore <= 0) return null;
  const next = nextLeaf(root, lockBefore);
  if (!next) return ALL_DONE;
  return `${doneSentence(root, lockBefore, next)} Changes apply from ${nextLeafLabel(root, lockBefore)}.`;
}

/** Adjust's first chat message: where the learner is, and what is done and stays. */
export function adjustOpening(root: PlanNode, lockBefore: number): string {
  if (lockBefore <= 0) return "Nothing is checked off yet, so the whole plan is open to change.";
  const next = nextLeaf(root, lockBefore);
  if (!next) return ALL_DONE;
  return `You're on ${nextLeafLabel(root, lockBefore)}. Tell me what to change from here on. ${doneSentence(root, lockBefore, next)}`;
}

/** Adjust's opening answer after `adjustOpening`; null when every day is done, since there is no rest to work on. */
export function adjustAnswer(root: PlanNode, lockBefore: number): string | null {
  if (lockBefore > 0 && !nextLeaf(root, lockBefore)) return null;
  return "Here is the rest of your plan as it stands. Reorder or rework the open units, add or drop days inside the current one, or ask why something is where it is.";
}

/** Whether the node, or anything under it, is one of `ids`. */
export function touches(node: PlanNode, ids: ReadonlySet<string>): boolean {
  return ids.has(node.id) || (node.children?.some((c) => touches(c, ids)) ?? false);
}

/** The days a split bar splits into: the learner's own step if they made one, else the days a week they have set. */
export function daysToSplit(picked: number | null, usual: number): number {
  return picked ?? usual;
}

/** Every unit id under the root. */
export function allUnitIds(root: PlanNode): Set<string> {
  const ids = new Set<string>();
  const visit = (n: PlanNode) => {
    for (const c of n.children ?? []) {
      ids.add(c.id);
      visit(c);
    }
  };
  visit(root);
  return ids;
}

/** Ids under the root that are not in `known`: the units that arrived since. */
export function newUnitIds(known: ReadonlySet<string>, root: PlanNode): string[] {
  return [...allUnitIds(root)].filter((id) => !known.has(id));
}
