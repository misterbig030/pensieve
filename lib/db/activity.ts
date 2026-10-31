import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "./client";
import { checkIns, planNodes, tracks } from "./schema";
import type { PlanLevel } from "@/lib/planTree";
import type { CheckIn } from "@/lib/trackProgress";

/** A check-in with what it was for: the plan node and its track. */
export interface CheckInRow extends CheckIn {
  nodeTitle: string;
  nodeLevel: PlanLevel;
  trackId: string;
  trackTitle: string;
}

async function checkInRows(where: SQL | undefined): Promise<CheckInRow[]> {
  return db
    .select({
      nodeId: checkIns.nodeId,
      nodeTitle: planNodes.title,
      nodeLevel: planNodes.level,
      trackId: tracks.id,
      trackTitle: tracks.title,
      completedAt: checkIns.completedAt,
      hours: checkIns.hours,
    })
    .from(checkIns)
    .innerJoin(planNodes, eq(checkIns.nodeId, planNodes.id))
    .innerJoin(tracks, eq(planNodes.trackId, tracks.id))
    .where(where)
    .orderBy(desc(checkIns.completedAt));
}

/** Every check-in on the user's tracks, newest first. */
export async function getUserCheckIns(userId: string): Promise<CheckInRow[]> {
  return checkInRows(eq(tracks.userId, userId));
}

/** One track's check-ins, newest first; none when the track isn't the user's. */
export async function getTrackCheckIns(trackId: string, userId: string): Promise<CheckInRow[]> {
  return checkInRows(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
}
