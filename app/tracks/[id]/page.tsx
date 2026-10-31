import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getTrackDetail } from "@/lib/db/queries";
import { getTrackCheckIns } from "@/lib/db/activity";
import { summarizePlan } from "@/lib/planSummary";
import { currentLeaf, doneDays, resolveSelected, walk } from "@/lib/planTree";
import { dayStrip, finishDate, plannedHours, studyEvents } from "@/lib/trackProgress";
import { MaterialsList } from "@/components/pensieve/MaterialsList";
import { PageShell } from "@/components/pensieve/PageShell";
import { DayStrip } from "@/components/pensieve/DayStrip";
import { ActivityTab } from "./ActivityTab";
import { PlanGlance } from "./PlanGlance";
import { TrackHeader } from "./TrackHeader";
import { DayPane } from "./DayPane";
import { PlanOutline } from "./PlanOutline";
import { TRACK_TABS, TrackTabs, type TrackTab } from "./TrackTabs";

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

  const [{ id }, { tab, day }] = await Promise.all([params, searchParams]);
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
  const current = currentLeaf(root);
  const selected = resolveSelected(root, day);
  const summary = track.summary ?? summarizePlan(root, track.title, track.daysPerWeek);
  const studied = studyEvents(root, checkInRows, track.hoursPerWeek, track.daysPerWeek).reduce((sum, e) => sum + e.hours, 0);
  const planned = halfHours(plannedHours(root, track.hoursPerWeek, track.daysPerWeek));
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
          planned={planned}
          finish={finishDate(root, track.daysPerWeek, new Date())}
          adjustHref={`/tracks/${track.id}/adjust`}
        />
        <DayStrip cells={dayStrip(root, track.granularity, track.daysPerWeek)} />
        <TrackTabs trackId={track.id} active={active} materialsCount={materials.length} />
      </div>

      <div className="pt-6">
        {active === "plan" && <PlanGlance summary={summary} totalHours={planned} split={track.split} materials={materials} />}
        {active === "plan" && (
          <div className="grid grid-cols-[440px_minmax(0,1fr)] max-[1100px]:grid-cols-[340px_minmax(0,1fr)] max-[900px]:grid-cols-1">
            <div className="border-r border-border pr-4 max-[900px]:border-r-0 max-[900px]:border-b max-[900px]:pr-0 max-[900px]:pb-4">
              <PlanOutline
                trackId={track.id}
                root={root}
                granularity={track.granularity}
                daysPerWeek={track.daysPerWeek}
                selectedId={selected.id}
                currentLeafId={current?.id ?? null}
              />
            </div>
            <div className="min-w-0 pl-8 max-[900px]:pt-6 max-[900px]:pl-0">
              <DayPane
                trackId={track.id}
                root={root}
                node={selected}
                currentLeafId={current?.id ?? null}
                materials={materials}
                hoursPerWeek={track.hoursPerWeek}
                daysPerWeek={track.daysPerWeek}
                userId={userId}
              />
            </div>
          </div>
        )}
        {active === "materials" &&
          (materials.length > 0 ? (
            <MaterialsList topic={track.title} materials={materials} initialShown={12} />
          ) : (
            <p className="py-10 text-center text-[14px] text-muted-foreground">This track has no materials.</p>
          ))}
        {active === "activity" && <ActivityTab rows={checkInRows} />}
      </div>
    </PageShell>
  );
}
