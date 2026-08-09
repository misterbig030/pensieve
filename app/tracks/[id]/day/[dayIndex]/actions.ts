"use server";

import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { outlineItems, tracks, sources } from "@/lib/db/schema";
import { generateDailyContent } from "@/lib/ai/dailyContent";
import { upsertDailyContent } from "@/lib/db/queries";
import type { AiModelId } from "@/lib/ai/models";

export async function generateDailyContentAction(input: {
  trackId: string;
  dayIndex: number;
  model: AiModelId;
}): Promise<{ contentMarkdown: string; citations: { title: string; url: string }[]; costUsd: number }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, input.trackId), eq(tracks.userId, userId)),
  });
  if (!track) throw new Error("Track not found");

  const item = await db.query.outlineItems.findFirst({
    where: and(eq(outlineItems.trackId, input.trackId), eq(outlineItems.dayIndex, input.dayIndex)),
  });
  if (!item) throw new Error("Outline item not found");

  const trackSources = await db.query.sources.findMany({ where: eq(sources.trackId, input.trackId) });

  const { content, costUsd } = await generateDailyContent({
    title: item.title,
    summary: item.summary,
    sources: trackSources.map((s) => ({ url: s.url, title: s.title ?? undefined, type: s.type as "link" | "youtube" })),
    model: input.model,
  });

  await upsertDailyContent(item.id, {
    contentMarkdown: content.contentMarkdown,
    citations: content.citations,
    model: input.model,
  });

  revalidatePath(`/tracks/${input.trackId}`);

  return { ...content, costUsd };
}
