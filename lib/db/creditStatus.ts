import { cache } from "react";
import { isAdminUserId } from "@/lib/admin";
import { keyCoversAll } from "@/lib/ai/resolve";
import { CREDITS_PER_USD, creditsLeft, MONTHLY_FREE_CREDIT_USD, monthStart, nextReset } from "@/lib/credits";
import { getAppSpendUsd } from "./credits";
import { getUserApiKeys } from "./userApiKeys";

export interface CreditStatus {
  left: number;
  allowance: number;
  resetsAt: Date;
  /** The user's own key pays for every role, so credits only move if a call runs on Pensieve's key. */
  keyCoversAll: boolean;
  /** New drafts and chat turns are refused now: none left, and neither the user's key nor admin rights exempt them. */
  paused: boolean;
}

/** What Settings and the top bar show: credits left this month, and whether they apply to this user at all. */
export async function getCreditStatus(userId: string, now: Date = new Date()): Promise<CreditStatus> {
  const [spent, keys] = await Promise.all([getAppSpendUsd(userId, monthStart(now)), getUserApiKeys(userId)]);
  const left = creditsLeft(spent);
  const covered = keyCoversAll(keys.map((k) => k.provider));
  return {
    left,
    allowance: MONTHLY_FREE_CREDIT_USD * CREDITS_PER_USD,
    resetsAt: nextReset(now),
    keyCoversAll: covered,
    paused: left === 0 && !covered && !isAdminUserId(userId),
  };
}

/** `getCreditStatus` now, once per request: the top bar and Settings render in the same request and share it. */
export const creditStatusFor = cache((userId: string) => getCreditStatus(userId));
