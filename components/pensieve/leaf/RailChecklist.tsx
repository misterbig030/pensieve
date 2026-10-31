"use client";

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { FormatPill, ItemLink, PracticeSource, PracticeTask, TierPill, itemLabel, partLabel, rowHref, type PracticeRow, type ReadRow } from "@/components/pensieve/ReadTable";
import { shortTitle } from "@/lib/shortTitle";
import { cn } from "@/lib/utils";

function Tick({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]",
        on ? "border-accent-2-500 bg-accent-2-500 text-background" : "border-neutral-400",
      )}
    >
      {on && <Check className="size-2.5" strokeWidth={3} />}
    </span>
  );
}

/** A row of the list. The tick is the control; the row's text keeps its links, so it sits beside the tick, not in it. */
function TodoRow({ on, onToggle, name, children, minutes }: { on: boolean; onToggle(): void; name: string; children: ReactNode; minutes?: number | null }) {
  return (
    <div className="flex w-full items-start gap-2.5 py-[7px] text-[13px]">
      <button type="button" role="checkbox" aria-checked={on} aria-label={name} onClick={onToggle} className="rounded-full">
        <Tick on={on} />
      </button>
      <span className={cn("min-w-0 flex-1", on && "text-muted-foreground line-through decoration-foreground/30")}>{children}</span>
      {minutes != null && <span className="shrink-0 text-[12px] whitespace-nowrap text-muted-foreground">{minutes} min</span>}
    </div>
  );
}

const small = "block text-[12px] text-foreground/45";

/** The lesson rail's list for the day: the lesson, then the Read and Do rows, each ticked off for this visit only. */
export function RailChecklist({ readRows, practiceRows }: { readRows: ReadRow[]; practiceRows: PracticeRow[] }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="divide-y divide-border">
      <TodoRow name="Read the lesson" on={ticked.has("lesson")} onToggle={() => toggle("lesson")}>
        Read the lesson
        <small className={small}>This page</small>
      </TodoRow>
      {readRows.map((r) => (
        <TodoRow key={r.key} name={shortTitle(r.material.title)} on={ticked.has(r.key)} onToggle={() => toggle(r.key)} minutes={r.minutes}>
          <span className="flex items-center gap-1.5">
            <span className="truncate">
              <ItemLink material={r.material} href={rowHref(r)} />
            </span>
            <TierPill tier={r.tier} />
          </span>
          {(partLabel(r) || r.note) && <small className={small}>{[partLabel(r), r.note].filter(Boolean).join(" · ")}</small>}
        </TodoRow>
      ))}
      {practiceRows.map((r) => (
        <TodoRow key={r.key} name={r.item ? itemLabel(r.item) : r.task} on={ticked.has(r.key)} onToggle={() => toggle(r.key)} minutes={r.minutes}>
          <span>
            <FormatPill label={r.label} /> <PracticeTask row={r} />
          </span>
          <small className={small}>
            <PracticeSource row={r} />
            {r.done && ` · ${r.done}`}
          </small>
        </TodoRow>
      ))}
    </div>
  );
}
