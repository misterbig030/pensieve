import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "./client";
import {
  tracks,
  sources,
  outlineItems,
  dailyContent,
  checkIns,
  type NewSource,
} from "./schema";

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

  const itemRows = await db
    .select({ trackId: outlineItems.trackId, status: outlineItems.status })
    .from(outlineItems)
    .where(inArray(outlineItems.trackId, trackIds));

  const checkInRows = await db
    .select({ trackId: outlineItems.trackId, completedAt: checkIns.completedAt })
    .from(checkIns)
    .innerJoin(outlineItems, eq(checkIns.outlineItemId, outlineItems.id))
    .where(inArray(outlineItems.trackId, trackIds));

  return userTracks.map((track) => {
    const items = itemRows.filter((i) => i.trackId === track.id);
    return {
      track,
      total: items.length,
      done: items.filter((i) => i.status === "completed").length,
      checkInDates: checkInRows.filter((c) => c.trackId === track.id).map((c) => c.completedAt),
    };
  });
}

export async function getTrackDetail(trackId: string, userId: string) {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
  });
  if (!track) return null;

  const items = await db.query.outlineItems.findMany({
    where: eq(outlineItems.trackId, trackId),
    orderBy: [asc(outlineItems.dayIndex)],
  });
  const trackSources = await db.query.sources.findMany({
    where: eq(sources.trackId, trackId),
  });

  return { track, items, sources: trackSources };
}

export async function getOutlineItemWithContent(outlineItemId: string, userId: string) {
  const item = await db.query.outlineItems.findFirst({
    where: eq(outlineItems.id, outlineItemId),
    with: { track: true },
  });
  if (!item || item.track.userId !== userId) return null;

  const content = await db.query.dailyContent.findFirst({
    where: eq(dailyContent.outlineItemId, outlineItemId),
  });

  return { item, content: content ?? null };
}

export async function getCheckInDatesForUser(userId: string): Promise<Date[]> {
  const rows = await db
    .select({ completedAt: checkIns.completedAt })
    .from(checkIns)
    .innerJoin(outlineItems, eq(checkIns.outlineItemId, outlineItems.id))
    .innerJoin(tracks, eq(outlineItems.trackId, tracks.id))
    .where(eq(tracks.userId, userId));
  return rows.map((r) => r.completedAt);
}

export async function getCheckInDatesForTrack(trackId: string, userId: string): Promise<Date[]> {
  const rows = await db
    .select({ completedAt: checkIns.completedAt })
    .from(checkIns)
    .innerJoin(outlineItems, eq(checkIns.outlineItemId, outlineItems.id))
    .innerJoin(tracks, eq(outlineItems.trackId, tracks.id))
    .where(and(eq(outlineItems.trackId, trackId), eq(tracks.userId, userId)));
  return rows.map((r) => r.completedAt);
}

export async function createTrackWithOutline(input: {
  userId: string;
  title: string;
  description?: string;
  instructions?: string;
  sources: Omit<NewSource, "id" | "trackId">[];
  items: { dayIndex: number; title: string; summary: string }[];
}): Promise<{ trackId: string }> {
  return db.transaction(async (tx) => {
    const [track] = await tx
      .insert(tracks)
      .values({
        userId: input.userId,
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        status: "active",
      })
      .returning({ id: tracks.id });

    if (input.sources.length > 0) {
      await tx.insert(sources).values(
        input.sources.map((s) => ({ ...s, trackId: track.id })),
      );
    }

    await tx.insert(outlineItems).values(
      input.items.map((item) => ({ ...item, trackId: track.id })),
    );

    return { trackId: track.id };
  });
}

export async function replaceUnfinishedOutlineItems(
  trackId: string,
  userId: string,
  newItems: { dayIndex: number; title: string; summary: string }[],
): Promise<void> {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
  });
  if (!track) throw new Error("Track not found for this user");

  await db.transaction(async (tx) => {
    const unfinished = await tx.query.outlineItems.findMany({
      where: and(eq(outlineItems.trackId, trackId), ne(outlineItems.status, "completed")),
    });
    const unfinishedIds = unfinished.map((i) => i.id);

    if (unfinishedIds.length > 0) {
      await tx.delete(dailyContent).where(inArray(dailyContent.outlineItemId, unfinishedIds));
      await tx.delete(outlineItems).where(inArray(outlineItems.id, unfinishedIds));
    }

    if (newItems.length > 0) {
      await tx.insert(outlineItems).values(
        newItems.map((item) => ({ ...item, trackId })),
      );
    }
  });
}

export async function upsertDailyContent(
  outlineItemId: string,
  content: { contentMarkdown: string; citations: unknown; model: string },
): Promise<void> {
  await db
    .insert(dailyContent)
    .values({ outlineItemId, ...content })
    .onConflictDoUpdate({
      target: dailyContent.outlineItemId,
      set: {
        contentMarkdown: content.contentMarkdown,
        citations: content.citations,
        model: content.model,
        generatedAt: new Date(),
      },
    });

  await db
    .update(outlineItems)
    .set({ status: "generated" })
    .where(and(eq(outlineItems.id, outlineItemId), ne(outlineItems.status, "completed")));
}

export async function markOutlineItemComplete(
  outlineItemId: string,
  userId: string,
): Promise<{ trackId: string }> {
  const item = await db.query.outlineItems.findFirst({
    where: eq(outlineItems.id, outlineItemId),
    with: { track: true },
  });
  if (!item || item.track.userId !== userId) throw new Error("Outline item not found for this user");

  await db.transaction(async (tx) => {
    if (item.status === "completed") {
      // Already completed — no-op to keep this call idempotent and avoid
      // inserting duplicate check-in rows on repeated calls.
      return;
    }
    await tx.insert(checkIns).values({ outlineItemId });
    await tx.update(outlineItems).set({ status: "completed" }).where(eq(outlineItems.id, outlineItemId));
  });

  return { trackId: item.track.id };
}
