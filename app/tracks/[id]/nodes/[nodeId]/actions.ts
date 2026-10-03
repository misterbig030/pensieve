"use server";

import { auth } from "@clerk/nextjs/server";
import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { generateDailyContent, type LessonMaterial } from "@/lib/ai/dailyContent";
import { getNodeReadList, getOwnedNode, upsertLeafContent } from "@/lib/db/planQueries";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { DEFAULT_CONTENT_MODEL } from "@/lib/ai/models";

export async function generateLeafContentAction(input: {
  trackId: string;
  nodeId: string;
}): Promise<{ contentMarkdown: string; citations: { title: string; url: string }[]; costUsd: number }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const node = await getOwnedNode(input.nodeId, userId);
  if (!node || node.trackId !== input.trackId) throw new Error("Plan node not found");

  // The lesson reads the leaf's Read table. Plans saved before materials were assigned fall back to the whole list.
  const reads = await getNodeReadList(node.id);
  const materials: LessonMaterial[] =
    reads.length > 0
      ? reads.map((r) => ({
          title: r.source.title ?? r.source.url,
          url: r.source.url,
          type: r.source.type,
          kind: r.source.kind,
          tier: r.tier,
          minutes: r.minutes,
          note: r.note,
        }))
      : (await db.query.sources.findMany({ where: eq(sources.trackId, input.trackId), orderBy: [asc(sources.position)] })).map((s) => ({
          title: s.title ?? s.url,
          url: s.url,
          type: s.type,
          kind: s.kind,
        }));

  const { content, costUsd } = await generateDailyContent({
    title: node.title,
    summary: node.summary,
    unit: node.level === "day" ? "day" : "week",
    spanDays: node.len,
    materials,
    log: { trackId: input.trackId, userId, onLog: insertGenerationLog },
  });

  await upsertLeafContent(node.id, {
    contentMarkdown: content.contentMarkdown,
    citations: content.citations,
    model: DEFAULT_CONTENT_MODEL,
  });

  revalidatePath(`/tracks/${input.trackId}`);
  revalidatePath(`/tracks/${input.trackId}/nodes/${input.nodeId}`);

  return { ...content, costUsd };
}
