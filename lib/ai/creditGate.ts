/**
 * The free monthly allowance's one check, made by the routes that start something new (a plan draft, a chat turn)
 * before any model call. Continuing work (expands, lessons) is never checked; an action that started always finishes.
 */
import { isAdmin } from "@/lib/admin";
import { creditPeriod, creditsLeft, monthStart, OUT_OF_CREDITS } from "@/lib/credits";
import { getAppSpendUsd } from "@/lib/db/credits";
import { signedUpAtFor } from "@/lib/db/users";
import type { ResolvedModel } from "./resolve";

/**
 * A 402 to return instead of starting, or null to go ahead. Skipped when every role runs on the user's own key, and
 * for admins. Refuses below one whole credit, so a user who sees "0" is always refused.
 */
export async function creditRefusal(userId: string, roles: readonly ResolvedModel[], now: Date = new Date()): Promise<Response | null> {
  if (roles.every((r) => r.keyOwner === "user") || (await isAdmin(userId))) return null;
  // Clerk down or slow: this request counts the calendar month rather than failing the draft or chat turn.
  const period = creditPeriod(await signedUpAtFor(userId).catch(() => monthStart(now)), now);
  const spent = await getAppSpendUsd(userId, period.start);
  if (creditsLeft(spent) >= 1) return null;
  return Response.json({ code: OUT_OF_CREDITS, resetsAt: period.end.toISOString() }, { status: 402 });
}
