import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "./client";
import { tracks, sources, planNodes, checkIns, type NewSource, type Source } from "./schema";
import { getTrackNodeMaterials, getTrackNodePractice, insertPlanTree, rowsToTree } from "./planQueries";
import { getUserCheckIns, type CheckInRow } from "./activity";
import { numberedToc, remapTreeRefs } from "@/lib/materials";
import { type Granularity, type PlanNode } from "@/lib/planTree";
import { clip, type Material } from "@/lib/schemas/material";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK, clampHours, type PlanSplit } from "@/lib/studyTime";

export async function getTracksForUser(userId: string) {
  return db.query.tracks.findMany({
    where: eq(tracks.userId, userId),
    orderBy: [asc(tracks.createdAt)],
  });
}

export interface DashboardTrack {
  track: Awaited<ReturnType<typeof getTracksForUser>>[number];
  root: PlanNode;
  /** The track's check-ins, newest first. */
  checkIns: CheckInRow[];
}

/** Batches every track's plan tree and check-ins for the home page, avoiding an N+1 query per track. */
export async function getDashboardTracksForUser(userId: string): Promise<DashboardTrack[]> {
  const userTracks = await getTracksForUser(userId);
  if (userTracks.length === 0) return [];

  const trackIds = userTracks.map((t) => t.id);
  const [nodeRows, checkInRows] = await Promise.all([
    db.query.planNodes.findMany({ where: inArray(planNodes.trackId, trackIds) }),
    getUserCheckIns(userId),
  ]);

  return userTracks.map((track) => ({
    track,
    root: rowsToTree(nodeRows.filter((n) => n.trackId === track.id)),
    checkIns: checkInRows.filter((c) => c.trackId === track.id),
  }));
}

export async function getTrackDetail(trackId: string, userId: string) {
  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, trackId), eq(tracks.userId, userId)),
  });
  if (!track) return null;

  const [nodeRows, trackSources, materialRows, practiceRows] = await Promise.all([
    db.query.planNodes.findMany({ where: eq(planNodes.trackId, trackId) }),
    db.query.sources.findMany({ where: eq(sources.trackId, trackId), orderBy: [asc(sources.position)] }),
    getTrackNodeMaterials(trackId),
    getTrackNodePractice(trackId),
  ]);

  return { track, root: rowsToTree(nodeRows, materialRows, practiceRows), materials: trackSources.map(sourceToMaterial) };
}

/**
 * A saved source as the browser's material shape. Its id is the row's uuid; saved rows need no signature. Text is
 * clipped to the wire limits: notes saved before materials existed kept free text of any length in `url`.
 */
export function sourceToMaterial(row: Source): Material {
  return {
    id: row.id,
    origin: row.origin,
    type: row.type,
    kind: row.kind,
    url: row.url.length > 2000 ? row.url.slice(0, 2000) : row.url,
    title: clip(row.title, 300) ?? clip(row.url, 300) ?? "Untitled",
    author: row.author,
    year: row.year,
    why: row.why,
    backbone: row.backbone,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    fetchedTitle: row.fetchedTitle,
    recommendedBy: row.recommendedBy ?? [],
    sig: null,
    minutes: row.minutes,
    minutesBasis: row.minutesBasis,
    uses: row.uses,
    toc: numberedToc(row.toc ?? null, row.uses, row.kind),
    practice: row.practice ?? null,
  };
}

/**
 * Source rows for a materials list, with a fresh uuid per material and the map from each material's id (a short id
 * while drafting) to it. At most one backbone survives, and only a book can be one.
 */
export function materialsToRows(trackId: string, materials: Material[]): { rows: NewSource[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  let backboneTaken = false;
  const rows = materials.map((m, position): NewSource => {
    const id = crypto.randomUUID();
    ids.set(m.id, id);
    const backbone = m.backbone && m.kind === "book" && !backboneTaken;
    if (backbone) backboneTaken = true;
    return {
      id,
      trackId,
      type: m.type,
      url: m.url,
      title: m.title,
      origin: m.origin,
      kind: m.kind,
      backbone,
      author: m.author,
      year: m.year,
      why: m.why,
      position,
      verifiedAt: m.verifiedAt ? new Date(m.verifiedAt) : null,
      fetchedTitle: m.fetchedTitle,
      recommendedBy: m.recommendedBy,
      minutes: m.minutes ?? null,
      minutesBasis: m.minutes ? (m.minutesBasis ?? "estimated") : null,
      uses: m.uses ?? null,
      toc: m.toc ?? null,
      practice: m.practice ?? null,
    };
  });
  return { rows, ids };
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

export async function createTrackWithPlan(input: {
  userId: string;
  title: string;
  description?: string;
  instructions?: string;
  summary?: string;
  granularity: Granularity;
  hoursPerWeek?: number;
  daysPerWeek?: number;
  split?: PlanSplit | null;
  /** Already vetted (signatures checked). Node references use these materials' ids. */
  materials: Material[];
  root: PlanNode;
}): Promise<{ trackId: string; droppedRefs: number }> {
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
        hoursPerWeek: clampHours(input.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK),
        daysPerWeek: input.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK,
        split: input.split ?? null,
        status: "active",
      })
      .returning({ id: tracks.id });

    // Short ids become uuids here; a reference to an id not in the list is dropped (and counted).
    const { rows, ids } = materialsToRows(track.id, input.materials);
    if (rows.length > 0) await tx.insert(sources).values(rows);
    const { root, dropped } = remapTreeRefs(input.root, ids);

    await insertPlanTree(tx, track.id, root, new Set(ids.values()));

    return { trackId: track.id, droppedRefs: dropped };
  });
}

/** Stores the plan summary shown on the track page. Recomputed whenever the plan changes. */
export async function updateTrackSummary(trackId: string, userId: string, summary: string): Promise<void> {
  await db
    .update(tracks)
    .set({ summary })
    .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
}

/** Saves the learner's weekly hours, usual days a week and the plan's time split, as the adjust page left them. */
export async function updateTrackStudyTime(
  trackId: string,
  userId: string,
  time: { hoursPerWeek: number; daysPerWeek?: number; split: PlanSplit | null },
): Promise<void> {
  await db
    .update(tracks)
    .set({ hoursPerWeek: clampHours(time.hoursPerWeek), split: time.split, ...(time.daysPerWeek !== undefined ? { daysPerWeek: time.daysPerWeek } : {}) })
    .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
}
