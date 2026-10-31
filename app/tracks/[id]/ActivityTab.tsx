import { CircleCheck } from "lucide-react";
import { byWeek, hoursText, studyCalendar, studyDates, weekTotal, weekdayDate } from "@/lib/activity";
import type { CheckInRow } from "@/lib/db/activity";
import { StudyCalendar } from "./StudyCalendar";

const WEEK_OF = { day: "numeric", month: "short", timeZone: "UTC" } as const;

/** A check-in with the study time it counts for: a finished day its share of the week's hours, a session its hours. */
export type ActivityRow = CheckInRow & { studyHours: number };

/**
 * Every check-in on the track by week, beside a calendar of the dates studied since the track began. Days are UTC
 * days, the boundary the streak and stats use.
 */
export function ActivityTab({ rows, createdAt, today, studied, finish }: { rows: ActivityRow[]; createdAt: Date; today: Date; studied: number; finish: Date | null }) {
  const dates = studyDates(rows);
  return (
    <div className="grid grid-cols-[minmax(0,820px)_320px] items-start gap-8 max-[900px]:grid-cols-1">
      {rows.length === 0 ? (
        <p className="py-10 text-center text-[14px] text-muted-foreground">No check-ins yet. Finished days and logged sessions show up here.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {byWeek(rows).map((group) => (
            <section key={group.start.toISOString()}>
              <h3 className="mb-2 flex items-baseline text-[12px] font-semibold tracking-[.04em] text-foreground/45 uppercase">
                Week of {group.start.toLocaleDateString("en-GB", WEEK_OF)}
                <span className="ml-auto font-medium tracking-normal normal-case">
                  {weekTotal(
                    group.rows,
                    group.rows.reduce((sum, r) => sum + r.studyHours, 0),
                  )}
                </span>
              </h3>
              <ul className="flex flex-col divide-y divide-border rounded-2xl bg-neutral-100 px-4">
                {group.rows.map((row) => (
                  <li key={`${row.nodeId}-${row.completedAt.toISOString()}`} className="flex items-start gap-2.5 py-3 text-[14px]">
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent-2-600" />
                    <span className="min-w-0 flex-1">
                      {row.nodeTitle}
                      <small className="block text-[12px] text-muted-foreground">{weekdayDate(row.completedAt)}</small>
                    </span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">{hoursText(row.studyHours)} h</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <aside className="elev-sm sticky top-0 flex flex-col gap-3 rounded-[18px] bg-neutral-100 px-4 py-3.5 max-[900px]:static max-[900px]:order-first">
        <h4 className="text-[10.5px] font-semibold tracking-[.05em] text-muted-foreground uppercase">Your study days</h4>
        <StudyCalendar weeks={studyCalendar(rows, createdAt, today)} />
        <p className="m-0 text-[12.5px]">
          {hoursText(studied)} h studied · on {dates} day{dates === 1 ? "" : "s"}
        </p>
        {finish && <p className="m-0 text-[12px] text-muted-foreground">Estimated finish: {finish.toLocaleDateString("en-GB", WEEK_OF)}</p>}
      </aside>
    </div>
  );
}
