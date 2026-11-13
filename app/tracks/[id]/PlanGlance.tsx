"use client";

import { useEffect, useRef, useState } from "react";
import { SplitBreakdown } from "@/components/pensieve/SplitBreakdown";
import type { Material } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
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
      {split && <SplitBreakdown split={split} totalHours={totalHours} materials={materials} />}
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
