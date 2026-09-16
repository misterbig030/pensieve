import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { getTrackDetail } from "@/lib/db/queries";
import { lockBoundary } from "@/lib/planTree";
import { PageShell } from "@/components/pensieve/PageShell";
import { AdjustPlan } from "./AdjustPlan";

export default async function AdjustTrackPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id } = await params;
  const detail = await getTrackDetail(id, userId);
  if (!detail) notFound();

  return (
    <PageShell wide>
      <AdjustPlan
        trackId={id}
        trackTitle={detail.track.title}
        granularity={detail.track.granularity}
        instructions={detail.track.instructions ?? undefined}
        sources={detail.sources.map((s) => ({ url: s.url, title: s.title ?? undefined, type: s.type }))}
        root={detail.root}
        lockBefore={lockBoundary(detail.root)}
      />
    </PageShell>
  );
}
