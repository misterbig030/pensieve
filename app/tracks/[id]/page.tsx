import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { checkIns, planNodes } from "@/lib/db/schema";
import { getTrackDetail, getCheckInDatesForTrack } from "@/lib/db/queries";
import { computeStreak } from "@/lib/streak";
import { summarizePlan } from "@/lib/planSummary";
import { doneDays, walk } from "@/lib/planTree";
import { PlanSummaryCard } from "@/components/pensieve/PlanSummaryCard";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/pensieve/PageShell";
import { StreakChip } from "@/components/pensieve/StreakChip";
import { Progress } from "@/components/ui/progress";
import { TrackPlan } from "./TrackPlan";

export default async function TrackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id } = await params;
  const [detail, checkInDates, sessionRows] = await Promise.all([
    getTrackDetail(id, userId),
    getCheckInDatesForTrack(id, userId),
    db
      .select({ nodeId: checkIns.nodeId, hours: checkIns.hours })
      .from(checkIns)
      .innerJoin(planNodes, eq(checkIns.nodeId, planNodes.id))
      .where(eq(planNodes.trackId, id)),
  ]);
  if (!detail) notFound();

  const { track, root } = detail;
  const sessions = new Map<string, { count: number; hours: number }>();
  for (const row of sessionRows) {
    if (row.hours === null) continue;
    const s = sessions.get(row.nodeId) ?? { count: 0, hours: 0 };
    s.count += 1;
    s.hours += row.hours;
    sessions.set(row.nodeId, s);
  }
  walk(root, (node) => {
    const s = sessions.get(node.id);
    if (s) node.sessions = s;
  });

  const total = root.len;
  const done = doneDays(root);
  const streak = computeStreak(checkInDates);
  const summary = track.summary ?? summarizePlan(root, track.title);

  return (
    <PageShell>
      <div className="text-[13px] text-foreground/60">
        <Link href="/dashboard" className="hover:text-primary">
          ← Dashboard
        </Link>
      </div>
      <div className="flex items-start justify-between gap-4 pt-2 pb-4">
        <div>
          <h1>{track.title}</h1>
          <p className="text-muted-foreground">
            {done} of {total} days complete
          </p>
          <StreakChip days={streak} className="mt-1.5" />
        </div>
        <Button variant="secondary" nativeButton={false} render={<Link href={`/tracks/${track.id}/adjust`}>Adjust plan</Link>} />
      </div>
      <Progress value={total > 0 ? (done / total) * 100 : 0} className="mb-6 max-w-[320px]" />
      <PlanSummaryCard summary={summary} className="mb-6" />
      <TrackPlan trackId={track.id} root={root} granularity={track.granularity} />
    </PageShell>
  );
}
