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

/** Rows grouped by the UTC week they fall in, newest week first and newest row first within it. */
export function byWeek<T extends { completedAt: Date }>(rows: T[]): { start: Date; rows: T[] }[] {
  const groups = new Map<number, T[]>();
  for (const row of [...rows].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime())) {
    const start = weekStart(row.completedAt).getTime();
    groups.set(start, [...(groups.get(start) ?? []), row]);
  }
  return [...groups].map(([start, rows]) => ({ start: new Date(start), rows }));
}

/** "Nov 21", by UTC day. */
export function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Friday, 30 Oct", by UTC day. No clock time: a UTC time reads hours off for most learners. */
export function weekdayDate(d: Date): string {
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return `${weekday}, ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
}

/** When something happened, by UTC day: "today", "yesterday", a weekday within the last week, else the date. */
export function relativeDay(d: Date, today: Date): string {
  const days = Math.round((Date.parse(dayKey(today)) - Date.parse(dayKey(d))) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days < 7) return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return shortDate(d);
}

/** Hours as a figure: whole hours as they are, the rest to one decimal. */
export function hoursText(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export interface CalendarDay {
  key: string;
  date: Date;
  /** "before" the track existed and "future" are blank; "empty" is a past day with no check-in. */
  state: "before" | "future" | "studied" | "empty";
  today: boolean;
  /** What was done that day, in time order. */
  titles: string[];
}

export interface CalendarWeek {
  monday: Date;
  /** Monday first. */
  days: CalendarDay[];
}

/**
 * A track's study days on the calendar: from the week it was created, or `weeks - 1` weeks before this one if later,
 * to this week, oldest first. A day with a check-in is studied and names what was done.
 */
export function studyCalendar(rows: { completedAt: Date; nodeTitle: string }[], start: Date, today: Date, weeks = 12): CalendarWeek[] {
  const titles = new Map<string, string[]>();
  for (const row of [...rows].sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime())) {
    const key = dayKey(row.completedAt);
    titles.set(key, [...(titles.get(key) ?? []), row.nodeTitle]);
  }
  const todayKey = dayKey(today);
  const startKey = dayKey(start);
  const last = weekStart(today).getTime();
  const first = Math.max(weekStart(start).getTime(), last - (weeks - 1) * 7 * DAY_MS);
  const count = Math.round((last - first) / (7 * DAY_MS)) + 1;
  return Array.from({ length: count }, (_, w) => {
    const monday = new Date(first + w * 7 * DAY_MS);
    const days = Array.from({ length: 7 }, (_, d): CalendarDay => {
      const date = new Date(monday.getTime() + d * DAY_MS);
      const key = dayKey(date);
      const done = titles.get(key) ?? [];
      const state = key < startKey ? "before" : key > todayKey ? "future" : done.length > 0 ? "studied" : "empty";
      return { key, date, state, today: key === todayKey, titles: done };
    });
    return { monday, days };
  });
}

/** How many distinct UTC dates have a check-in. */
export function studyDates(rows: { completedAt: Date }[]): number {
  return new Set(rows.map((r) => dayKey(r.completedAt))).size;
}

/**
 * A week of check-ins in a line: finished days (no hours) and logged sessions (hours), then the study hours, as
 * "1 day · 2 sessions · 4 h". A count of none is left out.
 */
export function weekTotal(rows: { hours: number | null }[], studyHours: number): string {
  const days = rows.filter((r) => r.hours === null).length;
  const sessions = rows.length - days;
  const parts = [days > 0 && `${days} day${days === 1 ? "" : "s"}`, sessions > 0 && `${sessions} session${sessions === 1 ? "" : "s"}`].filter(Boolean);
  return [...parts, `${hoursText(studyHours)} h`].join(" · ");
}
