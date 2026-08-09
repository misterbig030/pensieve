import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { outlineItems, tracks, sources, dailyContent } from "@/lib/db/schema";
import { PageShell } from "@/components/pensieve/PageShell";
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
    <PageShell>
      <div className="mx-auto max-w-[640px] space-y-5">
        <div className="text-[13px] text-foreground/60">
          <Link href={`/tracks/${id}`} className="hover:text-primary">
            ← {track.title}
          </Link>
        </div>
        <div className="space-y-2 pb-1">
          <span className="text-[10px] tracking-wide text-primary uppercase">Day {item.dayIndex}</span>
          <h1>{item.title}</h1>
          <p className="text-muted-foreground">{item.summary}</p>
        </div>
        <DailyContentView
          trackId={id}
          dayIndex={item.dayIndex}
          outlineItemId={item.id}
          initialContent={
            content
              ? {
                  contentMarkdown: content.contentMarkdown,
                  citations: content.citations as { title: string; url: string }[],
                }
              : null
          }
          youtubeSources={youtubeSources.map((s) => ({ title: s.title, url: s.url }))}
          isCompleted={item.status === "completed"}
        />
      </div>
    </PageShell>
  );
}
