import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type DayChipStatus = "done" | "ready" | "pending";

const STATUS_CLASSES: Record<DayChipStatus, string> = {
  done: "bg-accent-2-100",
  ready: "bg-accent-100 border-accent-300",
  pending: "bg-secondary opacity-75",
};

const STATUS_TAG: Record<DayChipStatus, { label: string; variant: "accent2" | "accent" | "neutral" }> = {
  done: { label: "Done", variant: "accent2" },
  ready: { label: "Ready", variant: "accent" },
  pending: { label: "Not started", variant: "neutral" },
};

interface DayChipProps {
  dayIndex: number;
  title: string;
  status: DayChipStatus;
  /** Shows the status tag — used on track detail, omitted on outline review. */
  showTag?: boolean;
  href?: string;
  className?: string;
}

export function DayChip({ dayIndex, title, status, showTag = false, href, className }: DayChipProps) {
  const classes = cn(
    "flex flex-col gap-1 rounded-2xl border border-transparent p-3 text-left",
    STATUS_CLASSES[status],
    href && "cursor-pointer hover:shadow-sm",
    className,
  );
  const content = (
    <>
      <span className="font-heading text-[11px] text-accent-700">Day {dayIndex}</span>
      <span className="text-[13px] leading-snug">{title}</span>
      {showTag && (
        <Badge variant={STATUS_TAG[status].variant} className="mt-0.5 self-start">
          {STATUS_TAG[status].label}
        </Badge>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  return <div className={classes}>{content}</div>;
}
