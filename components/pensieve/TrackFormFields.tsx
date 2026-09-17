"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GranularityChoice } from "@/lib/planTree";
import { detectSourceType, type SourceInput, type SourceType } from "@/lib/schemas/source";
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
  instructions: string;
  sources: SourceInput[];
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
