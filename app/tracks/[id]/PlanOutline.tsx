"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionError } from "@/components/pensieve/leaf/ActionError";
import { formatCostUsd } from "@/lib/formatCost";
import { doneDays, findNode, initialOpen, isHeading, labelOf, type Granularity, type PlanNode } from "@/lib/planTree";
import { cn } from "@/lib/utils";
import { STEP_COST_USD, usePlanning } from "./usePlanning";

interface Props {
  trackId: string;
  root: PlanNode;
  granularity: Granularity;
  daysPerWeek: number;
  selectedId: string;
  currentLeafId: string | null;
}

type Planning = ReturnType<typeof usePlanning>;

interface Ctx {
  root: Props["root"];
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
function startOpen(root: PlanNode, currentLeafId: string | null, selectedId: string): Set<string> {
  const open = new Set([...initialOpen(root, currentLeafId)].filter((id) => !isDone(findNode(root, id)!)));
  for (const id of initialOpen(root, selectedId)) open.add(id);
  if (findNode(root, selectedId)?.children?.length) open.add(selectedId);
  return open;
}

function Skeletons({ count, depth }: { count: number; depth: number }) {
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
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full",
          done ? "bg-accent-2-500 text-background" : current ? "bg-primary" : "border-[1.5px] border-neutral-400",
        )}
      >
        {done && <Check className="size-2.5" strokeWidth={3} />}
      </span>
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
  const label = labelOf(ctx.root, node);

  let right: ReactNode = null;
  if (heading) right = "not planned";
  else if (!hasChildren && node.budgetHours !== null) right = `${node.budgetHours} h`;
  else if (done) right = <Check className="size-4 text-accent-2-600" />;
  else if (hasChildren) right = `${doneDays(node)} of ${node.len}`;

  return (
    <>
      <div
        className={cn(rowClass, "hover:bg-neutral-100/70", node.id === ctx.selectedId && selectedClass, heading && "text-muted-foreground")}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <span className={cn("w-[52px] shrink-0 font-heading text-[11px]", heading ? "text-muted-foreground" : "text-accent-700")}>{label}</span>
        <Link
          href={`?day=${node.id}`}
          scroll={false}
          onClick={() => ctx.reveal(node.id)}
          aria-current={node.id === ctx.selectedId ? "true" : undefined}
          className={cn("min-w-0 flex-1 truncate", heading ? "font-medium" : "font-semibold")}
        >
          {node.title}
        </Link>
        {heading && !busy && (
          <Button size="xs" variant="outline" onClick={() => planning.run(node.id, "expand")}>
            Plan {label}
          </Button>
        )}
        {splittable && !busy && (
          <Button size="xs" variant="outline" onClick={() => planning.run(node.id, "split")}>
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

function Row({ node, depth, ctx }: { node: PlanNode; depth: number; ctx: Ctx }) {
  return node.level === "day" ? <LeafRow node={node} depth={depth} ctx={ctx} /> : <UnitRow node={node} depth={depth} ctx={ctx} />;
}

function PlanEverything({ planning }: { planning: Planning }) {
  const { planAll, stepsLeft } = planning;
  if (!planAll && stepsLeft === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed border-neutral-400 px-3 py-2.5 text-[12.5px] text-muted-foreground">
      <Sparkles className="size-4 shrink-0 text-primary" />
      {planAll && planning.planning ? (
        <>
          <span aria-live="polite">
            {planning.nextStepLabel ?? "Planning everything"}… · {planAll.done} of {planAll.total}
          </span>
          <Button variant="secondary" size="sm" className="ml-auto border border-border" onClick={planning.stopAll}>
            Stop
          </Button>
        </>
      ) : planAll ? (
        <span aria-live="polite">
          Planned {planAll.done} unit{planAll.done === 1 ? "" : "s"} · {formatCostUsd(planAll.costUsd)}
        </span>
      ) : planning.confirming ? (
        <>
          <span className="text-foreground">
            Plan {stepsLeft} unit{stepsLeft === 1 ? "" : "s"} in one go, about {formatCostUsd(stepsLeft * STEP_COST_USD)}?
          </span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" onClick={planning.startAll} disabled={planning.isPending}>
              Start
            </Button>
            <Button variant="secondary" size="sm" className="border border-border" onClick={() => planning.setConfirming(false)}>
              Cancel
            </Button>
          </span>
        </>
      ) : (
        <>
          <span>
            {stepsLeft} {stepsLeft === 1 ? "unit" : "units"} left to plan
          </span>
          <Button variant="secondary" size="sm" className="ml-auto border border-border" onClick={() => planning.setConfirming(true)} disabled={planning.isPending}>
            Plan everything
          </Button>
        </>
      )}
    </div>
  );
}

/** The plan as a narrow outline: units fold open to their days, and the row you pick opens in the pane beside it. */
export function PlanOutline({ trackId, root, granularity, daysPerWeek, selectedId, currentLeafId }: Props) {
  const planning = usePlanning({ trackId, root, granularity, daysPerWeek });
  const [open, setOpen] = useState(() => startOpen(root, currentLeafId, selectedId));
  const ctx: Ctx = {
    root,
    selectedId,
    currentLeafId,
    open,
    planning,
    toggle: (id) =>
      setOpen((o) => {
        const next = new Set(o);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    reveal: (id) => setOpen((o) => (o.has(id) ? o : new Set([...o, id]))),
  };

  return (
    <nav aria-label="Plan outline" className="flex flex-col gap-0.5">
      {(root.children ?? []).map((node) => (
        <Row key={node.id} node={node} depth={0} ctx={ctx} />
      ))}
      {planning.pending[root.id] && <Skeletons count={planning.pending[root.id].count} depth={0} />}
      <PlanEverything planning={planning} />
      {planning.lastCost !== null && <p className="px-3 pt-1 text-xs text-muted-foreground">Estimated cost: {formatCostUsd(planning.lastCost)}</p>}
      {planning.error && (
        <div className="px-3 pt-1">
          <ActionError message={planning.error} settingsLink={planning.errorLink} />
        </div>
      )}
    </nav>
  );
}
