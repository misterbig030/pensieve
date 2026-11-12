import { isImportedRow } from "@/lib/materials";
import { PRACTICE_REGISTRY } from "@/lib/practice";
import type { PlanNode } from "@/lib/planTree";
import type { CoverRef, MaterialRef, PracticeCover, PracticeRef } from "@/lib/schemas/material";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** The item run a row takes, or null when it names none. */
function runOf(r: { itemFrom?: number | null; itemTo?: number | null }): [number, number] | null {
  return r.itemFrom && r.itemTo ? [r.itemFrom, r.itemTo] : null;
}

/**
 * Whether some day holds the imported reservation `row`. A sourced row is held by a day row of its format and source
 * whose items overlap its own (any such row, when it names no items); a sourceless row by a day row of its format with
 * its task, or one that starts with the first 24 characters of it (`isImportedRow`, as the drafts are marked).
 */
function holds(days: PlanNode[], row: PracticeCover): boolean {
  const rows = days.flatMap((d) => d.practice ?? []).filter((r) => r.format === row.format);
  if (row.id === null) return rows.some((r) => isImportedRow(r, row));
  const want = runOf(row);
  return rows.some((r) => {
    if (r.id !== row.id) return false;
    const got = runOf(r);
    return !want || (got !== null && got[0] <= want[1] && want[0] <= got[1]);
  });
}

/** Whether some day's Read table holds the same part of the same resource as `row`: its chapter, or else its note. */
function reads(days: PlanNode[], row: CoverRef): boolean {
  return days
    .flatMap((d) => d.materials ?? [])
    .some((m) => m.id === row.id && (row.chapter ? m.chapter === row.chapter : !m.chapter && norm(m.note) === norm(row.note)));
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
    if (reads(out, row)) continue;
    const ref: MaterialRef = { id: row.id, tier: "must", minutes: row.minutes ?? null, note: row.note, ...(row.chapter ? { chapter: row.chapter } : {}), ...(row.activity ? { activity: row.activity } : {}) };
    const day = lightest(out, readingMinutes);
    day.materials = [...(day.materials ?? []), ref];
    appended++;
  }
  return { days: out, appended };
}
