import { monthLabels, type CalendarDay, type CalendarWeek } from "@/lib/activity";
import { cn } from "@/lib/utils";

const ROWS = ["M", "", "W", "", "F", "", ""];
const DAY = { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" } as const;

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

/**
 * A track's weeks on the calendar, on their side: weeks left to right, oldest first, Monday to Sunday top to bottom,
 * each date filled when something was finished or logged on it.
 */
export function StudyCalendar({ weeks }: { weeks: CalendarWeek[] }) {
  const months = monthLabels(weeks);
  return (
    <div className="grid grid-cols-[18px_repeat(12,18px)] grid-rows-[14px_repeat(7,18px)] gap-1 text-[10px] leading-[14px] text-muted-foreground">
      {months.map((m, i) => (
        <span
          key={m.index}
          className="row-start-1 whitespace-nowrap"
          style={{ gridColumn: `${m.index + 2} / ${(months[i + 1]?.index ?? weeks.length) + 2}` }}
        >
          {m.label}
        </span>
      ))}
      {ROWS.map((r, d) => (
        <span key={d} className="col-start-1 leading-[18px]" style={{ gridRow: d + 2 }}>
          {r}
        </span>
      ))}
      {weeks.map((week, w) =>
        week.days.map((day, d) => {
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
              style={{ gridColumn: w + 2, gridRow: d + 2 }}
              className={cn(
                "block rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-accent-2-700",
                STATE[day.state],
                day.state === "future" && "shadow-[inset_0_0_0_1px_var(--color-neutral-300)]",
                day.today && "ring-2 ring-primary ring-offset-1 ring-offset-neutral-100",
              )}
            />
          );
        }),
      )}
    </div>
  );
}
