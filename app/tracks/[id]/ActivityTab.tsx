import { CircleCheck } from "lucide-react";
import { byWeek, weekdayDate } from "@/lib/activity";
import type { CheckInRow } from "@/lib/db/activity";

const WEEK_OF = { day: "numeric", month: "short", timeZone: "UTC" } as const;

function hoursText(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

/** Every check-in on the track, by week. Days are UTC days, the boundary the streak and stats use. */
export function ActivityTab({ rows }: { rows: CheckInRow[] }) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-[14px] text-muted-foreground">No check-ins yet. Finished days and logged sessions show up here.</p>;
  }
  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      {byWeek(rows).map((group) => (
        <section key={group.start.toISOString()}>
          <h3 className="mb-2 text-[12px] font-semibold tracking-[.04em] text-foreground/45 uppercase">
            Week of {group.start.toLocaleDateString("en-GB", WEEK_OF)}
          </h3>
          <ul className="flex flex-col divide-y divide-border rounded-2xl bg-neutral-100 px-4">
            {group.rows.map((row) => (
              <li key={`${row.nodeId}-${row.completedAt.toISOString()}`} className="flex items-start gap-2.5 py-3 text-[14px]">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent-2-600" />
                <span className="min-w-0">
                  {row.nodeTitle}
                  <small className="block text-[12px] text-muted-foreground">
                    {weekdayDate(row.completedAt)}
                    {row.hours !== null && ` · ${hoursText(row.hours)} h`}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
