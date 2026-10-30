"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DaysPerWeekPicker } from "@/components/pensieve/DaysPerWeekPicker";
import { splitPercents } from "@/lib/materials";
import { capitalize } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { HOURS_PRESETS, MAX_HOURS_PER_WEEK, MIN_HOURS_PER_WEEK, SPLIT_SET_BY_LEARNER, clampHours, presetFor, shareAdjustable, totalHours, type PlanSplit } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

/** Shades of the practice colour, one per picked format, darkest first. */
const PICK_SHADES = ["bg-accent-2-700", "bg-accent-2-500", "bg-accent-2-300", "bg-accent-2-200"];

export interface TimeSplitCardProps {
  /** The plan's length in weeks. */
  weeks: number;
  hoursPerWeek: number;
  /** The learner's usual study days a week. */
  daysPerWeek: number;
  /** Null while the first units are still drafting, and on plans saved before splits existed. */
  split: PlanSplit | null;
  /** The plan's materials: a pick with no source to assign is drafted as reading, and shown so. */
  materials: Pick<Material, "id" | "practice" | "minutes">[];
  /** True while the top level is drafting: the split is on its way. */
  deciding?: boolean;
  /** Omit all three for a read-only card. */
  onChangeHours?: (hours: number) => void;
  onChangeDays?: (days: number) => void;
  onChangeSplit?: (split: PlanSplit) => void;
  disabled?: boolean;
}

/**
 * The learner's weekly hours and how the plan divides them. The split is the drafter's decision, shown with its
 * reason; the learner can overrule it and change the hours.
 */
export function TimeSplitCard({ weeks, hoursPerWeek, daysPerWeek, split, materials, deciding = false, onChangeHours, onChangeDays, onChangeSplit, disabled = false }: TimeSplitCardProps) {
  const [editing, setEditing] = useState(false);
  const total = totalHours(weeks, hoursPerWeek);
  const preset = presetFor(hoursPerWeek);
  const editable = !!onChangeHours || !!onChangeDays || !!onChangeSplit;
  const { reading, practice, picks } = split ? splitPercents(split, materials) : { reading: 0, practice: 0, picks: [] };
  // A pick drafted as reading widens the reading bar by its share of the practice time.
  const practiceShare = (share: number) => ((100 - (split?.readingShare ?? 0)) * share) / 100;
  const toReading = new Set(picks.filter((p) => p.toReading).map((p) => p.format));
  const readingWidth = (split?.readingShare ?? 0) + (split?.formats ?? []).filter((p) => toReading.has(p.format)).reduce((sum, p) => sum + practiceShare(p.share), 0);

  return (
    <section aria-labelledby="time-h" className="flex flex-col gap-2.5 rounded-[28px] bg-secondary px-[22px] py-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 id="time-h" className="m-0 text-[11px] font-normal tracking-wide text-muted-foreground uppercase">
          How this plan spends your {total} h
        </h2>
        {split && (
          <span className="inline-flex rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-semibold">
            {split.reason === SPLIT_SET_BY_LEARNER ? "Your call" : "The plan\u2019s call"}
          </span>
        )}
        <span className="ml-auto text-[12.5px] text-muted-foreground max-[640px]:ml-0">
          {hoursPerWeek} h a week · {daysPerWeek} day{daysPerWeek === 1 ? "" : "s"} a week{preset ? ` · ${preset.label.toLowerCase()}` : ""}
        </span>
        {editable && (
          <Button
            variant="secondary"
            size="sm"
            className="min-h-10 border border-border bg-transparent px-4 text-[12.5px]"
            aria-expanded={editing}
            disabled={disabled && !editing}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : "Change"}
          </Button>
        )}
      </div>

      {split ? (
        <>
          <div aria-hidden="true" className="flex h-3 overflow-hidden rounded-full bg-neutral-300">
            <span className="block bg-accent-700 transition-[width]" style={{ width: `${readingWidth}%` }} />
            {picks.length > 0 ? (
              (split.formats ?? []).map((p, i) =>
                toReading.has(p.format) ? null : <span key={p.format} className={cn("block", PICK_SHADES[i % PICK_SHADES.length])} style={{ width: `${practiceShare(p.share)}%` }} />,
              )
            ) : (
              <span className="block grow bg-accent-2-700" />
            )}
          </div>
          <div className="flex flex-wrap gap-x-[18px] gap-y-1 text-[12.5px]">
            <span className="inline-flex items-center gap-1.5">
              <span className="block size-2.5 rounded-[3px] bg-accent-700" />
              Reading and watching · {reading}%
            </span>
            {picks.length > 0
              ? picks.map((p, i) =>
                  p.toReading ? (
                    <span key={p.format} className="text-muted-foreground">
                      {p.label} · no source found, so its time is reading
                    </span>
                  ) : p.percent > 0 ? (
                    <span key={p.format} className="inline-flex items-center gap-1.5">
                      <span className={cn("block size-2.5 shrink-0 rounded-[3px]", PICK_SHADES[i % PICK_SHADES.length])} />
                      <span>
                        {p.label} · {p.percent}% <span className="text-muted-foreground">— {p.focus}</span>
                      </span>
                    </span>
                  ) : null,
                )
              : practice > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="block size-2.5 rounded-[3px] bg-accent-2-700" />
                    {capitalize(split.practice)} · {practice}%
                  </span>
                )}
          </div>
          {split.reason && split.reason !== SPLIT_SET_BY_LEARNER && <p className="m-0 text-[12.5px] leading-normal text-neutral-800">Why: {split.reason}</p>}
        </>
      ) : (
        <p className="m-0 text-[13px] leading-normal text-neutral-800">
          {deciding
            ? "The plan decides how to divide this between reading and practice as it drafts the first units."
            : "This plan does not divide its time between reading and practice. Units are budgeted from the weekly hours alone."}
        </p>
      )}

      {editing && (
        <div className="mt-1 flex flex-col gap-3.5 rounded-[18px] bg-background px-4 py-3.5">
          {onChangeHours && (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] tracking-wide text-muted-foreground uppercase">Time you can give</span>
              <div className="flex flex-wrap items-center gap-2">
                {HOURS_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    aria-pressed={hoursPerWeek === p.hours}
                    disabled={disabled}
                    onClick={() => onChangeHours(p.hours)}
                    className={cn(
                      "min-h-11 rounded-full border px-4 text-[13px]",
                      hoursPerWeek === p.hours ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent hover:bg-accent-100",
                    )}
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
                      if (e.target.value) onChangeHours(clampHours(Number(e.target.value)));
                    }}
                  />
                  <span className="text-muted-foreground">hours a week</span>
                </label>
              </div>
            </div>
          )}
          {onChangeDays && (
            <div className="flex flex-col gap-2">
              <span id="days-change-label" className="text-[11px] tracking-wide text-muted-foreground uppercase">
                Days a week
              </span>
              <DaysPerWeekPicker labelId="days-change-label" value={daysPerWeek} onChange={onChangeDays} disabled={disabled} />
              <p className="m-0 text-xs leading-normal text-muted-foreground">Applies to weeks you split from now on. Weeks already split keep their days.</p>
            </div>
          )}
          {onChangeSplit && split && !shareAdjustable(split) && (
            <p className="m-0 text-xs leading-normal text-muted-foreground">All reading: no practice was picked for this topic, so there is no share to move.</p>
          )}
          {onChangeSplit && split && shareAdjustable(split) && (
            <div className="flex flex-col gap-2">
              <label htmlFor="share" className="text-[11px] tracking-wide text-muted-foreground uppercase">
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
                onChange={(e) => onChangeSplit({ ...split, readingShare: Number(e.target.value), reason: SPLIT_SET_BY_LEARNER })}
                className="h-11 w-full max-w-[420px] accent-(--color-accent-700)"
              />
            </div>
          )}
          {onChangeSplit && !split && (
            <Button
              variant="secondary"
              size="sm"
              className="min-h-10 self-start border border-border bg-transparent px-4 text-[12.5px]"
              disabled={disabled}
              onClick={() => onChangeSplit({ readingShare: 50, practice: "practice", reason: SPLIT_SET_BY_LEARNER })}
            >
              Divide the time between reading and practice
            </Button>
          )}
          <p className="m-0 text-xs leading-normal text-muted-foreground">
            Open weeks take the new hours at once. Reading lists already planned stay as they are; units planned from here on use the new numbers.
          </p>
        </div>
      )}
    </section>
  );
}
