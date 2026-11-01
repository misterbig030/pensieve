import { cache } from "react";
import { isAdmin } from "@/lib/admin";
import { keyCoversAll } from "@/lib/ai/resolve";
import { CREDITS_PER_USD, creditPeriod, creditsLeft, MONTHLY_FREE_CREDIT_USD } from "@/lib/credits";
import { getAppSpendUsd } from "./credits";
import { getUserApiKeys } from "./userApiKeys";
import { signedUpAt } from "./users";

export interface CreditStatus {
  left: number;
  allowance: number;
  resetsAt: Date;
  /** The user's own key pays for every role, so credits only move if a call runs on Pensieve's key. */
  keyCoversAll: boolean;
  /** New drafts and chat turns are refused now: none left, and neither the user's key nor admin rights exempt them. */
  paused: boolean;
}

/** What Settings and the top bar show: credits left this period, and whether they apply to this user at all. */
export async function getCreditStatus(userId: string, now: Date = new Date()): Promise<CreditStatus> {
  const period = creditPeriod(await signedUpAt(userId), now);
  const [spent, keys, admin] = await Promise.all([getAppSpendUsd(userId, period.start), getUserApiKeys(userId), isAdmin(userId)]);
  const left = creditsLeft(spent);
  const covered = keyCoversAll(keys.map((k) => k.provider));
  return {
    left,
    allowance: MONTHLY_FREE_CREDIT_USD * CREDITS_PER_USD,
    resetsAt: period.end,
    keyCoversAll: covered,
    paused: left === 0 && !covered && !admin,
  };
}

/** `getCreditStatus` now, once per request: the top bar and Settings render in the same request and share it. */
export const creditStatusFor = cache((userId: string) => getCreditStatus(userId));
