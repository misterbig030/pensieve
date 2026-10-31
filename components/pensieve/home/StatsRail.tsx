import type { ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { relativeDay } from "@/lib/activity";
import type { CheckInRow } from "@/lib/db/activity";
import { Heatmap } from "@/components/pensieve/home/Heatmap";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2.5 text-[12px] font-semibold tracking-[.04em] text-foreground/45 uppercase">{title}</h4>
      {children}
    </section>
  );
}

function hoursText(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

/** The home's right column: streak, this month's totals, the activity grid and the latest check-ins. */
export function StatsRail({
  streak,
  longest,
  month,
  heatmap,
  recent,
}: {
  streak: number;
  longest: number;
  month: { sessions: number; hours: number };
  heatmap: number[][];
  recent: CheckInRow[];
}) {
  const today = new Date();
  return (
    <aside className="flex flex-col gap-[22px] border-l border-border bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] px-6 py-7 max-[900px]:border-t max-[900px]:border-l-0">
      <Section title="Streak">
        <div className="flex items-baseline gap-2">
          <b className="font-heading text-[40px] leading-none font-normal">{streak}</b>
          <span className="text-[13px] text-muted-foreground">
            {streak === 1 ? "day" : "days"} · longest {longest}
          </span>
        </div>
      </Section>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-2xl bg-neutral-100 px-3.5 py-3">
          <b className="block font-heading text-[22px] font-normal">{month.sessions}</b>
          <span className="block text-[12px] leading-snug text-muted-foreground">sessions this month</span>
        </div>
        <div className="rounded-2xl bg-neutral-100 px-3.5 py-3">
          <b className="block font-heading text-[22px] font-normal">{hoursText(month.hours)} h</b>
          <span className="block text-[12px] leading-snug text-muted-foreground">studied this month</span>
        </div>
      </div>
      <Section title={`Last ${heatmap.length} weeks`}>
        <Heatmap weeks={heatmap} />
      </Section>
      <Section title="Recently">
        {recent.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing yet. Finished days and logged sessions show up here.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-[13px]">
            {recent.slice(0, 4).map((row) => (
              <li key={`${row.nodeId}-${row.completedAt.toISOString()}`} className="flex items-start gap-2.5">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent-2-600" />
                <span className="min-w-0">
                  {row.hours !== null ? `Logged ${hoursText(row.hours)} h on ${row.nodeTitle}` : `Finished ${row.nodeTitle}`}
                  <small className="block text-[12px] text-foreground/45">
                    {row.trackTitle} · {relativeDay(row.completedAt, today)}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}
