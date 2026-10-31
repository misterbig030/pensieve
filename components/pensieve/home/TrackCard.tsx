import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { shortDate } from "@/lib/activity";
import type { TrackCardData } from "@/lib/trackCard";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

function Inset({ card }: { card: TrackCardData }) {
  const { action } = card;
  if (card.doneToday) {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl bg-accent-2-100 px-3 py-2.5 text-[13px] text-accent-2-800">
        <CircleCheck className="size-4 shrink-0" />
        <div className="min-w-0">
          <small className="block text-[11px] font-semibold tracking-[.04em] uppercase">Done today</small>
          <b className="block truncate font-semibold">{card.actionTitle}</b>
        </div>
      </div>
    );
  }
  if (action.kind === "finished") {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl bg-accent-2-100 px-3 py-2.5 text-[13px] font-semibold text-accent-2-800">
        <CircleCheck className="size-4 shrink-0" />
        {card.actionLabel}
      </div>
    );
  }
  const href = action.kind === "plan" ? `/tracks/${card.id}?day=${action.node.id}` : `/tracks/${card.id}/nodes/${action.node.id}`;
  const label = action.kind === "plan" ? "Plan it" : action.kind === "start" ? "Start" : "Log";
  return (
    <div className="flex items-center gap-2.5 rounded-2xl bg-secondary px-3 py-2.5 text-[13px]">
      <div className="min-w-0">
        {action.kind === "plan" ? (
          <b className="block font-semibold">{card.actionLabel}</b>
        ) : (
          <>
            <small className="block text-[11px] font-semibold tracking-[.04em] text-foreground/45 uppercase">{card.actionLabel}</small>
            <b className="block truncate font-semibold">{card.actionTitle}</b>
          </>
        )}
      </div>
      <Button
        size="sm"
        variant={action.kind === "start" ? "default" : "outline"}
        className="relative z-10 ml-auto shrink-0"
        nativeButton={false}
        render={<Link href={href}>{label}</Link>}
      />
    </div>
  );
}

/** One track on the home: what's next today, this week's activity and how far along it is. Opens the plan page. */
export function TrackCard({ card }: { card: TrackCardData }) {
  const { progress } = card;
  return (
    <div className="elev-sm relative flex flex-col gap-2.5 rounded-[26px] bg-neutral-100 px-[18px] pt-[18px] pb-4 transition-transform hover:-translate-y-0.5">
      <span className="text-[12px] text-muted-foreground">{card.pace}</span>
      <Link
        href={`/tracks/${card.id}`}
        className="font-heading text-[19px] leading-[1.2] after:absolute after:inset-0 after:z-[1] after:rounded-[26px] after:content-['']"
      >
        {card.title}
      </Link>
      <Inset card={card} />
      <div className={cn("flex min-h-3.5 items-center gap-1 text-[11px] text-foreground/45", card.week.cells.length === 0 && "invisible")}>
        {card.week.cells.map((cell, i) => (
          <i
            key={i}
            className={cn(
              "size-3.5 rounded-[5px]",
              cell === "done" && "bg-accent-2-500",
              cell === "current" && "border-[1.5px] border-dashed border-primary",
              cell === "open" && "bg-foreground/8",
            )}
          />
        ))}
        <span className="ml-auto">{card.week.label}</span>
      </div>
      <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} />
      <div className="flex justify-between text-[12px] text-muted-foreground">
        <span>
          {progress.unit} {progress.done} of {progress.total}
        </span>
        {card.finish && <span>Ends {shortDate(card.finish)}</span>}
      </div>
    </div>
  );
}
