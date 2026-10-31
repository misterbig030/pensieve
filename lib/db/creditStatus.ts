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
}

/** What Settings and the top bar show: credits left this month, and whether they apply to this user at all. */
export async function getCreditStatus(userId: string, now: Date = new Date()): Promise<CreditStatus> {
  const [spent, keys] = await Promise.all([getAppSpendUsd(userId, monthStart(now)), getUserApiKeys(userId)]);
  return {
    left: creditsLeft(spent),
    allowance: MONTHLY_FREE_CREDIT_USD * CREDITS_PER_USD,
    resetsAt: nextReset(now),
    keyCoversAll: keyCoversAll(keys.map((k) => k.provider)),
  };
}
