"use client";

import { Popover } from "@base-ui/react/popover";
import { FileText, Pencil } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { DaysPanel, HoursPanel, ReadingPanel } from "@/components/pensieve/draft/TimePanels";
import type { Material } from "@/lib/schemas/material";
import type { PlanLevel } from "@/lib/planTree";
import { isAllReading, type PlanSplit } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

export interface StatStripProps {
  lengthLabel: string;
  topLevel: PlanLevel;
  hoursPerWeek: number;
  daysPerWeek: number;
  split: PlanSplit | null;
  /** drafting && !split */
  deciding: boolean;
  totalHours: number;
  materials: Material[];
  /** The import's file name, "researched", or null. */
  sourceLabel: string | null;
  /** streaming || busy || confirming */
  disabled: boolean;
  onChangeHours: (hours: number) => void;
  /** Omitted for a plan whose top level is a day. */
  onChangeDays?: (days: number) => void;
  onChangeSplit: (split: PlanSplit) => void;
}

const number = "block font-heading text-[17px] leading-tight font-normal";
const caption = "text-[11px] text-muted-foreground";

/** The strip at the top of the plan column: its length, and the numbers the learner can change, each opening its panel. */
export function StatStrip(p: StatStripProps) {
  const daily = p.topLevel === "day";
  const reading = p.split ? (isAllReading(p.split) ? "all reading" : `${p.split.readingShare}% reading`) : p.deciding ? "deciding…" : "not split";
  const stripRef = useRef<HTMLElement>(null);
  // At 900px and under a popover opens under the whole strip rather than its trigger. Set after mount, so the server render is the wide one.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const anchor = narrow ? stripRef : undefined;
  const readingCaption = p.split && !isAllReading(p.split) ? "the rest practice" : "";

  return (
    <section
      ref={stripRef}
      aria-label="This plan in numbers"
      className="elev-sm mb-4 flex flex-wrap items-center gap-x-[22px] gap-y-2.5 rounded-[18px] bg-neutral-100 px-[18px] py-3 text-[12.5px] max-[900px]:grid max-[900px]:grid-cols-2 max-[900px]:gap-x-3.5"
    >
      <div>
        <b className={number}>{p.lengthLabel}</b>
      </div>
      <Cell anchor={anchor} label="Change hours a week" disabled={p.disabled} panel={<HoursPanel hoursPerWeek={p.hoursPerWeek} disabled={p.disabled} onChange={p.onChangeHours} />}>
        <b className={number}>{p.hoursPerWeek} h</b>
        <small className={caption}>{daily ? "in all" : "a week"}</small>
      </Cell>
      {p.onChangeDays && !daily && (
        <Cell anchor={anchor} label="Change days a week" disabled={p.disabled} panel={<DaysPanel daysPerWeek={p.daysPerWeek} disabled={p.disabled} onChange={p.onChangeDays} />}>
          <b className={number}>{p.daysPerWeek} days</b>
          <small className={caption}>a week</small>
        </Cell>
      )}
      <Cell
        anchor={anchor}
        label="Change the reading share"
        disabled={p.disabled || p.deciding}
        panel={<ReadingPanel split={p.split} deciding={p.deciding} totalHours={p.totalHours} materials={p.materials} disabled={p.disabled} onChange={p.onChangeSplit} />}
      >
        <b className={number}>{reading}</b>
        {readingCaption && <small className={caption}>{readingCaption}</small>}
      </Cell>
      {p.sourceLabel && (
        <span className="ml-auto inline-flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-xs font-semibold max-[900px]:col-span-2 max-[900px]:ml-0">
          <FileText aria-hidden className="size-3.5" />
          {p.sourceLabel}
        </span>
      )}
    </section>
  );
}

function Cell({ label, anchor, disabled, panel, children }: { label: string; anchor: RefObject<HTMLElement | null> | undefined; disabled: boolean; panel: ReactNode; children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        disabled={disabled}
        className={cn(
          "-m-1 inline-flex items-center gap-1.5 rounded-[10px] p-1 text-left outline-none hover:bg-neutral-200 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-neutral-200",
          disabled && "cursor-default opacity-45 hover:bg-transparent",
        )}
      >
        <span>{children}</span>
        <Pencil aria-hidden className="size-3 text-primary" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="bottom" align="start" sideOffset={8} className="isolate z-50 max-[900px]:w-(--anchor-width)">
          <Popover.Popup className="w-[380px] origin-(--transform-origin) rounded-2xl bg-neutral-100 px-4 py-3.5 text-[12.5px] shadow-lg outline-none max-[900px]:w-full data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            <Popover.Title className="sr-only">{label}</Popover.Title>
            {panel}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
