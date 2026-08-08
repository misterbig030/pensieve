import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { outlineItems, tracks, sources, dailyContent } from "@/lib/db/schema";
import { DailyContentView } from "./DailyContentView";

export default async function DayPage({
  params,
}: {
  params: Promise<{ id: string; dayIndex: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id, dayIndex } = await params;

  const track = await db.query.tracks.findFirst({
    where: and(eq(tracks.id, id), eq(tracks.userId, userId)),
  });
  if (!track) notFound();

  const item = await db.query.outlineItems.findFirst({
    where: and(eq(outlineItems.trackId, id), eq(outlineItems.dayIndex, Number(dayIndex))),
  });
  if (!item) notFound();

  const content = await db.query.dailyContent.findFirst({
    where: eq(dailyContent.outlineItemId, item.id),
  });
  const trackSources = await db.query.sources.findMany({ where: eq(sources.trackId, id) });
  const youtubeSources = trackSources.filter((s) => s.type === "youtube");

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Day {item.dayIndex}: {item.title}</h1>
      <p className="text-sm text-muted-foreground">{item.summary}</p>
      <DailyContentView
        trackId={id}
        dayIndex={item.dayIndex}
        outlineItemId={item.id}
        initialContent={
          content
            ? { contentMarkdown: content.contentMarkdown, citations: content.citations as { title: string; url: string }[], model: content.model }
            : null
        }
        youtubeSources={youtubeSources}
        isCompleted={item.status === "completed"}
      />
    </div>
  );
}
