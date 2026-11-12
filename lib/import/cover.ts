import { isImportedRow } from "@/lib/materials";
import { PRACTICE_REGISTRY, type PracticeFormat } from "@/lib/practice";
import { budgetFor, type PlanNode } from "@/lib/planTree";
import { MAX_UNIT_MINUTES, type UnitTime } from "@/lib/schemas/plan";
import type { CoverRef, MaterialRef, PracticeCover, PracticeRef } from "@/lib/schemas/material";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** The item run a row takes, or null when it names none. */
function runOf(r: { itemFrom?: number | null; itemTo?: number | null }): [number, number] | null {
  return r.itemFrom && r.itemTo ? [r.itemFrom, r.itemTo] : null;
}

/**
 * Whether some day holds the imported reservation `row`. A sourced row is held by a day row of its format and source
 * whose items overlap its own (any such row, when either names no items); a sourceless row by a day row of its format with
 * its task, or one that starts with the first 24 characters of it (`isImportedRow`, as the drafts are marked).
 */
function holds(days: PlanNode[], row: PracticeCover): boolean {
  const rows = days.flatMap((d) => d.practice ?? []).filter((r) => r.format === row.format);
  if (row.id === null) return rows.some((r) => isImportedRow(r, row));
  const want = runOf(row);
  return rows.some((r) => {
    if (r.id !== row.id) return false;
    const got = runOf(r);
    // A day row with no item run takes the whole source.
    return !want || got === null || (got[0] <= want[1] && want[0] <= got[1]);
  });
}

/**
 * Whether some day's Read table holds the same part of the same resource as `row`. A chapter is held by a day row of
 * that chapter. A part with no chapter (a note, "Ch. 1–3") is held by any day row of the resource, since the days may
 * put the part in their own words or cut it smaller, as an item-less practice row holds its whole source (`holds`);
 * only a day row whose note is another of the week's reserved parts of that resource word for word is that part's.
 */
function reads(days: PlanNode[], row: CoverRef, reserved: readonly CoverRef[]): boolean {
  const rows = days.flatMap((d) => d.materials ?? []).filter((m) => m.id === row.id);
  if (row.chapter) return rows.some((m) => m.chapter === row.chapter);
  const others = new Set(reserved.filter((c) => c !== row && c.id === row.id && !c.chapter && norm(c.note) !== norm(row.note)).map((c) => norm(c.note)));
  return rows.some((m) => !m.chapter && (norm(m.note) === norm(row.note) || !others.has(norm(m.note))));
}

const practiceMinutes = (day: PlanNode) => (day.practice ?? []).reduce((sum, r) => sum + r.minutes, 0);
const readingMinutes = (day: PlanNode) => (day.materials ?? []).reduce((sum, m) => sum + (m.minutes ?? 0), 0);

/** The first day with the least `minutes`: ties go to the earliest. */
function lightest(days: PlanNode[], minutes: (day: PlanNode) => number): PlanNode {
  return days.reduce((best, d) => (minutes(d) < minutes(best) ? d : best));
}

/**
 * The safety net for a week split into days: the learner's own rows are in the plan, so none may be lost when the model
 * skips one. `parent` holds them as reservations: its imported practice rows (`practiceCovers`) and its must reading
 * (`covers`). Each one no day holds is appended, as it was, to the day with the least practice (or reading) time; the
 * day is chosen again after each row, so several spread out. Returns the days (copies; the input is untouched) and how
 * many rows were appended. A parent with no such rows, or no days, changes nothing.
 */
export function coverImportedRows(parent: PlanNode, days: PlanNode[]): { days: PlanNode[]; appended: number } {
  const out = days.map((d) => ({ ...d, ...(d.practice ? { practice: [...d.practice] } : {}), ...(d.materials ? { materials: [...d.materials] } : {}) }));
  if (out.length === 0) return { days: out, appended: 0 };
  let appended = 0;
  for (const row of (parent.practiceCovers ?? []).filter((c) => c.imported === true)) {
    // A sourceless row with no task has nothing to find a day's row by, so it is left as the days have it.
    if (row.id === null && !row.task?.trim()) continue;
    if (holds(out, row)) continue;
    const ref: PracticeRef = {
      format: row.format,
      id: row.id,
      task: row.task ?? "",
      done: PRACTICE_REGISTRY[row.format].doneWhen,
      minutes: row.minutes ?? 1,
      generated: false,
      ...(row.itemFrom && row.itemTo ? { itemFrom: row.itemFrom, itemTo: row.itemTo } : {}),
      imported: true,
    };
    const day = lightest(out, practiceMinutes);
    day.practice = [...(day.practice ?? []), ref];
    appended++;
  }
  for (const row of (parent.covers ?? []).filter((c) => c.tier === "must")) {
    if (reads(out, row, parent.covers ?? [])) continue;
    const ref: MaterialRef = { id: row.id, tier: "must", minutes: row.minutes ?? null, note: row.note, ...(row.chapter ? { chapter: row.chapter } : {}), ...(row.activity ? { activity: row.activity } : {}) };
    const day = lightest(out, readingMinutes);
    day.materials = [...(day.materials ?? []), ref];
    appended++;
  }
  return { days: out, appended };
}

/**
 * The time of an imported week split into days, from its own reservations: its must reading's minutes and each format's
 * rows' minutes. Stated on the week, it is what its days share, so the plan-wide split never re-budgets the learner's
 * week: a format the week holds no rows of gets none. Must reading the file gave no minutes takes what is left of the
 * week's budget (`budgetHours`, else the plan's weekly hours) after the rest. Call it once `covers` and `practiceCovers`
 * hold the week's rows.
 */
export function splitWeekTime(week: PlanNode, hoursPerWeek?: number): UnitTime {
  const practice: Partial<Record<PracticeFormat, number>> = {};
  for (const c of week.practiceCovers ?? []) practice[c.format] = Math.min(MAX_UNIT_MINUTES, (practice[c.format] ?? 0) + (c.minutes ?? 0));
  const must = (week.covers ?? []).filter((c) => c.tier === "must");
  let reading = must.reduce((sum, c) => sum + (c.minutes ?? 0), 0);
  if (must.some((c) => c.minutes === null || c.minutes === undefined)) {
    const budget = (week.budgetHours ?? budgetFor(1, hoursPerWeek)) * 60;
    const taken = reading + Object.values(practice).reduce((sum, m) => sum + (m ?? 0), 0);
    reading += Math.max(0, budget - taken);
  }
  return { reading: Math.min(MAX_UNIT_MINUTES, reading), practice };
}
