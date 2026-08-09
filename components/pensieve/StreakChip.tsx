import { cn } from "@/lib/utils";

export function StreakChip({ days, className }: { days: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-foreground/60", className)}>
      <span className="size-[7px] rounded-full bg-accent-2-500" />
      {days}-day streak
    </span>
  );
}
