import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getTrackDetail } from "@/lib/db/queries";
import { getTrackCheckIns } from "@/lib/db/activity";
import { summarizePlan } from "@/lib/planSummary";
import { currentLeaf, doneDays, resolveSelected, walk } from "@/lib/planTree";
import { dayStrip, finishDate, plannedHours, studyEvents } from "@/lib/trackProgress";
import { PageShell } from "@/components/pensieve/PageShell";
import { DayStrip } from "@/components/pensieve/DayStrip";
import { PlanGlance } from "./PlanGlance";
import { TrackHeader } from "./TrackHeader";
import { DayPane } from "./DayPane";
import { PlanOutline } from "./PlanOutline";
import { StudyDaysCard } from "./StudyDaysCard";
import { MaterialsColumn } from "./MaterialsColumn";
import { materialPlacement, placeLabel } from "@/lib/materialUses";

const halfHours = (hours: number) => Math.round(hours * 2) / 2;

export default async function TrackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) return null;

  const [{ id }, { day }] = await Promise.all([params, searchParams]);
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

  const current = currentLeaf(root);
  const selected = resolveSelected(root, day);
  const summary = track.summary ?? summarizePlan(root, track.title, track.daysPerWeek);
  const studied = studyEvents(root, checkInRows, track.hoursPerWeek, track.daysPerWeek).reduce((sum, e) => sum + e.hours, 0);
  const today = new Date();
  const finish = finishDate(root, track.daysPerWeek, today);
  const planned = halfHours(plannedHours(root, track.hoursPerWeek, track.daysPerWeek));
  const pace = `${track.granularity === "day" ? "Daily" : "Weekly"} · ${track.daysPerWeek} days a week · ${track.hoursPerWeek} h a week`;

  return (
    <PageShell>
      {/* One page, no tabs: the study days sit in the top corner beside the header, the materials under them beside the
          outline and pane. Below 1200 px both drop under the plan. */}
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-x-6 gap-y-[18px] max-[1199px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3">
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
            finish={finish}
            adjustHref={`/tracks/${track.id}/adjust`}
          />
          <DayStrip cells={dayStrip(root, track.granularity, track.daysPerWeek)} />
          <div className="pt-3">
            <PlanGlance summary={summary} totalHours={planned} split={track.split} materials={materials} />
          </div>
        </div>

        <div className="max-[1199px]:order-3">
          <StudyDaysCard rows={checkInRows} createdAt={track.createdAt} today={today} />
        </div>

        <div className="grid min-w-0 grid-cols-[300px_minmax(0,1fr)] min-[1440px]:grid-cols-[360px_minmax(0,1fr)] max-[900px]:grid-cols-1">
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
          <div className="min-w-0 pl-6 max-[900px]:pt-6 max-[900px]:pl-0">
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

        <aside className="sticky top-5 flex max-h-[calc(100dvh-40px)] flex-col self-start max-[1199px]:static max-[1199px]:order-4 max-[1199px]:max-h-none">
          <MaterialsColumn key={selected.id} materials={materials} unitLabel={placeLabel(root, selected)} placement={materialPlacement(root, materials, selected)} />
        </aside>
      </div>
    </PageShell>
  );
}
