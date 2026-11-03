"use client";

import { useEffect, useRef, useState } from "react";
import type { Material } from "@/lib/schemas/material";
import { splitBar } from "@/lib/splitBar";
import { SPLIT_SET_BY_LEARNER, type PlanSplit } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

const caption = "text-[10.5px] font-semibold tracking-[.05em] text-muted-foreground uppercase";
const link = "text-[12px] font-semibold text-primary hover:underline";

/**
 * The plan at a glance, above the outline: its summary in two lines, and how its hours split between reading and each
 * kind of practice. A plan saved before splits existed shows the summary alone.
 */
export function PlanGlance({ summary, totalHours, split, materials }: { summary: string; totalHours: number; split: PlanSplit | null; materials: Material[] }) {
  return (
    <section
      aria-label="The plan at a glance"
      className={cn("elev-sm mb-5 grid items-start gap-7 rounded-[18px] bg-neutral-100 px-[18px] py-3.5", split && "grid-cols-[minmax(0,1fr)_470px] max-[900px]:grid-cols-1")}
    >
      <Summary text={summary} />
      {split && <Split split={split} totalHours={totalHours} materials={materials} />}
    </section>
  );
}

function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // "More" only when two lines don't hold the whole summary; measured once laid out, and again as the width changes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className={caption}>The plan</span>
      <p ref={ref} className={cn("m-0 text-[13px] leading-normal", !open && "line-clamp-2")}>
        {text}
      </p>
      {(clipped || open) && (
        <button type="button" className={link} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

function Split({ split, totalHours, materials }: { split: PlanSplit; totalHours: number; materials: Material[] }) {
  const { parts } = splitBar(split, materials);
  const learner = split.reason === SPLIT_SET_BY_LEARNER;
  const legend = (label: string, kind: string) => (kind === "reading" ? "Reading" : label);
  return (
    <div className="flex flex-col gap-[7px]">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={caption}>How the {totalHours} h split</span>
        <span className="ml-auto inline-flex items-baseline gap-1.5 text-[11.5px] text-muted-foreground">
          {learner ? "Your call" : "The plan’s call"}
          {!learner && split.reason && <Why reason={split.reason} />}
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
