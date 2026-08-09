import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { getTrackDetail, getCheckInDatesForTrack } from "@/lib/db/queries";
import { computeStreak } from "@/lib/streak";
import { buildPhases } from "@/lib/outlinePhases";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/pensieve/PageShell";
import { StreakChip } from "@/components/pensieve/StreakChip";
import { PhaseBlock } from "@/components/pensieve/PhaseBlock";
import { DayChip, type DayChipStatus } from "@/components/pensieve/DayChip";
import { Progress } from "@/components/ui/progress";

const STATUS_MAP: Record<string, DayChipStatus> = {
  completed: "done",
  generated: "ready",
  pending: "pending",
};

export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const { id } = await params;
  const [detail, checkInDates] = await Promise.all([
    getTrackDetail(id, userId),
    getCheckInDatesForTrack(id, userId),
  ]);
  if (!detail) notFound();

  const { track, items } = detail;
  const total = items.length;
  const done = items.filter((i) => i.status === "completed").length;
  const streak = computeStreak(checkInDates);
  const phases = buildPhases(items);

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
        <Button
          variant="secondary"
          nativeButton={false}
          render={<Link href={`/tracks/${track.id}/adjust`}>Adjust plan</Link>}
        />
      </div>
      <Progress value={total > 0 ? (done / total) * 100 : 0} className="mb-8 max-w-[320px]" />

      <div className="space-y-5">
        {phases.map((phase) => {
          const doneInPhase = phase.days.filter((d) => d.status === "completed").length;
          return (
            <PhaseBlock
              key={phase.label}
              label={phase.label}
              range={phase.range}
              focus={phase.focus}
              doneLabel={`${doneInPhase}/${phase.days.length} done`}
            >
              {phase.days.map((day) => (
                <DayChip
                  key={day.dayIndex}
                  dayIndex={day.dayIndex}
                  title={day.title}
                  status={STATUS_MAP[day.status]}
                  showTag
                  href={`/tracks/${track.id}/day/${day.dayIndex}`}
                />
              ))}
            </PhaseBlock>
          );
        })}
      </div>
    </PageShell>
  );
}
