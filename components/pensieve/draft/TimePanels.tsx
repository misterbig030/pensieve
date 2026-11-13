"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DaysPerWeekPicker } from "@/components/pensieve/DaysPerWeekPicker";
import { SplitBreakdown } from "@/components/pensieve/SplitBreakdown";
import type { Material } from "@/lib/schemas/material";
import { splitBar } from "@/lib/splitBar";
import { HOURS_PRESETS, MAX_HOURS_PER_WEEK, MIN_HOURS_PER_WEEK, SPLIT_SET_BY_LEARNER, clampHours, shareAdjustable, type PlanSplit } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

const label = "text-[11px] tracking-wide text-muted-foreground uppercase";
const note = "m-0 text-xs leading-normal text-muted-foreground";

/** What the "hours a week" number opens: the presets and a free number. */
export function HoursPanel({ hoursPerWeek, disabled, onChange }: { hoursPerWeek: number; disabled: boolean; onChange: (hours: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={label}>Time you can give</span>
      <div className="flex flex-wrap items-center gap-2">
        {HOURS_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={hoursPerWeek === p.hours}
            disabled={disabled}
            onClick={() => onChange(p.hours)}
            className={cn("min-h-11 rounded-full border px-4 text-[13px]", hoursPerWeek === p.hours ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent hover:bg-accent-100")}
          >
            {p.label} · {p.hours} h
          </button>
        ))}
        <label className="inline-flex items-center gap-2 text-[13px]">
          <span className="sr-only">Hours a week</span>
          <Input
            type="number"
            min={MIN_HOURS_PER_WEEK}
            max={MAX_HOURS_PER_WEEK}
            className="w-[76px]"
            disabled={disabled}
            value={hoursPerWeek}
            onChange={(e) => {
              if (e.target.value) onChange(clampHours(Number(e.target.value)));
            }}
          />
          <span className="text-muted-foreground">hours a week</span>
        </label>
      </div>
      <p className={note}>The open weeks get re-drafted for it.</p>
    </div>
  );
}

/** What the "days a week" number opens. */
export function DaysPanel({ daysPerWeek, disabled, onChange }: { daysPerWeek: number; disabled: boolean; onChange: (days: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span id="days-change-label" className={label}>
        Days a week
      </span>
      <DaysPerWeekPicker labelId="days-change-label" value={daysPerWeek} onChange={onChange} disabled={disabled} />
      <p className={note}>Applies to weeks you split from now on. Weeks already split keep their days.</p>
    </div>
  );
}

/** What the reading share opens: the breakdown, anything with no source, and the slider that moves the share. */
export function ReadingPanel({
  split,
  deciding,
  totalHours,
  materials,
  disabled,
  onChange,
}: {
  split: PlanSplit | null;
  deciding: boolean;
  totalHours: number;
  materials: Pick<Material, "id" | "practice" | "minutes">[];
  disabled: boolean;
  onChange: (split: PlanSplit) => void;
}) {
  if (!split) {
    return deciding ? (
      <p className="m-0 text-[13px] leading-normal text-neutral-800">The plan decides how to divide this between reading and practice as it drafts the first units.</p>
    ) : (
      <Button
        variant="secondary"
        size="sm"
        className="min-h-10 self-start border border-border bg-transparent px-4 text-[12.5px]"
        disabled={disabled}
        onClick={() => onChange({ readingShare: 50, practice: "practice", reason: SPLIT_SET_BY_LEARNER })}
      >
        Divide the time between reading and practice
      </Button>
    );
  }
  const { toReading } = splitBar(split, materials);
  return (
    <div className="flex flex-col gap-3">
      <SplitBreakdown split={split} totalHours={totalHours} materials={materials} />
      {toReading.map((l) => (
        <span key={l} className="text-[12px] text-muted-foreground">
          {l} · no source found, so its time is reading
        </span>
      ))}
      {shareAdjustable(split) ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="share" className={label}>
            Reading and watching: {split.readingShare}% of your time
          </label>
          <input
            id="share"
            type="range"
            min={0}
            max={100}
            step={5}
            disabled={disabled}
            value={split.readingShare}
            onChange={(e) => onChange({ ...split, readingShare: Number(e.target.value), reason: SPLIT_SET_BY_LEARNER })}
            className="h-11 w-full max-w-[420px] accent-(--color-accent-700)"
          />
        </div>
      ) : (
        <p className={note}>All reading: no practice was picked for this topic, so there is no share to move.</p>
      )}
    </div>
  );
}
