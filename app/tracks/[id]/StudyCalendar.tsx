import type { CalendarDay, CalendarWeek } from "@/lib/activity";
import { cn } from "@/lib/utils";

const HEADS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY = { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" } as const;
const MONDAY = { day: "numeric", month: "short", timeZone: "UTC" } as const;

const STATE: Record<CalendarDay["state"], string> = {
  studied: "bg-accent-2-500",
  empty: "bg-neutral-200",
  before: "bg-transparent",
  future: "bg-transparent",
};

/** "Fri 30 Oct", then what was done that day, one per line. */
function label(day: CalendarDay): string {
  const date = day.date.toLocaleDateString("en-GB", DAY).replace(",", "");
  return [date, ...day.titles].join(day.titles.length === 1 ? " · " : "\n");
}

/** A track's weeks on the calendar, Monday to Sunday, each date filled when something was finished or logged on it. */
export function StudyCalendar({ weeks }: { weeks: CalendarWeek[] }) {
  return (
    <div className="grid grid-cols-[44px_repeat(7,minmax(0,1fr))] items-center gap-1 text-[10.5px] text-muted-foreground">
      <span />
      {HEADS.map((h, i) => (
        <span key={i} className="text-center">
          {h}
        </span>
      ))}
      {weeks.map((week) => (
        <div key={week.monday.toISOString()} className="contents">
          <span className="whitespace-nowrap">{week.monday.toLocaleDateString("en-GB", MONDAY)}</span>
          {week.days.map((day) => {
            const studied = day.state === "studied";
            return (
              <span
                key={day.key}
                data-state={day.state}
                data-today={day.today || undefined}
                title={day.state === "before" || day.state === "future" ? undefined : label(day)}
                // Studied dates take focus so the keyboard and screen readers get what was done, not only the mouse.
                tabIndex={studied ? 0 : undefined}
                role={studied ? "img" : undefined}
                aria-label={studied ? label(day) : undefined}
                className={cn(
                  "block aspect-square rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-accent-2-700",
                  STATE[day.state],
                  day.today && "ring-2 ring-primary ring-offset-1 ring-offset-neutral-100",
                )}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
