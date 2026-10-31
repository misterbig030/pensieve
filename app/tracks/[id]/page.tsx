import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getTrackDetail } from "@/lib/db/queries";
import { getTrackCheckIns } from "@/lib/db/activity";
import { summarizePlan } from "@/lib/planSummary";
import { doneDays, walk, weeksOf } from "@/lib/planTree";
import { dayStrip, finishDate, plannedHours, studyEvents } from "@/lib/trackProgress";
import { MaterialsList } from "@/components/pensieve/MaterialsList";
import { PlanSummaryCard } from "@/components/pensieve/PlanSummaryCard";
import { PageShell } from "@/components/pensieve/PageShell";
import { DayStrip } from "@/components/pensieve/DayStrip";
import { TimeSplitCard } from "@/components/pensieve/TimeSplitCard";
import { ActivityTab } from "./ActivityTab";
import { TrackHeader } from "./TrackHeader";
import { TRACK_TABS, TrackTabs, type TrackTab } from "./TrackTabs";
import { TrackPlan } from "./TrackPlan";

const halfHours = (hours: number) => Math.round(hours * 2) / 2;

export default async function TrackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; day?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const [detail, checkInRows] = await Promise.all([getTrackDetail(id, userId), getTrackCheckIns(id, userId)]);
  if (!detail) notFound();

  const { track, root, materials } = detail;
  const sessions = new Map<string, { count: number; hours: number }>();
  for (const row of checkInRows) {
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

  const active: TrackTab = TRACK_TABS.find((t) => t === tab) ?? "plan";
  const summary = track.summary ?? summarizePlan(root, track.title, track.daysPerWeek);
  const studied = studyEvents(root, checkInRows, track.hoursPerWeek, track.daysPerWeek).reduce((sum, e) => sum + e.hours, 0);
  const pace = `${track.granularity === "day" ? "Daily" : "Weekly"} · ${track.daysPerWeek} days a week · ${track.hoursPerWeek} h a week`;

  return (
    <PageShell>
      <div className="flex flex-col gap-3">
        <nav className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Link href="/" className="hover:text-primary">
            Your tracks
          </Link>
          <ChevronRight className="size-3.5" />
          <b className="truncate font-semibold text-foreground">{track.title}</b>
        </nav>
        <TrackHeader
          title={track.title}
          pace={pace}
          done={doneDays(root)}
          total={root.len}
          studied={halfHours(studied)}
          planned={halfHours(plannedHours(root, track.hoursPerWeek, track.daysPerWeek))}
          finish={finishDate(root, track.daysPerWeek, new Date())}
          adjustHref={`/tracks/${track.id}/adjust`}
        />
        <DayStrip cells={dayStrip(root, track.granularity, track.daysPerWeek)} />
        <TrackTabs trackId={track.id} active={active} materialsCount={materials.length} />
      </div>

      <div className="pt-6">
        {active === "plan" && (
          <TrackPlan trackId={track.id} root={root} granularity={track.granularity} materials={materials} hoursPerWeek={track.hoursPerWeek} daysPerWeek={track.daysPerWeek} />
        )}
        {active === "materials" &&
          (materials.length > 0 ? (
            <MaterialsList topic={track.title} materials={materials} initialShown={12} />
          ) : (
            <p className="py-10 text-center text-[14px] text-muted-foreground">This track has no materials.</p>
          ))}
        {active === "about" && (
          <div className="grid grid-cols-2 items-start gap-6 max-[900px]:grid-cols-1">
            <PlanSummaryCard summary={summary} />
            <TimeSplitCard weeks={weeksOf(root, root, track.daysPerWeek)} hoursPerWeek={track.hoursPerWeek} daysPerWeek={track.daysPerWeek} split={track.split} materials={materials} />
          </div>
        )}
        {active === "activity" && <ActivityTab rows={checkInRows} />}
      </div>
    </PageShell>
  );
}
