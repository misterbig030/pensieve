"use client";

import { useEffect, useRef, useState } from "react";
import type { Material } from "@/lib/schemas/material";
import { splitBar } from "@/lib/splitBar";
import { SPLIT_FROM_FILE, SPLIT_SET_BY_LEARNER, type PlanSplit } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

const caption = "text-[10.5px] font-semibold tracking-[.05em] text-muted-foreground uppercase";
const link = "text-[12px] font-semibold text-primary hover:underline";

/** How a plan's hours split between reading and each kind of practice, with who decided it. Shared by the plan page and the draft page. */
export function SplitBreakdown({ split, totalHours, materials }: { split: PlanSplit; totalHours: number; materials: Pick<Material, "id" | "practice" | "minutes">[] }) {
  const { parts } = splitBar(split, materials);
  const learner = split.reason === SPLIT_SET_BY_LEARNER;
  const fromFile = split.reason === SPLIT_FROM_FILE;
  const legend = (label: string, kind: string) => (kind === "reading" ? "Reading" : label);
  return (
    <div className="flex flex-col gap-[7px]">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={caption}>How the {totalHours} h split</span>
        <span className="ml-auto inline-flex items-baseline gap-1.5 text-[11.5px] text-muted-foreground">
          {learner ? "Your call" : fromFile ? "From your file" : "The plan’s call"}
          {!learner && !fromFile && split.reason && <Why reason={split.reason} />}
        </span>
      </div>
      <div role="img" aria-label={parts.map((p) => `${legend(p.label, p.kind)} ${p.percent}%`).join(", ")} className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {parts.map((p) => (
          <span key={p.key} className={cn("block", p.shade)} style={{ width: `${p.width}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px]">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <span className={cn("block size-2 rounded-[2px]", p.shade)} />
            {legend(p.label, p.kind)} · {p.percent}%
          </span>
        ))}
      </div>
    </div>
  );
}

/** The split's reason in a small popover, closed by Escape or a click outside it. */
function Why({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={link}>
        Why
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="Why the plan splits its time this way"
          className="absolute top-6 right-0 z-20 block w-[320px] max-w-[calc(100vw-48px)] rounded-2xl bg-neutral-900 px-4 py-3 text-[12.5px] leading-normal text-neutral-100 shadow-md"
        >
          {reason}
        </span>
      )}
    </span>
  );
}
