"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { doneDays, findNode, initialOpen, isHeading, labelOf, type PlanNode } from "@/lib/planTree";
import { cn } from "@/lib/utils";
import type { usePlanning } from "./usePlanning";

export type Planning = ReturnType<typeof usePlanning>;

export interface Ctx {
  root: PlanNode;
  selectedId: string;
  currentLeafId: string | null;
  open: Set<string>;
  toggle(id: string): void;
  reveal(id: string): void;
  planning: Planning;
}

const rowClass = "relative flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-[13px]";
const selectedClass = "bg-neutral-100 shadow-sm before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary";

function isDone(node: PlanNode): boolean {
  return node.children ? node.children.length > 0 && doneDays(node) >= node.len : node.status === "completed";
}

/**
 * Units the outline opens at first: the way to the current leaf, less any finished unit, plus the way to the selected
 * row and the selected unit itself, so a `?day=` link always shows what it points at.
 */
export function startOpen(root: PlanNode, currentLeafId: string | null, selectedId: string): Set<string> {
  const open = new Set([...initialOpen(root, currentLeafId)].filter((id) => !isDone(findNode(root, id)!)));
  for (const id of initialOpen(root, selectedId)) open.add(id);
  if (findNode(root, selectedId)?.children?.length) open.add(selectedId);
  return open;
}

/**
 * The units open in the outline: the ones `startOpen` picks, worked out again on every render so a newly planned unit
 * or a new current leaf shows, with the learner's own opening and closing (`toggles`, id → open) on top.
 */
export function openUnits(root: PlanNode, currentLeafId: string | null, selectedId: string, toggles: ReadonlyMap<string, boolean>): Set<string> {
  const open = startOpen(root, currentLeafId, selectedId);
  for (const [id, isOpen] of toggles) {
    if (isOpen) open.add(id);
    else open.delete(id);
  }
  return open;
}

function StatusDot({ done, current }: { done: boolean; current: boolean }) {
  return (
    <span
      data-state={done ? "done" : current ? "current" : "open"}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full",
        done ? "bg-accent-2-500 text-background" : current ? "bg-primary" : "border-[1.5px] border-neutral-400",
      )}
    >
      {done && <Check className="size-2.5" strokeWidth={3} />}
    </span>
  );
}

export function Skeletons({ count, depth }: { count: number; depth: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden className={rowClass} style={{ paddingLeft: 12 + depth * 16 }}>
          <span className="skeleton-bar h-3 w-[38px]" />
          <span className="skeleton-bar h-3 w-[60%]" />
        </div>
      ))}
    </>
  );
}

function LeafRow({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  const current = node.id === ctx.currentLeafId;
  const done = node.status === "completed";
  return (
    <Link
      href={`?day=${node.id}`}
      scroll={false}
      aria-current={node.id === ctx.selectedId ? "true" : undefined}
      className={cn(rowClass, "hover:bg-neutral-100/70", node.id === ctx.selectedId && selectedClass)}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      <StatusDot done={done} current={current} />
      <span className={cn("w-12 shrink-0 text-[12px] text-muted-foreground", current && "font-semibold text-accent-800")}>{labelOf(ctx.root, node)}</span>
      <span className={cn("min-w-0 flex-1 truncate", done && "text-muted-foreground")}>{node.title}</span>
      {current ? (
        <small className="shrink-0 text-[11.5px] font-semibold text-accent-800">Today</small>
      ) : (
        !done && node.status === "generated" && <small className="shrink-0 text-[11.5px] text-accent-800">Ready</small>
      )}
    </Link>
  );
}

function UnitRow({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  const { planning } = ctx;
  const hasChildren = (node.children?.length ?? 0) > 0;
  const heading = isHeading(node);
  const done = isDone(node);
  const open = hasChildren && ctx.open.has(node.id);
  const busy = planning.isPending || planning.planning;
  const splittable = !hasChildren && !heading && node.level === "week" && !node.sessions && !done;
  // A week leaf on a week track is the work itself, so it reads like a day: a status dot, and "This week" when current.
  const leaf = !hasChildren && !heading;
  const current = leaf && node.id === ctx.currentLeafId;
  const label = labelOf(ctx.root, node);
  const selected = node.id === ctx.selectedId;
  // Inline actions show on hover or focus, so a column of them doesn't crowd the titles. They take no taps while hidden
  // (hover variants only apply where the device can hover), and the selected row leaves its action to the pane.
  const showActions = !selected && !busy;
  const actionClass = "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100";
  const plan = (reason: "expand" | "split") => {
    ctx.reveal(node.id);
    planning.run(node.id, reason);
  };

  let right: ReactNode = null;
  if (heading) right = "not planned";
  else if (done) right = <Check className="size-4 text-accent-2-600" />;
  else if (current) right = <small className="text-[11.5px] font-semibold text-accent-800">This week</small>;
  else if (leaf && node.status === "generated") right = <small className="text-[11.5px] text-accent-800">Ready</small>;
  else if (leaf && node.budgetHours !== null) right = `${node.budgetHours} h`;
  else if (hasChildren) right = `${doneDays(node)} of ${node.len}`;

  return (
    <>
      <div
        className={cn(rowClass, "group hover:bg-neutral-100/70", selected && selectedClass, heading && "text-muted-foreground")}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        {leaf && <StatusDot done={done} current={current} />}
        <span className={cn("w-[52px] shrink-0 font-heading text-[11px]", heading ? "text-muted-foreground" : "text-accent-700")}>{label}</span>
        <Link
          href={`?day=${node.id}`}
          scroll={false}
          onClick={() => ctx.reveal(node.id)}
          aria-current={selected ? "true" : undefined}
          className={cn("min-w-0 flex-1 truncate", heading ? "font-medium" : "font-semibold", leaf && done && "font-medium text-muted-foreground")}
        >
          {node.title}
        </Link>
        {heading && showActions && (
          <Button size="xs" variant="outline" className={actionClass} onClick={() => plan("expand")}>
            Plan {label}
          </Button>
        )}
        {splittable && showActions && (
          <Button size="xs" variant="outline" className={actionClass} onClick={() => plan("split")}>
            Split into days
          </Button>
        )}
        <span className="shrink-0 text-[12px] text-muted-foreground">{right}</span>
        {hasChildren && (
          <button
            type="button"
            onClick={() => ctx.toggle(node.id)}
            aria-expanded={open}
            aria-label={open ? `Close ${label}` : `Open ${label}`}
            className="-mr-1 shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        )}
      </div>
      {open && node.children!.map((child) => <Row key={child.id} node={child} depth={depth + 1} ctx={ctx} />)}
      {planning.pending[node.id] && <Skeletons count={planning.pending[node.id].count} depth={depth + 1} />}
    </>
  );
}

export function Row({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  return node.level === "day" ? <LeafRow node={node} depth={depth} ctx={ctx} /> : <UnitRow node={node} depth={depth} ctx={ctx} />;
}
