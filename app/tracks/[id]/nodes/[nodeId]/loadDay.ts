import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { getTrackDetail, sourceToMaterial } from "@/lib/db/queries";
import { getLeafWithContent, getNodeReadList } from "@/lib/db/planQueries";
import { findNode } from "@/lib/planTree";
import { byTier, practiceRowsFor, type ReadRow } from "@/components/pensieve/ReadTable";
import { chapterAt } from "@/lib/schemas/material";
import { dayTasks } from "@/lib/dayTasks";

/**
 * A day or week leaf with everything assigned to it, or null when it is not a leaf of this track. The page and the
 * lesson writer both read the day's tasks from here, so a step can only name a task the page shows.
 */
export async function loadDay(trackId: string, nodeId: string, userId: string) {
  const [detail, leaf, trackSources] = await Promise.all([
    getTrackDetail(trackId, userId),
    getLeafWithContent(nodeId, userId),
    db.query.sources.findMany({ where: eq(sources.trackId, trackId) }),
  ]);
  if (!detail || !leaf || leaf.node.trackId !== trackId) return null;
  const node = findNode(detail.root, nodeId);
  if (!node || node.children !== null) return null;

  const readList = await getNodeReadList(nodeId);
  const readRows: ReadRow[] = readList
    .map((r): ReadRow => {
      const material = sourceToMaterial(r.source);
      return { material, tier: r.tier ?? "should", minutes: r.minutes, note: r.note, chapter: chapterAt(material.toc, r.chapter || null), activity: r.activity, key: `${material.id}#${r.chapter}` };
    })
    .sort(byTier);
  const trackMaterials = new Map(trackSources.map((s) => [s.id, sourceToMaterial(s)]));
  const practiceRows = practiceRowsFor(node.practice, trackMaterials);

  return { detail, leaf, node, trackSources, readRows, practiceRows, tasks: dayTasks(readRows, practiceRows) };
}
