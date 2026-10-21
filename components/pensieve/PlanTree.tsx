"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BudgetBar, ReadRows, partLabel, readRowsFor, rowBrief, sumMinutes } from "@/components/pensieve/ReadTable";
import { budgetMinutes } from "@/lib/materials";
import { formatDuration } from "@/lib/researchProgress";
import { chapterAt, type Material } from "@/lib/schemas/material";
import {
  capitalize,
  childLevel,
  doneDays,
  isLocked,
  labelOf,
  MAX_DAYS_PER_WEEK,
  spanOf,
  type PlanNode,
} from "@/lib/planTree";
import { dayMinutes, formatDayTime } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

export type PlanTreeMode = "create" | "adjust" | "track";

/** Skeleton slots still expected under a parent while its children stream in. */
export interface PendingSlots {
  count: number;
  /** True when the slots are headings (single-column cards) rather than leaf chips. */
  groups: boolean;
}

export interface PlanTreeProps {
  root: PlanNode;
  mode: PlanTreeMode;
  /** Node ids tinted as changed by the latest revision. */
  highlight: ReadonlySet<string>;
  lockBefore: number;
  currentLeafId: string | null;
  pending: Readonly<Record<string, PendingSlots>>;
  collapsed: ReadonlySet<string>;
  openChips: ReadonlySet<string>;
  /** Disables Expand / Split while the plan is streaming. */
  busy: boolean;
  onToggle: (id: string) => void;
  onToggleChip: (id: string) => void;
  onExpand: (id: string) => void;
  /** Splits a week leaf into `days` days. */
  onSplit: (id: string, days: number) => void;
  leafHref?: (node: PlanNode) => string;
  /** The plan's materials; node references resolve against them. */
  materials?: Material[];
  /** The learner's weekly hours: a day's budget is its share of them. */
  hoursPerWeek?: number;
  /** The learner's usual study days a week: what a week splits into unless they pick another number. */
  daysPerWeek: number;
  /** What the plan spends non-reading time on, for the budget lines. */
  practice?: string;
}

type Ctx = Omit<PlanTreeProps, "root"> & { root: PlanNode; byId: ReadonlyMap<string, Material> };

function gridClass(children: PlanNode[], pending?: PendingSlots): string {
  const groups = children.length > 0 ? children.every((c) => c.children !== null || childLevel(c.level) !== null && c.budgetHours === null) : !!pending?.groups;
  if (groups) return "grid-cols-[minmax(0,1fr)] gap-3.5";
  const weeks = children.some((c) => c.children === null && c.level !== "day");
  // Planned weeks show their whole Read list, which needs the full width.
  if (weeks && children.some((c) => (c.materials?.length ?? 0) > 0)) return "grid-cols-[minmax(0,1fr)] gap-2.5";
  return weeks ? "grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-2.5" : "grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2.5";
}

/** Whether a childless node is a heading (to be planned later) rather than a leaf the learner works at. */
function isHeading(node: PlanNode): boolean {
  return node.children === null && node.level !== "day" && node.budgetHours === null;
}

export function PlanTree(props: PlanTreeProps) {
  const { root, pending } = props;
  const children = root.children ?? [];
  const slots = pending[root.id];
  const ctx: Ctx = { ...props, byId: new Map((props.materials ?? []).map((m) => [m.id, m])) };
  return (
    <div className={cn("grid", gridClass(children, slots))}>
      {children.map((child) => (
        <NodeView key={child.id} node={child} depth={0} ctx={ctx} />
      ))}
      {slots && <Skeletons count={slots.count} groups={slots.groups} />}
    </div>
  );
}

function Skeletons({ count, groups }: PendingSlots) {
  return (
    <>
      {Array.from({ length: count }, (_, i) =>
        groups ? (
          <div key={`sk-${i}`} aria-hidden className="col-span-full flex flex-col gap-2.5 rounded-[28px] bg-secondary px-[18px] pt-4 pb-[18px]">
            <span className="skeleton-bar h-2.5 w-[52px]" />
            <span className="skeleton-bar h-4 w-[46%]" />
            <span className="skeleton-bar h-[11px] w-[78%] opacity-70" />
          </div>
        ) : (
          <div key={`sk-${i}`} aria-hidden className="flex flex-col gap-1.5 rounded-2xl border border-transparent bg-neutral-200 px-3.5 py-3">
            <span className="skeleton-bar mt-0.5 mb-1 h-2.5 w-[38px]" />
            <span className="skeleton-bar h-3 w-[82%]" />
            <span className="skeleton-bar h-3 w-[60%]" />
            <span className="skeleton-bar mt-1 h-2 w-[92%] opacity-70" />
          </div>
        ),
      )}
    </>
  );
}

function NodeView({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  if (isHeading(node) || node.children !== null) return <GroupCard node={node} depth={depth} ctx={ctx} />;
  return <LeafChip node={node} depth={depth} ctx={ctx} />;
}

function LeafChip({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  const { root, mode } = ctx;
  const locked = isLocked(node, ctx.lockBefore);
  const changed = ctx.highlight.has(node.id);
  const done = node.status === "completed";
  const current = ctx.currentLeafId === node.id;
  const open = ctx.openChips.has(node.id);
  const kicker = labelOf(root, node);
  const showStatus = mode === "track";
  const sessions = node.sessions;
  const hasSessions = mode === "track" && !!sessions && sessions.count > 0;
  const canSplit = node.level === "week" && !locked && !done && !hasSessions && !ctx.busy;
  const rows = readRowsFor(node.materials, ctx.byId);
  const isWeek = node.level !== "day";
  const hasMeta = (node.budgetHours !== null && rows.length === 0) || showStatus || hasSessions || canSplit;
  const href = mode === "track" && ctx.leafHref ? ctx.leafHref(node) : undefined;

  const classes = cn(
    "flex min-w-0 flex-col gap-[5px] rounded-2xl border border-transparent px-3.5 py-3 text-left transition-[background-color,border-color,box-shadow] duration-300 animate-in fade-in slide-in-from-bottom-1",
    depth === 1 ? "bg-background" : "bg-secondary",
    !done && !current && "opacity-85",
    done && "bg-accent-2-100 opacity-100",
    current && "border-accent-300 bg-accent-100 opacity-100",
    changed && "border-accent-400 bg-accent-100 opacity-100",
    locked && "opacity-50",
    href && "relative cursor-pointer hover:shadow-sm",
  );

  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.onToggleChip(node.id);
  };

  const body = (
    <>
      <span className="flex items-center justify-between gap-1.5">
        <span className="font-heading text-[11px] text-accent-700">
          {kicker}
          {changed && <ChangedPill />}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {locked && <Lock className="size-3 opacity-55" strokeWidth={2.75} />}
          <span
            role="button"
            tabIndex={0}
            aria-label={open ? "Show less" : "Show full description"}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") toggle(e as unknown as MouseEvent);
            }}
            className="relative z-10 inline-flex size-5 items-center justify-center rounded-full text-accent-700 hover:bg-accent-100"
          >
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} strokeWidth={2.75} />
          </span>
        </span>
      </span>
      <span className="flex items-baseline gap-2">
        <span className={cn("leading-snug", isWeek && rows.length > 0 ? "text-sm font-semibold" : "text-[13px]")}>{node.title}</span>
        {isWeek && rows.length > 0 && node.budgetHours !== null && (
          <span className="ml-auto shrink-0 text-xs whitespace-nowrap text-muted-foreground">{node.budgetHours} h budget</span>
        )}
      </span>
      {/* A day's subtitle is what it reads, so the week's division shows at a glance; the summary opens on the chevron.
          A day with nothing to read shows its summary instead. */}
      {(open || (!isWeek && rows.length === 0)) && <span className="min-w-0 text-[12px] leading-snug opacity-80">{node.summary}</span>}
      {rows.length > 0 &&
        (isWeek ? (
          <span className="mt-1 flex flex-col gap-2">
            <ReadRows rows={rows} link={!href} />
            <BudgetBar rows={rows} budgetMinutes={budgetMinutes(node, ctx.hoursPerWeek)} practice={ctx.practice} />
          </span>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5 text-[11.5px] leading-snug text-muted-foreground">
            {rows.map((r) => {
              const brief = rowBrief(r);
              const title = r.chapter ? `${r.material.title} · ${partLabel(r)}` : r.material.title;
              return (
                <span key={r.key} className="line-clamp-2" title={brief.detail ? `${title} · ${brief.detail}` : title}>
                  <span className="text-neutral-800">{brief.head}</span>
                  {brief.detail && <> · {brief.detail}</>}
                </span>
              );
            })}
            <span>{formatDuration(sumMinutes(rows).must + sumMinutes(rows).should)}</span>
          </span>
        ))}
    </>
  );

  // The status row sits outside the card's link, so the split menu inside it is not a control within a link. The link
  // still covers the whole card (its ::after spans it); the row's buttons sit above it, and the rest lets clicks
  // through to the link.
  const meta = hasMeta && (
    <span className="pointer-events-none relative z-10 mt-[3px] flex flex-wrap items-center gap-1.5 [&_button]:pointer-events-auto">
      {node.budgetHours !== null && rows.length === 0 && (
        <Badge variant="neutral" className="text-[11px]">
          about {node.budgetHours} hours
        </Badge>
      )}
      {showStatus && (
        <Badge variant={done ? "accent2" : node.status === "generated" ? "accent" : "neutral"} className="text-[11px]">
          {done ? "Done" : node.status === "generated" ? "Ready" : "Not started"}
        </Badge>
      )}
      {hasSessions && sessions && (
        <span className="text-[11.5px] opacity-60">
          {sessions.count} session{sessions.count > 1 ? "s" : ""} · {formatHours(sessions.hours)} h logged
        </span>
      )}
      {canSplit && <SplitControl usual={ctx.daysPerWeek} hoursPerWeek={ctx.hoursPerWeek} onSplit={(days) => ctx.onSplit(node.id, days)} />}
    </span>
  );

  return (
    <div className={classes}>
      {href ? (
        <Link href={href} className="flex min-w-0 flex-col gap-[5px] after:absolute after:inset-0 after:rounded-2xl after:content-['']">
          {body}
        </Link>
      ) : (
        body
      )}
      {meta}
    </div>
  );
}

function GroupCard({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  const { root, mode } = ctx;
  const locked = isLocked(node, ctx.lockBefore);
  const changed = ctx.highlight.has(node.id);
  const kids = node.children ?? [];
  const slots = ctx.pending[node.id];
  const expanded = node.children !== null || !!slots;
  const open = expanded && !ctx.collapsed.has(node.id);
  const done = doneDays(node);
  const allDone = node.len > 0 && done >= node.len;
  const current =
    mode !== "create" && !!ctx.currentLeafId && kids.length > 0 && containsLeaf(node, ctx.currentLeafId);
  const label = labelOf(root, node);
  const unit = childLevel(node.level) ?? "day";
  const canExpand = !locked && !ctx.busy && !slots;
  const pct = node.len > 0 ? Math.round((done / node.len) * 100) : 0;

  const headClick = () => {
    if (expanded) ctx.onToggle(node.id);
    else if (canExpand) ctx.onExpand(node.id);
  };

  return (
    <div
      className={cn(
        "col-span-full flex min-w-0 flex-col gap-2.5 rounded-[28px] border border-transparent transition-[background-color,border-color,box-shadow] duration-300 animate-in fade-in slide-in-from-bottom-1",
        depth === 0 ? "bg-secondary px-[18px] pt-4 pb-[18px]" : "bg-background px-4 pt-3.5 pb-4 max-[900px]:p-3",
        current && "border-accent-300 shadow-sm",
        changed && "border-accent-400 bg-accent-100",
        locked && "opacity-55",
      )}
    >
      <div className="flex min-w-0 cursor-pointer flex-wrap items-center gap-2.5" onClick={headClick}>
        <span className="shrink-0 font-heading text-[11px] text-accent-700">{label}</span>
        <h3 className={cn("m-0 min-w-0 font-heading font-normal", depth === 0 ? "text-[17px]" : "text-[15px]", allDone && "opacity-75")}>{node.title}</h3>
        <Badge variant="tagOutline" className="text-[11px]">
          {spanOf(root, node, ctx.daysPerWeek)}
        </Badge>
        {changed && <Badge variant="accent" className="text-[11px]">Changed</Badge>}
        {allDone && <Badge variant="accent2" className="text-[11px]">Done</Badge>}
        {node.manualSplit && <Badge variant="neutral" className="text-[11px]">Split by hand</Badge>}
        {locked && <Lock className="size-3 opacity-55" strokeWidth={2.75} />}
        <span className="inline-flex items-center gap-2 text-[12px] whitespace-nowrap opacity-70 min-[901px]:ml-auto max-[900px]:basis-full">
          <span className="block h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200">
            <span className="block h-full rounded-full bg-accent-2-500" style={{ width: `${pct}%` }} />
          </span>
          <span>
            {done} of {node.len} days
          </span>
        </span>
        {expanded && (
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-foreground/7">
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} strokeWidth={2.75} />
          </span>
        )}
      </div>
      <p className="m-0 text-[13px] leading-normal opacity-65">{node.summary}</p>
      <CoversRow node={node} byId={ctx.byId} />
      {open && (
        <div className={cn("grid", gridClass(kids, slots))}>
          {kids.map((child) => (
            <NodeView key={child.id} node={child} depth={depth + 1} ctx={ctx} />
          ))}
          {slots && <Skeletons count={slots.count} groups={slots.groups} />}
        </div>
      )}
      {!expanded && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-foreground/4 px-3.5 py-2.5 text-[12.5px] leading-snug">
          <span className="flex-[1_1_220px] opacity-70">
            {locked
              ? `This ${node.level} is behind you.`
              : node.covers?.some((r) => ctx.byId.get(r.id)?.backbone)
                ? `${capitalize(unit)}s here are planned when you reach ${label.toLowerCase()}. Their chapters are already reserved.`
                : `${capitalize(unit)}s here will be planned when you reach ${label.toLowerCase()}, using how the earlier ${node.level}s actually went.`}
          </span>
          {canExpand && (
            <Button
              variant="secondary"
              size="sm"
              className="min-h-10 border border-border px-4 text-[12.5px]"
              onClick={(e) => {
                e.stopPropagation();
                ctx.onExpand(node.id);
              }}
            >
              {mode === "track" ? `Plan ${label.toLowerCase()}` : "Expand"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const SHOWN_COVERS = 3;

/** "1–4", "5–6, 10": chapter numbers collapsed into runs. */
function chapterRuns(numbers: number[]): string {
  const runs: [number, number][] = [];
  for (const n of numbers) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}

/** A heading's reservation as chips: one per material and activity, the backbone first, "+ N more" past three. */
function CoversRow({ node, byId }: { node: PlanNode; byId: ReadonlyMap<string, Material> }) {
  const groups = new Map<string, { m: Material; review: boolean; chapters: number[]; note: string | null }>();
  for (const r of node.covers ?? []) {
    const m = byId.get(r.id);
    if (!m) continue;
    const review = (r.activity ?? "read") === "review";
    const key = `${m.id}#${review ? "review" : "read"}`;
    const group = groups.get(key) ?? { m, review, chapters: [], note: null };
    const chapter = chapterAt(m.toc, r.chapter);
    if (chapter) group.chapters.push(chapter.n ?? r.chapter!);
    else if (r.note) group.note = r.note;
    groups.set(key, group);
  }
  const refs = [...groups.values()];
  if (refs.length === 0) return null;
  const sorted = [...refs].sort((a, b) => Number(b.m.backbone) - Number(a.m.backbone));
  const shown = sorted.slice(0, SHOWN_COVERS);
  const text = (g: (typeof refs)[number]) => {
    const part = g.chapters.length > 0 ? `ch. ${chapterRuns(g.chapters)}` : g.note;
    return `${g.review ? "Review of " : ""}${g.m.title}${part ? ` · ${part}` : ""}`;
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="mr-0.5 text-muted-foreground">Covers</span>
      {shown.map((g) => (
        <span
          key={`${g.m.id}#${g.review ? "review" : "read"}`}
          title={text(g)}
          className={cn("max-w-[260px] truncate rounded-full px-[9px] py-[3px]", g.m.backbone ? "bg-accent-2-200 font-semibold text-accent-2-800" : "bg-background")}
        >
          {text(g)}
        </span>
      ))}
      {sorted.length > SHOWN_COVERS && <span className="rounded-full bg-background px-[9px] py-[3px]">+ {sorted.length - SHOWN_COVERS} more</span>}
    </div>
  );
}

function containsLeaf(node: PlanNode, leafId: string): boolean {
  if (node.id === leafId) return true;
  return (node.children ?? []).some((c) => containsLeaf(c, leafId));
}

const SPLIT_CHOICES = Array.from({ length: MAX_DAYS_PER_WEEK }, (_, i) => i + 1);

/**
 * "Split into [5 ▾] days". The words split the week into the learner's usual number of days; the number is a chip
 * that opens 1–7 days with the time each comes to, for a week that should have a different number.
 */
function SplitControl({ usual, hoursPerWeek, onSplit }: { usual: number; hoursPerWeek?: number; onSplit: (days: number) => void }) {
  const words = "text-[11.5px] text-accent-700 underline underline-offset-2 hover:text-accent-800";
  const perDay = (n: number) => (n === usual ? "usual" : hoursPerWeek === undefined ? null : `${formatDayTime(dayMinutes(hoursPerWeek, n))} a day`);
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className={words} onClick={() => onSplit(usual)}>
        Split into
      </button>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Split into ${usual} days, or choose another number`}
          className="inline-flex h-[18px] items-center gap-0.5 rounded-full bg-accent-100 px-1.5 text-[11.5px] font-semibold text-accent-800 transition-colors hover:bg-accent-200 data-popup-open:bg-accent-200"
        >
          {usual}
          <ChevronDown className="size-2.5 opacity-70" strokeWidth={3} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
            <Menu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
              {SPLIT_CHOICES.map((n) => (
                <Menu.Item
                  key={n}
                  label={`${n}`}
                  onClick={() => onSplit(n)}
                  className={cn(
                    "flex cursor-default items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none select-none data-highlighted:bg-accent-100",
                    n === usual && "font-semibold",
                  )}
                >
                  <span>
                    {n} day{n === 1 ? "" : "s"}
                  </span>
                  {perDay(n) && <span className="text-[11.5px] font-normal text-muted-foreground">{perDay(n)}</span>}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <button type="button" className={words} onClick={() => onSplit(usual)}>
        days
      </button>
    </span>
  );
}

function ChangedPill() {
  return (
    <span className="ml-2 rounded-full bg-accent-200 px-[7px] py-[2px] font-sans text-[10px] font-semibold tracking-wide text-accent-800 uppercase">
      Changed
    </span>
  );
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function TreeLabel({ children }: { children: ReactNode }) {
  return <label className="text-[11px] tracking-wide text-muted-foreground uppercase">{children}</label>;
}
