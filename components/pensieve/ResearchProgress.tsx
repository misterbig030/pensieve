"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle, Search, X } from "lucide-react";
import { KIND_LABEL } from "@/lib/schemas/material";
import type { ResearchLogEntry, ResearchProgressState } from "@/lib/researchProgress";
import { cn } from "@/lib/utils";

const SHOWN_LOG = 8;

/** The card shown while research runs: counters against the caps, a live log, and what has been found so far. */
export function ResearchProgress({ state, totalHours }: { state: ResearchProgressState; totalHours?: number }) {
  const elapsed = useElapsed(state.startedAt, state.running);
  const log = state.log.slice(-SHOWN_LOG);
  const readCap = Math.max(state.caps.fetches, state.reads);

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Research progress" className="flex flex-col gap-4 rounded-[28px] bg-secondary px-[22px] pt-5 pb-[22px]">
        <div className="flex items-center gap-2.5">
          {state.running ? (
            <LoaderCircle className="size-[18px] animate-spin text-accent-700" strokeWidth={2.75} />
          ) : (
            <Check className="size-[18px] text-accent-2-700" strokeWidth={2.75} />
          )}
          <h2 className="m-0 font-heading text-lg font-normal">{state.running ? "Finding materials" : "Materials found"}</h2>
          <span className="ml-auto text-[12.5px] text-muted-foreground">
            {formatElapsed(elapsed)}
            {state.running ? " · usually a minute or two" : ""}
          </span>
        </div>
        <p className="m-0 text-[13.5px] leading-normal text-neutral-800">
          {totalHours ? `Your plan has about ${totalHours} hours in all. ` : ""}Looking for a textbook to build the plan around, plus current, well-regarded material to go with it, and working out how long each takes. How much of it is required reading is the plan&apos;s call, not research&apos;s.
        </p>

        <div className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1">
          <Counter label="Searches" value={state.searches} of={state.caps.searches} />
          <Counter label="Pages read" value={state.reads} of={readCap} />
          <Counter label="Verified" value={state.verified} extra={state.dropped > 0 ? `· ${state.dropped} dropped` : undefined} of={Math.max(1, state.verified + state.dropped)} good />
        </div>

        {(log.length > 0 || state.reading) && (
          <ol aria-label="Research log" aria-live="polite" className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
            {log.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
            {state.reading && (
              <li className="flex min-w-0 items-center gap-2.5 rounded-xl bg-background px-1 py-[7px]">
                <LoaderCircle className="size-[15px] shrink-0 animate-spin text-accent-700" strokeWidth={2.75} />
                <span className="min-w-[86px] font-semibold text-accent-700">Reading</span>
                <span className="min-w-0 truncate font-mono text-xs">{state.reading.replace(/^https:\/\/(www\.)?/, "")}</span>
              </li>
            )}
          </ol>
        )}
      </section>

      {state.found.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <span className="text-[11px] tracking-wide text-muted-foreground uppercase">Found so far</span>
          <div className="flex flex-wrap gap-2 text-xs">
            {state.found.map((f) => (
              <span
                key={f.id}
                className={cn(
                  "rounded-full px-[11px] py-[5px] animate-in fade-in",
                  f.backbone ? "bg-accent-2-800 font-semibold text-accent-2-100" : "bg-secondary",
                )}
              >
                {KIND_LABEL[f.kind].replace(/s$/, "")} · {f.title}
                {f.yours ? " · yours" : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Counter({ label, value, of, extra, good = false }: { label: string; value: number; of: number; extra?: string; good?: boolean }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, of)) * 100));
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl bg-background px-3.5 py-3">
      <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className={cn("text-xl font-semibold", good && "text-accent-2-800")}>
        {value}{" "}
        <span className="text-[13px] font-normal text-muted-foreground">{extra ?? `of ${of}`}</span>
      </span>
      <span className="block h-1.5 rounded-full bg-neutral-300">
        <span className={cn("block h-1.5 rounded-full transition-[width]", good ? "bg-accent-2-700" : "bg-accent-700")} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

const LOG_LABEL: Record<ResearchLogEntry["kind"], string> = {
  source: "Your source",
  searched: "Searched",
  verified: "Verified",
  dropped: "Dropped",
  failed: "Couldn't open",
};

function LogLine({ entry }: { entry: ResearchLogEntry }) {
  const muted = entry.kind === "dropped" || entry.kind === "failed";
  return (
    <li className={cn("flex min-w-0 items-center gap-2.5 px-1 py-[7px] animate-in fade-in", muted && "text-muted-foreground")}>
      {entry.kind === "searched" ? (
        <Search className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={2.75} />
      ) : muted ? (
        <X className="size-[15px] shrink-0 text-neutral-600" strokeWidth={2.75} />
      ) : (
        <Check className="size-[15px] shrink-0 text-accent-2-700" strokeWidth={2.75} />
      )}
      <span className={cn("min-w-[86px] shrink-0", !muted && "text-muted-foreground")}>{LOG_LABEL[entry.kind]}</span>
      <span className={cn("min-w-0 truncate", entry.kind === "searched" && "font-mono text-xs", entry.kind === "dropped" && "line-through")}>{entry.text}</span>
      {entry.detail && <span className="min-w-0 shrink truncate text-muted-foreground max-[640px]:hidden">· {entry.detail}</span>}
      {entry.backbone && (
        <span className="ml-auto inline-flex shrink-0 rounded-full bg-accent-2-800 px-[9px] py-[3px] text-[11px] font-semibold text-accent-2-100">Backbone</span>
      )}
    </li>
  );
}

function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return Math.max(0, now - startedAt);
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
