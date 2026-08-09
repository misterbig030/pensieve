import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getDashboardTracksForUser } from "@/lib/db/queries";
import { computeStreak } from "@/lib/streak";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { PageShell } from "@/components/pensieve/PageShell";
import { StreakChip } from "@/components/pensieve/StreakChip";

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};
const STATUS_VARIANT: Record<string, "accent2" | "accent" | "neutral"> = {
  active: "accent2",
  completed: "accent",
  archived: "neutral",
};

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const dashboardTracks = await getDashboardTracksForUser(userId);

  return (
    <PageShell>
      <div className="pb-7">
        <h1>Your learning tracks</h1>
        <p className="text-muted-foreground">Pick up where you left off, or start something new.</p>
      </div>

      {dashboardTracks.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-4">
          {dashboardTracks.map(({ track, total, done, checkInDates }) => (
            <Link
              key={track.id}
              href={`/tracks/${track.id}`}
              className="elev-sm flex flex-col gap-2 rounded-[32px] bg-secondary p-[13px] transition-transform hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className="font-heading text-[17px] leading-tight">{track.title}</span>
              <Progress value={total > 0 ? (done / total) * 100 : 0} />
              <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-foreground/60">
                <Badge variant={STATUS_VARIANT[track.status]}>{STATUS_LABEL[track.status]}</Badge>
                <span>
                  Day {done} of {total}
                </span>
                <StreakChip days={computeStreak(checkInDates)} />
              </span>
            </Link>
          ))}
        </div>
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
    </PageShell>
  );
}
