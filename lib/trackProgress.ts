/**
 * Where a learner stands on a track: the day strip, the finish estimate, this week's activity, what the track's card
 * offers next and how cards sort. Days are UTC days, as in `lib/activity.ts`.
 */

import { thisWeekKeys, type StudyEvent } from "@/lib/activity";
import { currentLeaf, daysInWeekOf, doneDays, findNode, isHeading, leavesOf, parentOf, weeksOf, type Granularity, type PlanNode } from "@/lib/planTree";
import { dayKey } from "@/lib/streak";
import { dayMinutes, totalHours } from "@/lib/studyTime";

export type CellState = "done" | "current" | "ready" | "planned";

export interface StripCell {
  state: CellState;
  weekStart: boolean;
}

/** A check-in: a finished day (no hours) or a session logged against a week (its hours). */
export interface CheckIn {
  nodeId: string;
  completedAt: Date;
  hours: number | null;
}

const DAY_MS = 86_400_000;

function stateOf(node: PlanNode, currentId: string | null): CellState {
  if (node.status === "completed") return "done";
  if (node.id === currentId) return "current";
  return node.status === "generated" ? "ready" : "planned";
}

/**
 * One cell per study day of the plan in order, or one per week on a week-granularity track. A cell starts a week when
 * it is the first day of a week node, or of each `daysPerWeek` stretch of a month not planned yet.
 */
export function dayStrip(root: PlanNode, granularity: Granularity, daysPerWeek: number): StripCell[] {
  const currentId = currentLeaf(root)?.id ?? null;
  const cells: StripCell[] = [];
  const visit = (node: PlanNode, startsWeek: boolean) => {
    // A week track keeps one cell per week, even for a week split into days.
    if (granularity === "week" && node.level === "week" && node.children && node.children.length > 0) {
      const days = node.children;
      const state = days.every((d) => d.status === "completed") ? "done" : days.some((d) => d.id === currentId) ? "current" : "planned";
      cells.push({ state, weekStart: true });
      return;
    }
    if (node.children && node.children.length > 0) {
      node.children.forEach((child, i) => visit(child, node.level === "week" ? i === 0 && node.id !== root.id : child.level !== "day"));
      return;
    }
    const state = stateOf(node, currentId);
    if (granularity === "week") {
      const weeks = node.level === "month" ? Math.max(1, Math.round(weeksOf(root, node, daysPerWeek))) : 1;
      for (let i = 0; i < weeks; i++) cells.push({ state, weekStart: true });
      return;
    }
    const len = node.level === "day" ? 1 : node.len;
    for (let i = 0; i < len; i++) {
      const weekStart = node.level === "month" ? i % daysPerWeek === 0 : node.level === "week" ? i === 0 : startsWeek;
      cells.push({ state, weekStart });
    }
  };
  (root.children ?? []).forEach((child) => visit(child, true));
  if (cells.length > 0) cells[0].weekStart = true;
  return cells;
}

/** When the days left would be done at the track's pace, counted from today; null when nothing is left. */
export function finishDate(root: PlanNode, daysPerWeek: number, today: Date): Date | null {
  const left = root.len - doneDays(root);
  if (left <= 0) return null;
  return new Date(today.getTime() + Math.ceil((left / Math.max(1, daysPerWeek)) * 7) * DAY_MS);
}

/** Check-ins as study time: a finished day counts its share of the week's hours, a session its logged hours. */
export function studyEvents(root: PlanNode, checkIns: CheckIn[], hoursPerWeek: number, daysPerWeek: number): StudyEvent[] {
  return checkIns.map((c) => {
    if (c.hours !== null) return { at: c.completedAt, hours: c.hours };
    const node = findNode(root, c.nodeId);
    return { at: c.completedAt, hours: dayMinutes(hoursPerWeek, node ? daysInWeekOf(root, node, daysPerWeek) : daysPerWeek) / 60 };
  });
}

/** The plan's total hours at the track's pace. */
export function plannedHours(root: PlanNode, hoursPerWeek: number, daysPerWeek: number): number {
  return totalHours(weeksOf(root, root, daysPerWeek), hoursPerWeek);
}

export interface WeekActivity {
  /** "off" is a rest day: the days of a seven-day week the track doesn't study. */
  cells: ("done" | "current" | "open" | "off")[];
  label: string;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

/**
 * This week at a glance. A day track shows the study days of the plan week holding the current leaf; a week track
 * shows the seven days of this calendar week, filled on days with a logged session.
 */
export function weekActivity(root: PlanNode, granularity: Granularity, checkIns: CheckIn[], today: Date, hoursPerWeek: number): WeekActivity {
  if (granularity === "week") {
    const keys = thisWeekKeys(today);
    const sessions = checkIns.filter((c) => c.hours !== null && keys.includes(dayKey(c.completedAt)));
    const days = new Set(sessions.map((c) => dayKey(c.completedAt)));
    const hours = sessions.reduce((sum, c) => sum + (c.hours ?? 0), 0);
    return { cells: keys.map((k) => (days.has(k) ? "done" : "open")), label: `${formatHours(hours)} of ${hoursPerWeek} h` };
  }
  const current = currentLeaf(root);
  const anchor = current ?? leavesOf(root).at(-1) ?? null;
  const parent = anchor ? parentOf(root, anchor.id) : null;
  const days = (parent?.children ?? []).filter((n) => n.level === "day");
  const cells: WeekActivity["cells"] = days.map((d) => (d.status === "completed" ? "done" : d.id === current?.id ? "current" : "open"));
  const done = cells.filter((c) => c === "done").length;
  const label = `${done} of ${cells.length} this week`;
  // The rest of a seven-day week shows as rest days.
  if (cells.length > 0) while (cells.length < 7) cells.push("off");
  return { cells, label };
}

/** Whether any check-in falls on today's UTC day. */
export function doneToday(checkIns: Pick<CheckIn, "completedAt">[], today: Date): boolean {
  const key = dayKey(today);
  return checkIns.some((c) => dayKey(c.completedAt) === key);
}

export type CardAction = { kind: "start" | "log"; node: PlanNode } | { kind: "plan"; node: PlanNode } | { kind: "finished" };

/** What a track's card offers next: start the current day, log the current week, plan the next unit, or nothing. */
export function cardAction(root: PlanNode): CardAction {
  const node = currentLeaf(root);
  if (!node) return { kind: "finished" };
  if (isHeading(node)) return { kind: "plan", node };
  return { kind: node.level === "day" ? "start" : "log", node };
}

export type SortKey = "next" | "recent" | "newest";

interface Sortable {
  createdAt: Date;
  lastStudied: Date | null;
  action: CardAction;
  doneToday: boolean;
}

function rank(card: Sortable): number {
  if (card.action.kind === "finished") return 3;
  if (card.doneToday) return 1;
  return card.action.kind === "plan" ? 2 : 0;
}

const byLastStudied = (a: Sortable, b: Sortable) => (b.lastStudied?.getTime() ?? -Infinity) - (a.lastStudied?.getTime() ?? -Infinity) || a.createdAt.getTime() - b.createdAt.getTime();

/** "next": what's left today first, then done today, then to plan, then finished. "recent" and "newest" sort by date. */
export function sortTracks<T extends Sortable>(cards: T[], key: SortKey): T[] {
  const sorted = [...cards];
  if (key === "newest") return sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (key === "recent") return sorted.sort(byLastStudied);
  return sorted.sort((a, b) => rank(a) - rank(b) || byLastStudied(a, b));
}
