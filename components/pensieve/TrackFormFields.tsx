"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GranularityChoice } from "@/lib/planTree";
import { detectSourceType, type SourceInput, type SourceType } from "@/lib/schemas/source";
import { HOURS_PRESETS, MAX_HOURS_PER_WEEK, MIN_HOURS_PER_WEEK, clampHours, hoursInText, presetFor, totalHours } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

const DAY_PRESETS = [7, 30, 90, 180];

const GRANULARITY_OPTIONS: { key: GranularityChoice; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "auto", label: "Auto" },
];

const GRANULARITY_HINT: Record<GranularityChoice, string> = {
  day: "One lesson and one check-in per day.",
  week: "Weekly goals with a time budget; log study sessions as you go.",
  auto: "Days for short plans, weeks for long ones.",
};

const SOURCE_CHIP: Record<SourceType, { kicker: string; variant: "accent2" | "tagOutline" | "accent" | "neutral" }> = {
  youtube: { kicker: "YouTube · ", variant: "accent2" },
  link: { kicker: "Link · ", variant: "tagOutline" },
  file: { kicker: "File · ", variant: "accent" },
  note: { kicker: "Topic · ", variant: "neutral" },
};

function sourceLabel(source: SourceInput): string {
  if (source.type === "note") return source.url;
  return source.url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

export interface TrackFormValue {
  topic: string;
  days: number | "";
  granularity: GranularityChoice;
  /** Hours a week the learner can give; empty while the custom field is being typed. */
  hoursPerWeek: number | "";
  instructions: string;
  sources: SourceInput[];
}

/** "12 weeks" for whole weeks, otherwise "30 days". */
function lengthLabel(days: number): string {
  return days % 7 === 0 && days >= 14 ? `${days / 7} weeks` : `${days} day${days === 1 ? "" : "s"}`;
}

interface TrackFormFieldsProps {
  value: TrackFormValue;
  onChange: (value: TrackFormValue) => void;
  topicPlaceholder?: string;
}

export function TrackFormFields({ value, onChange, topicPlaceholder }: TrackFormFieldsProps) {
  const [sourceDraft, setSourceDraft] = useState("");

  function addSource() {
    const text = sourceDraft.trim();
    if (!text) return;
    const type = detectSourceType(text);
    onChange({ ...value, sources: [...value.sources, { url: text, type }] });
    setSourceDraft("");
  }

  function removeSource(url: string) {
    onChange({ ...value, sources: value.sources.filter((s) => s.url !== url) });
  }

  const hours = value.hoursPerWeek;
  const customHours = hours !== "" && !presetFor(hours);
  // A brief that names its own number of hours is flagged, never silently followed: the setting is what counts.
  const stated = hoursInText(value.instructions);

  return (
    <div className="flex flex-col gap-[22px]">
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] tracking-wide text-muted-foreground uppercase">Topic</label>
        <Input
          placeholder={topicPlaceholder ?? "e.g. System design interviews"}
          value={value.topic}
          onChange={(e) => onChange({ ...value, topic: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-7 gap-y-5 max-[640px]:grid-cols-1">
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] tracking-wide text-muted-foreground uppercase">Length</label>
          <div className="flex flex-wrap items-center gap-2">
            {DAY_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onChange({ ...value, days: n })}
                className={cn(
                  "rounded-full border px-[18px] py-[7px] text-[13px]",
                  value.days === n
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-transparent text-foreground hover:bg-accent-100",
                )}
              >
                {n} days
              </button>
            ))}
            <span className="inline-flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={365}
                placeholder="Custom"
                className="w-[90px]"
                value={DAY_PRESETS.includes(value.days as number) ? "" : value.days}
                onChange={(e) => {
                  const n = e.target.value ? Number(e.target.value) : "";
                  onChange({ ...value, days: n === "" ? "" : Math.min(Math.max(n, 1), 365) });
                }}
              />
              <span className="text-[13px] text-muted-foreground">days</span>
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] tracking-wide text-muted-foreground uppercase">Working unit</label>
          <div className="flex flex-wrap gap-2">
            {GRANULARITY_OPTIONS.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => onChange({ ...value, granularity: g.key })}
                className={cn(
                  "rounded-full border px-[18px] py-[7px] text-[13px]",
                  value.granularity === g.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-transparent text-foreground hover:bg-accent-100",
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
          <p className="m-0 text-xs opacity-55">{GRANULARITY_HINT[value.granularity]}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2.5 rounded-[22px] bg-secondary px-5 pt-[18px] pb-5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span id="hours-label" className="text-[11px] tracking-wide text-muted-foreground uppercase">
            Time you can give
          </span>
          <span className="text-xs text-muted-foreground">Be honest: you can change it later.</span>
        </div>
        <div role="group" aria-labelledby="hours-label" className="flex flex-wrap items-stretch gap-2">
          {HOURS_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={hours === p.hours}
              onClick={() => onChange({ ...value, hoursPerWeek: p.hours })}
              className={cn(
                "flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-[18px] border px-[18px] py-2 text-left",
                hours === p.hours ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent text-foreground hover:bg-accent-100",
              )}
            >
              <span className="text-[13.5px] font-semibold">{p.label}</span>
              <span className="text-xs opacity-85">about {p.hours} h a week</span>
            </button>
          ))}
          <label className={cn("flex min-h-14 items-center gap-2 rounded-[18px] border px-3.5", customHours ? "border-primary" : "border-border")}>
            <span className="text-[13.5px] font-semibold">Custom</span>
            <Input
              type="number"
              min={MIN_HOURS_PER_WEEK}
              max={MAX_HOURS_PER_WEEK}
              placeholder="e.g. 10"
              className="w-[76px] bg-background"
              value={hours !== "" && presetFor(hours) ? "" : hours}
              onChange={(e) => onChange({ ...value, hoursPerWeek: e.target.value ? clampHours(Number(e.target.value)) : "" })}
            />
            <span className="text-[13px] text-muted-foreground">hours a week</span>
          </label>
        </div>
        {hours !== "" && value.days !== "" && (
          <p role="status" className="m-0 text-[13.5px] leading-normal text-neutral-800">
            <strong className="font-semibold">
              {capitalizeFirst(lengthLabel(value.days))} at {hours} h a week is about {totalHours(value.days, hours)} hours.
            </strong>{" "}
            Pensieve finds and sizes material for the topic, then the plan decides how those hours are spent: reading, practice, or whatever the topic calls for.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] tracking-wide text-muted-foreground uppercase">
          Focus & instructions <span className="opacity-70 normal-case">(optional)</span>
        </label>
        <Textarea
          placeholder="e.g. spend extra time on distributed transactions, or focus on the history of France within world history"
          rows={3}
          value={value.instructions}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
        />
        {stated !== null && hours !== "" && stated !== hours && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl bg-neutral-200 py-2.5 pr-2.5 pl-3.5 text-[13px] leading-normal">
            <span className="min-w-[200px] flex-1">
              Your notes say about {stated} hour{stated === 1 ? "" : "s"} a week, and the time setting is {hours}. The plan uses the setting.
            </span>
            <Button type="button" variant="secondary" size="sm" className="min-h-10 border border-border bg-background px-4 text-[12.5px]" onClick={() => onChange({ ...value, hoursPerWeek: stated })}>
              Use {stated} h a week
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] tracking-wide text-muted-foreground uppercase">
          Materials <span className="opacity-70 normal-case">(optional)</span>
        </label>
        <div className="flex gap-2">
          <Input
            placeholder='e.g. a YouTube link, "Designing Data-Intensive Applications", or /path/to/notes.pdf'
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSource();
              }
            }}
          />
          <Button type="button" variant="secondary" onClick={addSource}>
            Add
          </Button>
        </div>
        {value.sources.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {value.sources.map((s) => (
              <Badge key={s.url} variant={SOURCE_CHIP[s.type].variant} className="gap-1.5">
                {SOURCE_CHIP[s.type].kicker}
                {sourceLabel(s)}
                <button type="button" onClick={() => removeSource(s.url)} className="opacity-55 hover:opacity-100">
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
