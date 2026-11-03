import { studyCalendar, studyDates } from "@/lib/activity";
import { StudyCalendar } from "./StudyCalendar";

/**
 * The track's last 12 weeks of study in the page's top corner, with how many dates were studied. Hours and the finish
 * date are in the header, so they are not repeated here.
 */
export function StudyDaysCard({ rows, createdAt, today }: { rows: { completedAt: Date; nodeTitle: string }[]; createdAt: Date; today: Date }) {
  const weeks = studyCalendar(rows, createdAt, today);
  const dates = studyDates(rows);
  const older = createdAt < weeks[0].monday;
  return (
    <section aria-label="Your study days" className="elev-sm flex flex-col gap-3 rounded-[18px] bg-neutral-100 px-4 py-3.5">
      <h4 className="text-[10.5px] font-semibold tracking-[.05em] text-muted-foreground uppercase">Your study days</h4>
      <StudyCalendar weeks={weeks} />
      <p className="m-0 text-[12.5px]">
        Studied on {dates} day{dates === 1 ? "" : "s"}
        {older ? " since you started" : ""}
      </p>
    </section>
  );
}
