import { z } from "zod";
import { DEFAULT_HOURS_PER_WEEK, budgetFor, cloneTree, isLocked, walk, type PlanNode } from "@/lib/planTree";

/**
 * The learner's time: hours a week, what that comes to over the plan, and how the plan divides it between reading
 * and everything else. Pure and client-safe; the form, the prompts and the checks all read from here.
 */

export { DEFAULT_HOURS_PER_WEEK };
export const MIN_HOURS_PER_WEEK = 1;
export const MAX_HOURS_PER_WEEK = 80;

export const hoursPerWeekSchema = z.number().int().min(MIN_HOURS_PER_WEEK).max(MAX_HOURS_PER_WEEK);

export const HOURS_PRESETS = [
  { key: "casual", label: "Casual", hours: 3 },
  { key: "part", label: "Part time", hours: 6 },
  { key: "full", label: "Full time", hours: 30 },
] as const;
export type HoursPreset = (typeof HOURS_PRESETS)[number];

export function clampHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_HOURS_PER_WEEK;
  return Math.min(MAX_HOURS_PER_WEEK, Math.max(MIN_HOURS_PER_WEEK, Math.round(hours)));
}

export function presetFor(hours: number): HoursPreset | null {
  return HOURS_PRESETS.find((p) => p.hours === hours) ?? null;
}

/** Study hours over the whole plan. */
export function totalHours(days: number, hoursPerWeek: number = DEFAULT_HOURS_PER_WEEK): number {
  return Math.max(1, Math.round((days * hoursPerWeek) / 7));
}

/** One day's share of the week, to the nearest five minutes. */
export function dayMinutes(hoursPerWeek: number = DEFAULT_HOURS_PER_WEEK): number {
  return Math.max(10, Math.round((hoursPerWeek * 60) / 7 / 5) * 5);
}

const PER = String.raw`(?:\/|a|an|per|each|every)`;
const WEEKLY = new RegExp(String.raw`(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s*(?:h|hrs?|hours?)\s*${PER}\s*(?:week|wk)\b`, "i");
const DAILY = new RegExp(String.raw`(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\s*(h|hrs?|hours?|min|mins|minutes?)\s*${PER}\s*day\b`, "i");

/**
 * Weekly hours a brief states in words ("about 15 hours a week", "10h/week", "30 minutes a day"), or null. A range
 * counts as its middle. Used only to flag a brief that disagrees with the time setting.
 */
export function hoursInText(text: string): number | null {
  const mid = (a: string, b: string | undefined) => (b ? (Number(a) + Number(b)) / 2 : Number(a));
  const weekly = text.match(WEEKLY);
  if (weekly) return clampHours(mid(weekly[1], weekly[2]));
  const daily = text.match(DAILY);
  if (daily) {
    const perDay = mid(daily[1], daily[2]);
    const hours = /^min/i.test(daily[3]) ? perDay / 60 : perDay;
    return clampHours(hours * 7);
  }
  return null;
}

/**
 * How a plan divides the learner's time: the share spent reading or watching the materials, and what the rest goes
 * to, in the topic's own words ("building projects", "writing summaries", "running sessions"). The drafter decides
 * it with the top level; the learner can change it.
 */
export const planSplitSchema = z.object({
  readingShare: z.number().int().min(0).max(100),
  practice: z.string().trim().min(1).max(40),
  reason: z.string().trim().max(300),
});
export type PlanSplit = z.infer<typeof planSplitSchema>;

/** What the model writes: looser, so a share of 62.5 or a long reason never fails the whole level. */
export const planSplitDraftSchema = z.object({
  readingShare: z.number().describe("Percent of study time spent reading or watching the materials, 0 to 100"),
  practice: z.string().describe('What the rest of the time is spent on, in two or three words, e.g. "building projects"'),
  reason: z.string().describe("One sentence: why this split suits this topic and this learner"),
});
export type PlanSplitDraft = z.infer<typeof planSplitDraftSchema>;

export function normalizeSplit(draft: Partial<PlanSplitDraft> | null | undefined): PlanSplit | null {
  if (!draft || typeof draft.readingShare !== "number" || !Number.isFinite(draft.readingShare)) return null;
  const practice = (draft.practice ?? "").trim().replace(/\.$/, "");
  if (!practice) return null;
  const reason = (draft.reason ?? "").trim();
  return {
    readingShare: Math.min(100, Math.max(0, Math.round(draft.readingShare))),
    practice: practice.length > 40 ? `${practice.slice(0, 39)}…` : practice,
    reason: reason.length > 300 ? `${reason.slice(0, 299)}…` : reason,
  };
}

/** The reading share as a fraction, or null when the plan has no split (older plans fall back to a fixed share). */
export function readingShareOf(split: PlanSplit | null | undefined): number | null {
  return split ? split.readingShare / 100 : null;
}

/**
 * The tree with every open week-sized leaf budgeted for `hoursPerWeek`. Completed and locked weeks keep the budget
 * they were studied under.
 */
export function rebudget<T extends PlanNode>(root: T, hoursPerWeek: number, lockBefore = 0): T {
  const next = cloneTree(root);
  walk(next, (node) => {
    if (node.children !== null || node.budgetHours === null) return;
    if (node.status === "completed" || isLocked(node, lockBefore)) return;
    node.budgetHours = budgetFor(node.len, hoursPerWeek);
  });
  return next;
}
