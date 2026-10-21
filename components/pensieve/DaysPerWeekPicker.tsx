"use client";

import { MAX_DAYS_PER_WEEK } from "@/lib/planTree";
import { cn } from "@/lib/utils";

const DAYS = Array.from({ length: MAX_DAYS_PER_WEEK }, (_, i) => i + 1);

/** The learner's usual study days a week, as a row of round buttons 1–7. */
export function DaysPerWeekPicker({ value, onChange, disabled = false, labelId }: { value: number | ""; onChange: (days: number) => void; disabled?: boolean; labelId: string }) {
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
      {DAYS.map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value === n}
          aria-label={`${n} day${n === 1 ? "" : "s"} a week`}
          disabled={disabled}
          onClick={() => onChange(n)}
          className={cn(
            "inline-flex size-10 items-center justify-center rounded-full border text-[13px]",
            value === n ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent text-foreground hover:bg-accent-100",
          )}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
