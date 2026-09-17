"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  capitalize,
  childLevel,
  doneDays,
  isLocked,
  labelOf,
  spanOf,
  type PlanNode,
} from "@/lib/planTree";
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
  onSplit: (id: string) => void;
  leafHref?: (node: PlanNode) => string;
}

type Ctx = Omit<PlanTreeProps, "root"> & { root: PlanNode };

function gridClass(children: PlanNode[], pending?: PendingSlots): string {
  const groups = children.length > 0 ? children.every((c) => c.children !== null || childLevel(c.level) !== null && c.budgetHours === null) : !!pending?.groups;
  if (groups) return "grid-cols-[minmax(0,1fr)] gap-3.5";
  const weeks = children.some((c) => c.children === null && c.level !== "day");
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
  return (
    <div className={cn("grid", gridClass(children, slots))}>
      {children.map((child) => (
        <NodeView key={child.id} node={child} depth={0} ctx={props} />
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
  const label = labelOf(root, node);
  const kicker = node.level === "day" ? label : `${label} · ${spanOf(node)}`;
  const showStatus = mode === "track";
  const sessions = node.sessions;
  const hasSessions = mode === "track" && !!sessions && sessions.count > 0;
  const canSplit = node.len > 1 && !locked && !done && !hasSessions && !ctx.busy;
  const hasMeta = node.budgetHours !== null || showStatus || hasSessions || canSplit;
  const href = mode === "track" && ctx.leafHref ? ctx.leafHref(node) : undefined;

  const classes = cn(
    "flex min-w-0 flex-col gap-[5px] rounded-2xl border border-transparent px-3.5 py-3 text-left transition-[background-color,border-color,box-shadow] duration-300 animate-in fade-in slide-in-from-bottom-1",
    depth === 1 ? "bg-background" : "bg-secondary",
    !done && !current && "opacity-85",
    done && "bg-accent-2-100 opacity-100",
    current && "border-accent-300 bg-accent-100 opacity-100",
    changed && "border-accent-400 bg-accent-100 opacity-100",
    locked && "opacity-50",
    href && "cursor-pointer hover:shadow-sm",
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
            className="inline-flex size-5 items-center justify-center rounded-full text-accent-700 hover:bg-accent-100"
          >
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} strokeWidth={2.75} />
          </span>
        </span>
      </span>
      <span className="text-[13px] leading-snug">{node.title}</span>
      {open && <span className="min-w-0 text-[12px] leading-snug opacity-80">{node.summary}</span>}
      {hasMeta && (
        <span className="mt-[3px] flex flex-wrap items-center gap-1.5">
          {node.budgetHours !== null && (
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
          {canSplit && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ctx.onSplit(node.id);
              }}
              className="text-[11.5px] text-accent-700 underline underline-offset-2 hover:text-accent-800"
            >
              Split into days
            </button>
          )}
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    );
  }
  return <div className={classes}>{body}</div>;
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
          {spanOf(node)}
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

function containsLeaf(node: PlanNode, leafId: string): boolean {
  if (node.id === leafId) return true;
  return (node.children ?? []).some((c) => containsLeaf(c, leafId));
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
