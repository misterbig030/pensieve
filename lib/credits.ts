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

/** 00:00 UTC on the 1st of `now`'s UTC month: where this month's spending starts. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** 00:00 UTC on the 1st of the next UTC month, when the allowance resets and any negative balance is wiped. */
export function nextReset(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
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
