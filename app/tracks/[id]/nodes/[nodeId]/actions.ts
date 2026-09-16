"use server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { generateDailyContent } from "@/lib/ai/dailyContent";
import { getOwnedNode, upsertLeafContent } from "@/lib/db/planQueries";
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

  const trackSources = await db.query.sources.findMany({ where: eq(sources.trackId, input.trackId) });

  const { content, costUsd } = await generateDailyContent({
    title: node.title,
    summary: node.summary,
    unit: node.level === "day" ? "day" : "week",
    spanDays: node.len,
    sources: trackSources.map((s) => ({ url: s.url, title: s.title ?? undefined, type: s.type })),
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
