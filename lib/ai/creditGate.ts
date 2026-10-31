/**
 * The free monthly allowance's one check, made by the routes that start something new (a plan draft, a chat turn)
 * before any model call. Continuing work (expands, lessons) is never checked; an action that started always finishes.
 */
import { isAdminUserId } from "@/lib/admin";
import { creditsLeft, monthStart, nextReset, OUT_OF_CREDITS } from "@/lib/credits";
import { getAppSpendUsd } from "@/lib/db/credits";
import type { ResolvedModel } from "./resolve";

/**
 * A 402 to return instead of starting, or null to go ahead. Skipped when every role runs on the user's own key, and
 * for admins. Refuses below one whole credit, so a user who sees "0" is always refused.
 */
export async function creditRefusal(userId: string, roles: readonly ResolvedModel[], now: Date = new Date()): Promise<Response | null> {
  if (roles.every((r) => r.keyOwner === "user") || isAdminUserId(userId)) return null;
  const spent = await getAppSpendUsd(userId, monthStart(now));
  if (creditsLeft(spent) >= 1) return null;
  return Response.json({ code: OUT_OF_CREDITS, resetsAt: nextReset(now).toISOString() }, { status: 402 });
}
