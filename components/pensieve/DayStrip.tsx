import type { CellState, StripCell } from "@/lib/trackProgress";
import { cn } from "@/lib/utils";

const COLOR: Record<CellState, string> = {
  done: "bg-accent-2-500",
  current: "bg-primary",
  ready: "bg-accent-300",
  planned: "bg-foreground/8",
};

/** The whole plan at a glance: one block per study day (or per week on a week track), with a gap between weeks. */
export function DayStrip({ cells }: { cells: StripCell[] }) {
  return (
    <div className="flex gap-[3px]" aria-hidden="true">
      {cells.map((cell, i) => (
        <i key={i} className={cn("h-2.5 min-w-0 flex-1 rounded-[3px]", COLOR[cell.state], cell.weekStart && i > 0 && "ml-1.5")} />
      ))}
    </div>
  );
}
