import { cn } from "@/lib/utils";

interface PlanSummaryCardProps {
  summary: string;
  /** Renders shimmer lines instead of text while the draft is still streaming. */
  loading?: boolean;
  /** Tints the card while a change is highlighted on the plan. */
  changed?: boolean;
  className?: string;
}

export function PlanSummaryCard({ summary, loading = false, changed = false, className }: PlanSummaryCardProps) {
  return (
    <div
      className={cn(
        "rounded-[28px] bg-secondary px-5 py-4 transition-[background-color,box-shadow] duration-300",
        changed && "bg-accent-100 shadow-[inset_0_0_0_1px_var(--accent-400)]",
        className,
      )}
    >
      <span className="mb-1.5 block text-[11px] tracking-wide text-muted-foreground uppercase">Summary</span>
      {loading || !summary ? (
        <>
          <span className="skeleton-bar my-1.5 h-3 w-[90%]" />
          <span className="skeleton-bar h-3 w-[70%]" />
        </>
      ) : (
        <p className="m-0 text-[14.5px] leading-relaxed">{summary}</p>
      )}
    </div>
  );
}
