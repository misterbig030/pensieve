import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "./client";
import { tracks, sources, planNodes, checkIns, type NewSource } from "./schema";
import { insertPlanTree, rowsToTree } from "./planQueries";
import { doneDays, type Granularity, type PlanNode } from "@/lib/planTree";

export async function getTracksForUser(userId: string) {
  return db.query.tracks.findMany({
    where: eq(tracks.userId, userId),
    orderBy: [asc(tracks.createdAt)],
  });
}

export interface DashboardTrack {
  track: Awaited<ReturnType<typeof getTracksForUser>>[number];
  total: number;
  done: number;
  checkInDates: Date[];
}

/** Batches per-track progress and check-in dates for the dashboard, avoiding an N+1 query per track. */
export async function getDashboardTracksForUser(userId: string): Promise<DashboardTrack[]> {
  const userTracks = await getTracksForUser(userId);
  if (userTracks.length === 0) return [];

  const trackIds = userTracks.map((t) => t.id);

  const nodeRows = await db.query.planNodes.findMany({ where: inArray(planNodes.trackId, trackIds) });

  const checkInRows = await db
    .select({ trackId: planNodes.trackId, completedAt: checkIns.completedAt })
    .from(checkIns)
    .innerJoin(planNodes, eq(checkIns.nodeId, planNodes.id))
    .where(inArray(planNodes.trackId, trackIds));

  return userTracks.map((track) => {
    const root = rowsToTree(nodeRows.filter((n) => n.trackId === track.id));
    return {
      track,
      total: root.len,
      done: doneDays(root),
      checkInDates: checkInRows.filter((c) => c.trackId === track.id).map((c) => c.completedAt),
    };
  });
}

export async function getTrackDetail(trackId: string, userId: string) {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
  });
  if (!track) return null;

  const [nodeRows, trackSources] = await Promise.all([
    db.query.planNodes.findMany({ where: eq(planNodes.trackId, trackId) }),
    db.query.sources.findMany({ where: eq(sources.trackId, trackId) }),
  ]);

  return { track, root: rowsToTree(nodeRows), sources: trackSources };
}

export async function getCheckInDatesForUser(userId: string): Promise<Date[]> {
  const rows = await db
    .select({ completedAt: checkIns.completedAt })
    .from(checkIns)
    .innerJoin(planNodes, eq(checkIns.nodeId, planNodes.id))
    .innerJoin(tracks, eq(planNodes.trackId, tracks.id))
    .where(eq(tracks.userId, userId));
  return rows.map((r) => r.completedAt);
}

export async function getCheckInDatesForTrack(trackId: string, userId: string): Promise<Date[]> {
  const rows = await db
    .select({ completedAt: checkIns.completedAt })
    .from(checkIns)
    .innerJoin(planNodes, eq(checkIns.nodeId, planNodes.id))
    .innerJoin(tracks, eq(planNodes.trackId, tracks.id))
    .where(and(eq(planNodes.trackId, trackId), eq(tracks.userId, userId)));
  return rows.map((r) => r.completedAt);
}

export async function createTrackWithPlan(input: {
  userId: string;
  title: string;
  description?: string;
  instructions?: string;
  summary?: string;
  granularity: Granularity;
  sources: Omit<NewSource, "id" | "trackId">[];
  root: PlanNode;
}): Promise<{ trackId: string }> {
  return db.transaction(async (tx) => {
    const [track] = await tx
      .insert(tracks)
      .values({
        userId: input.userId,
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        summary: input.summary,
        granularity: input.granularity,
        status: "active",
      })
      .returning({ id: tracks.id });

    if (input.sources.length > 0) {
      await tx.insert(sources).values(input.sources.map((s) => ({ ...s, trackId: track.id })));
    }

    await insertPlanTree(tx, track.id, input.root);

    return { trackId: track.id };
  });
}

/** Stores the plan summary shown on the track page. Recomputed whenever the plan changes. */
export async function updateTrackSummary(trackId: string, userId: string, summary: string): Promise<void> {
  await db
    .update(tracks)
    .set({ summary })
    .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
}
