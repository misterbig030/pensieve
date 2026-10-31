import { and, eq, gte, sum } from "drizzle-orm";
import { db } from "./client";
import { generationLog } from "./schema";

/** What Pensieve's key paid for this user's calls since `since`, in USD. Calls on their own key are theirs to pay. */
export async function getAppSpendUsd(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sum(generationLog.costUsd) })
    .from(generationLog)
    .where(and(eq(generationLog.userId, userId), eq(generationLog.keyOwner, "app"), gte(generationLog.createdAt, since)));
  return Number(row?.total ?? 0);
}
