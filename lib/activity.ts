/**
 * Study activity by calendar: weeks, the activity grid and monthly totals. Days are UTC days, the same boundary the
 * streak uses (`lib/streak.ts`), so every figure agrees with it. Weeks run Monday to Sunday.
 */

import { dayKey } from "@/lib/streak";

/** A unit of study at a moment: a finished day (its planned time) or a logged week session (its hours). */
export interface StudyEvent {
  at: Date;
  hours: number;
}

const DAY_MS = 86_400_000;

/** Monday 00:00 UTC of the week `today` falls in. */
export function weekStart(today: Date): Date {
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY_MS);
}

/** The seven day keys of this week, Monday first. */
export function thisWeekKeys(today: Date): string[] {
  const monday = weekStart(today).getTime();
  return Array.from({ length: 7 }, (_, i) => dayKey(new Date(monday + i * DAY_MS)));
}

/** Check-ins per day for the last `weeks` weeks, oldest week first, each Monday first. Days after today are -1. */
export function heatmapWeeks(dates: Date[], today: Date, weeks = 12): number[][] {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(dayKey(d), (counts.get(dayKey(d)) ?? 0) + 1);
  const todayKey = dayKey(today);
  const first = weekStart(today).getTime() - (weeks - 1) * 7 * DAY_MS;
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const key = dayKey(new Date(first + (w * 7 + d) * DAY_MS));
      return key > todayKey ? -1 : (counts.get(key) ?? 0);
    }),
  );
}

/** Sessions and hours in today's UTC calendar month, hours to the nearest half. */
export function monthTotals(events: StudyEvent[], today: Date): { sessions: number; hours: number } {
  const month = dayKey(today).slice(0, 7);
  const inMonth = events.filter((e) => dayKey(e.at).startsWith(month));
  const hours = inMonth.reduce((sum, e) => sum + e.hours, 0);
  return { sessions: inMonth.length, hours: Math.round(hours * 2) / 2 };
}
