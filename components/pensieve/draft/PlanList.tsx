"use client";

import { useState } from "react";
import { ChevronDown, Lock, Minus, Plus } from "lucide-react";
import { CoversRow, type PendingSlots } from "@/components/pensieve/PlanTree";
import { coverPracticeRows, practiceRowsFor, readRowsFor, sumPracticeMinutes, type PracticeRow, type ReadRow } from "@/components/pensieve/ReadTable";
import { DayCards, PracticeSection, ReadSection } from "@/components/pensieve/draft/UnitRows";
import { Button } from "@/components/ui/button";
import { rowLine, touches, unitHours } from "@/lib/draftPage";
import { budgetMinutes, keptReadTable } from "@/lib/materials";
import { childLevel, isHeading, isLocked, labelOf, MAX_DAYS_PER_WEEK, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { formatUnitTime } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

export type WeekView = "week" | "days";

export interface PlanListProps {
  root: PlanNode;
  materials: Material[];
  hoursPerWeek: number;
  daysPerWeek: number;
  /** Ids of the open rows (from `openRows()`). */
  open: ReadonlySet<string>;
  /** A week with days defaults to "days". */
  weekView: ReadonlyMap<string, WeekView>;
  /** Node ids the latest chat change touched. */
  highlight: ReadonlySet<string>;
  lockBefore: number;
  currentLeafId: string | null;
  pending: Readonly<Record<string, PendingSlots>>;
  /** Streaming, busy or redrafting: nothing can be planned or split. */
  busy: boolean;
  onToggleOpen: (id: string) => void;
  onSetView: (id: string, view: WeekView) => void;
  /** Plan a heading in detail. */
  onExpand: (id: string) => void;
  onSplit: (id: string, days: number) => void;
}

type Ctx = PlanListProps & { byId: ReadonlyMap<string, Material> };

export function PlanList(props: PlanListProps) {
  const ctx: Ctx = { ...props, byId: new Map(props.materials.map((m) => [m.id, m])) };
  const slots = props.pending[props.root.id];
  return (
    <div className="flex flex-col gap-2.5">
      {(props.root.children ?? []).map((node) => (
        <Row key={node.id} node={node} depth={0} ctx={ctx} />
      ))}
      {slots && <Slots count={slots.count} />}
    </div>
  );
}

/** Grey rows for the units still to arrive; the first of a parent pulses. */
function Slots({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          data-slot
          aria-hidden
          className={cn("flex min-h-[58px] items-center gap-3.5 rounded-3xl bg-foreground/[0.04] px-[22px] text-[13px] text-muted-foreground max-[900px]:px-4", i === 0 && "animate-pulse", i > 1 && "bg-foreground/[0.03]")}
        >
          <span className="skeleton-bar h-[9px] w-14" />
          {i === 0 && <span className="skeleton-bar h-[9px] w-[46%] opacity-70" />}
        </div>
      ))}
    </>
  );
}

function Row({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  const { root } = ctx;
  const open = ctx.open.has(node.id);
  const locked = isLocked(node, ctx.lockBefore);
  const changed = touches(node, ctx.highlight);
  const heading = isHeading(node);
  const label = labelOf(root, node);
  const line = rowLine(node, ctx.byId);
  const time = node.time ? formatUnitTime(node.time) : "";
  const hours = unitHours(root, node, ctx.hoursPerWeek, ctx.daysPerWeek);
  const slots = ctx.pending[node.id];

  return (
    <div
      data-unit={node.id}
      data-changed={changed}
      className={cn(
        "flex min-w-0 animate-in flex-col rounded-3xl border border-transparent fade-in slide-in-from-bottom-1 duration-700",
        depth === 0 ? "bg-secondary" : "bg-background",
        changed && "border-accent-400",
        locked && "opacity-50",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => ctx.onToggleOpen(node.id)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-3.5 px-[22px] py-3.5 text-left max-[900px]:flex-wrap max-[900px]:gap-x-3 max-[900px]:px-4"
      >
        <span className="w-14 shrink-0 font-heading text-xs text-accent-700">{label}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 max-[900px]:basis-[calc(100%-5rem)]">
          <span className={cn("font-heading leading-snug", depth === 0 ? "text-[17px]" : "text-[15px]")}>{node.title}</span>
          {!open && (
            <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
              {heading ? "Not planned in detail yet · " : ""}
              {line}
            </span>
          )}
        </span>
        {locked && <Lock className="size-3 shrink-0 opacity-70" strokeWidth={2.75} aria-hidden />}
        {!open && <span className="shrink-0 text-xs text-muted-foreground">{hours} h</span>}
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} strokeWidth={2.75} aria-hidden />
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-[22px] pb-[18px] max-[900px]:px-4">
          {node.summary && <p className="m-0 text-[13px] leading-normal text-muted-foreground">{node.summary}</p>}
          {time && <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">{time}</p>}
          <Body node={node} depth={depth} heading={heading} locked={locked} label={label} ctx={ctx} />
          {slots && <Slots count={slots.count} />}
        </div>
      )}
    </div>
  );
}

function Body({ node, depth, heading, locked, label, ctx }: { node: PlanNode; depth: number; heading: boolean; locked: boolean; label: string; ctx: Ctx }) {
  const { root, byId } = ctx;
  if (heading) {
    const canPlan = !locked && !ctx.busy;
    return (
      <>
        <CoversRow node={node} byId={byId} />
        {canPlan && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" className="min-h-10 border border-border px-4 text-[12.5px]" onClick={() => ctx.onExpand(node.id)}>
              {`Plan ${label} ${childLevel(node.level) === "week" ? "week by week" : "day by day"}`}
            </Button>
            <span className="text-xs text-muted-foreground">Or leave it: the plan page has the same button.</span>
          </div>
        )}
      </>
    );
  }
  if (node.level === "month") {
    return (
      <div className="flex flex-col gap-2">
        {(node.children ?? []).map((child) => (
          <Row key={child.id} node={child} depth={depth + 1} ctx={ctx} />
        ))}
      </div>
    );
  }
  if (node.level === "day") return <Sections {...sectionsFor(node, ctx)} />;

  // A week.
  const kids = node.children ?? [];
  const hasDays = kids.length > 0;
  const view = ctx.weekView.get(node.id) ?? (hasDays ? "days" : "week");
  const showToggle = hasDays && !locked;
  const showDays = hasDays && (locked ? false : view === "days");
  return (
    <>
      {showToggle && (
        <div role="group" aria-label={`${label} view`} className="inline-flex w-fit gap-0.5 rounded-full bg-foreground/[0.06] p-0.5 text-xs">
          {(["week", "days"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => ctx.onSetView(node.id, v)}
              className={cn("min-h-8 cursor-pointer rounded-full px-3.5 font-semibold capitalize", view === v ? "bg-background shadow-sm" : "text-muted-foreground")}
            >
              {v === "week" ? "Week" : "Days"}
            </button>
          ))}
        </div>
      )}
      {showDays ? <DayCards root={root} week={node} byId={byId} lockBefore={ctx.lockBefore} currentLeafId={ctx.currentLeafId} /> : <Sections {...sectionsFor(node, ctx)} />}
      {!hasDays && !locked && <SplitBar usual={ctx.daysPerWeek} busy={ctx.busy} onSplit={(n) => ctx.onSplit(node.id, n)} />}
    </>
  );
}

interface SectionData {
  read: ReadRow[];
  practice: PracticeRow[];
  budget: number;
}

/** What an open week or day lists: its own tables, a hand-split week's kept ones, or every day's together. */
function sectionsFor(node: PlanNode, ctx: Ctx): SectionData {
  const { byId } = ctx;
  if (node.level === "day") {
    return { read: readRowsFor(node.materials, byId), practice: practiceRowsFor(node.practice, byId), budget: budgetMinutes(node, ctx.hoursPerWeek, ctx.daysPerWeek) };
  }
  const budget = unitHours(ctx.root, node, ctx.hoursPerWeek, ctx.daysPerWeek) * 60;
  const kids = node.children ?? [];
  if (kids.length === 0) return { read: readRowsFor(node.materials, byId), practice: practiceRowsFor(node.practice, byId), budget };
  if (node.manualSplit) return { read: readRowsFor(keptReadTable(node.covers), byId), practice: coverPracticeRows(node.practiceCovers, byId), budget };
  return {
    read: kids.flatMap((d) => readRowsFor(d.materials, byId)),
    practice: kids.flatMap((d) => practiceRowsFor(d.practice, byId)),
    budget,
  };
}

function Sections({ read, practice, budget }: SectionData) {
  if (read.length === 0 && practice.length === 0) return null;
  // Combined rows of several days can repeat a key; the sections only need them distinct among siblings.
  const keyed = <T extends { key: string }>(rows: T[]): T[] => rows.map((r, i) => ({ ...r, key: `${r.key}:${i}` }));
  return (
    <div className="flex flex-col gap-3.5">
      {read.length > 0 && <ReadSection rows={keyed(read)} budgetMinutes={budget} practiceMinutes={sumPracticeMinutes(practice)} />}
      {practice.length > 0 && <PracticeSection rows={keyed(practice)} />}
    </div>
  );
}

/** "Not split into days yet." with a − n days + stepper and the button that splits the week. */
function SplitBar({ usual, busy, onSplit }: { usual: number; busy: boolean; onSplit: (days: number) => void }) {
  const [n, setN] = useState(usual);
  const step = "inline-flex size-8 cursor-pointer items-center justify-center rounded-full hover:bg-foreground/[0.07] disabled:cursor-default disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-foreground/[0.04] px-3.5 py-2.5 text-[12.5px]">
      <span className="flex-[1_1_160px] text-muted-foreground">Not split into days yet.</span>
      <span className="inline-flex items-center gap-1">
        <button type="button" className={step} aria-label="One day fewer" disabled={n <= 1} onClick={() => setN(n - 1)}>
          <Minus className="size-3.5" aria-hidden />
        </button>
        <span className="min-w-[3.5rem] text-center">{n === 1 ? "1 day" : `${n} days`}</span>
        <button type="button" className={step} aria-label="One day more" disabled={n >= MAX_DAYS_PER_WEEK} onClick={() => setN(n + 1)}>
          <Plus className="size-3.5" aria-hidden />
        </button>
      </span>
      <Button variant="secondary" size="sm" className="min-h-10 border border-border px-4 text-[12.5px]" disabled={busy} onClick={() => onSplit(n)}>
        Split into days
      </Button>
    </div>
  );
}
