/**
 * The free monthly allowance: what Pensieve pays for each user, in credits of a cent. Pure and dependency-free, since
 * the client imports it too (the out-of-credits alert and `readNdjson`). Spending comes from `generation_log`.
 */

/** The month's allowance in USD of model cost, the same for every user. */
export const MONTHLY_FREE_CREDIT_USD = 5;
/** 1 credit = $0.01, so the allowance is 500 credits. */
export const CREDITS_PER_USD = 100;
/** The code a refused draft or chat turn travels with. Not a `KeyErrorKind`: those are about the user's own key. */
export const OUT_OF_CREDITS = "out_of_credits" as const;

/** 00:00 UTC on `day` of the month `months` after `year`/`month`, or that month's last day when it is shorter. */
function onDay(year: number, month: number, day: number, months: number): Date {
  const lastDay = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month + months, Math.min(day, lastDay)));
}

/**
 * The credit period `now` falls in. Periods start at 00:00 UTC on the day of the month the user signed up and run a
 * month; in a month without that day they turn on its last day. The allowance resets, and any negative balance is
 * wiped, at `end`.
 */
export function creditPeriod(signedUpAt: Date, now: Date): { start: Date; end: Date } {
  const year = signedUpAt.getUTCFullYear();
  const month = signedUpAt.getUTCMonth();
  const day = signedUpAt.getUTCDate();
  let n = Math.max(0, (now.getUTCFullYear() - year) * 12 + now.getUTCMonth() - month);
  if (n > 0 && onDay(year, month, day, n) > now) n -= 1;
  return { start: onDay(year, month, day, n), end: onDay(year, month, day, n + 1) };
}

/** 00:00 UTC on the 1st of `now`'s month. The anchor to fall back on when a user's signup date can't be had. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Whole credits left, rounded down and never below zero. Rounded first so float error never costs a credit. */
export function creditsLeft(spentUsd: number, allowanceUsd: number = MONTHLY_FREE_CREDIT_USD): number {
  const exact = Math.round((allowanceUsd - spentUsd) * CREDITS_PER_USD * 1e6) / 1e6;
  return Math.max(0, Math.floor(exact));
}

/** A reset date as the app shows it: "1 Dec". */
export function formatReset(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
