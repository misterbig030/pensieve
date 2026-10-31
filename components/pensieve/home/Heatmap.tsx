import { cn } from "@/lib/utils";

function shade(count: number): string {
  if (count < 0) return "bg-transparent";
  if (count === 0) return "bg-foreground/7";
  if (count === 1) return "bg-accent-2-200";
  if (count === 2) return "bg-accent-2-400";
  return "bg-accent-2-600";
}

/** Check-ins per day over the last weeks: one column per week, Monday at the top. Days still ahead are blank. */
export function Heatmap({ weeks }: { weeks: number[][] }) {
  return (
    <div className="max-w-[272px]">
      <div
        className="grid grid-flow-col grid-rows-7 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        role="img"
        aria-label={`Check-ins over the last ${weeks.length} weeks`}
      >
        {weeks.flat().map((count, i) => (
          <i key={i} className={cn("aspect-square rounded-[3px]", shade(count))} />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-foreground/45">
        Less
        {[0, 1, 2, 3].map((n) => (
          <i key={n} className={cn("size-2.5 rounded-[3px]", shade(n))} />
        ))}
        More
      </div>
    </div>
  );
}
