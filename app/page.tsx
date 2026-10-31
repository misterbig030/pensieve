import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Plus } from "lucide-react";
import { getDashboardTracksForUser } from "@/lib/db/queries";
import { heatmapWeeks, monthTotals } from "@/lib/activity";
import { computeStreak, longestStreak } from "@/lib/streak";
import { homeStatus, toTrackCard } from "@/lib/trackCard";
import { sortTracks, studyEvents, type SortKey } from "@/lib/trackProgress";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/pensieve/PageShell";
import { SortMenu } from "@/components/pensieve/home/SortMenu";
import { StatsRail } from "@/components/pensieve/home/StatsRail";
import { TrackCard } from "@/components/pensieve/home/TrackCard";

const SORT_KEYS: readonly SortKey[] = ["next", "recent", "newest"];

export default async function Home({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const { userId } = await auth();
  if (!userId) return null;

  const { sort } = await searchParams;
  const sortKey: SortKey = SORT_KEYS.find((k) => k === sort) ?? "next";
  const today = new Date();
  const dashboardTracks = await getDashboardTracksForUser(userId);

  const cards = sortTracks(
    dashboardTracks.map(({ track, root, checkIns }) => toTrackCard(track, root, checkIns, today)),
    sortKey,
  );

  const allCheckIns = dashboardTracks.flatMap((t) => t.checkIns).sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
  const dates = allCheckIns.map((c) => c.completedAt);
  const events = dashboardTracks.flatMap(({ track, root, checkIns }) => studyEvents(root, checkIns, track.hoursPerWeek, track.daysPerWeek));

  return (
    <PageShell className="grid min-h-[calc(100vh-60px)] grid-cols-[minmax(0,1fr)_320px] p-0 max-[900px]:grid-cols-1 max-[640px]:px-0">
      <div className="flex min-w-0 flex-col gap-5 px-8 pt-7 pb-24 max-[640px]:px-4">
        <div className="flex items-end gap-4">
          <div className="mr-auto">
            <h1 className="text-[30px] leading-[1.1]">Your tracks</h1>
            {cards.length > 0 && <p className="mt-1.5 text-[14px] text-muted-foreground">{homeStatus(cards)}</p>}
          </div>
          <Button
            nativeButton={false}
            render={
              <Link href="/tracks/new">
                <Plus />
                New track
              </Link>
            }
          />
        </div>

        {cards.length > 0 ? (
          <>
            <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
              <span>
                {cards.length} {cards.length === 1 ? "track" : "tracks"}
              </span>
              <SortMenu value={sortKey} />
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
              {cards.map((card) => (
                <TrackCard key={card.id} card={card} />
              ))}
              <Link
                href="/tracks/new"
                className="flex min-h-[230px] flex-col items-center justify-center gap-2.5 rounded-[26px] border-2 border-dashed border-neutral-400 text-[14px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                <span className="flex size-11 items-center justify-center rounded-full bg-accent-100 text-primary">
                  <Plus className="size-5" />
                </span>
                Start a new track
                <span className="text-[12px] font-normal text-foreground/45">Tell Pensieve what you want to learn</span>
              </Link>
            </div>
          </>
        ) : (
          <div className="rounded-[32px] bg-secondary px-6 py-16 text-center">
            <div className="mx-auto mb-[18px] size-11 rounded-full bg-accent-100" />
            <h3>No tracks yet</h3>
            <p className="text-muted-foreground">
              Tell Pensieve what you want to learn and it will draft a day-by-day plan.
            </p>
            <Button className="mt-2" nativeButton={false} render={<Link href="/tracks/new">+ New track</Link>} />
          </div>
        )}
      </div>

      <StatsRail
        streak={computeStreak(dates, today)}
        longest={longestStreak(dates)}
        month={monthTotals(events, today)}
        heatmap={heatmapWeeks(dates, today)}
        recent={allCheckIns.slice(0, 4)}
      />
    </PageShell>
  );
}
