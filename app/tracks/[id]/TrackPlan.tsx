"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { PlanTree, TreeLabel, type PendingSlots } from "@/components/pensieve/PlanTree";
import { Button } from "@/components/ui/button";
import { formatCostUsd } from "@/lib/formatCost";
import { pushModelCalls } from "@/lib/modelCalls";
import { childLevel, childSpans, currentLeaf, doneDays, findNode, nextPlanningStep, planningStepsLeft, type Granularity, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { expandNodeAction } from "./actions";

interface TrackPlanProps {
  trackId: string;
  root: PlanNode;
  granularity: Granularity;
  materials: Material[];
  hoursPerWeek: number;
  daysPerWeek: number;
}

/** What one planning step is likely to cost, for the estimate shown before planning everything. */
const STEP_COST_USD = 0.01;

interface PlanAll {
  total: number;
  done: number;
  costUsd: number;
}

/** The saved plan as a tree. Expanding or splitting runs on the server and the page refreshes with the new rows. */
export function TrackPlan({ trackId, root, granularity, materials, hoursPerWeek, daysPerWeek }: TrackPlanProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    // Finished groups start folded so the current work is what you see first.
    const done = new Set<string>();
    for (const top of root.children ?? []) {
      if (top.children && doneDays(top) >= top.len) done.add(top.id);
    }
    return done;
  });
  const [openChips, setOpenChips] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Record<string, PendingSlots>>({});
  const [error, setError] = useState<string | null>(null);
  /** True when the error is a refused user key, so the message links to Settings. */
  const [errorLink, setErrorLink] = useState(false);
  const [lastCost, setLastCost] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  /** Planning everything: one step at a time, the next taken from the refreshed tree once the last has landed. */
  const [planAll, setPlanAll] = useState<PlanAll | null>(null);
  const [confirming, setConfirming] = useState(false);
  const lastStep = useRef<string | null>(null);

  const current = currentLeaf(root);
  const tops = root.children ?? [];
  const label = tops[0] && tops[0].level !== "day" ? "Plan" : "Plan at a glance";
  const stepsLeft = planningStepsLeft(root, daysPerWeek);

  const run = useCallback(
    (nodeId: string, reason: "expand" | "split", splitDays?: number) => {
      const node = findNode(root, nodeId);
      if (!node || isPending) return;
      const below = childLevel(node.level);
      if (!below) return;
      const groups = reason === "expand" && below !== "day" && !(below === "week" && granularity === "week");
      const slots: PendingSlots = { count: splitDays ?? childSpans(node, daysPerWeek).length, groups };
      setPending({ [nodeId]: slots });
      setError(null);
      setErrorLink(false);
      startTransition(async () => {
        try {
          const result = await expandNodeAction({ trackId, nodeId, reason, splitDays });
          if (result.calls) pushModelCalls(result.calls);
          if (!result.ok) {
            setError(result.message);
            setErrorLink(true);
            setPlanAll(null);
          } else {
            setLastCost(result.costUsd);
            setPlanAll((p) => (p ? { ...p, done: p.done + 1, costUsd: p.costUsd + result.costUsd } : p));
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Planning failed. Try again.");
          setPlanAll(null);
        } finally {
          setPending({});
        }
      });
    },
    [root, isPending, granularity, daysPerWeek, trackId],
  );

  // Planning everything is a run of single steps. Each step saves itself and the page refreshes with the new rows, and
  // the next step is read off the refreshed tree; while a step is under way it is still the tree's next step, so that
  // is also the label shown. A step is not repeated in the moment between the action's return and the refresh.
  const planning = planAll !== null && (stepsLeft > 0 || isPending);
  const nextStep = planning ? nextPlanningStep(root, granularity) : null;
  useEffect(() => {
    if (!planning || isPending || !nextStep || lastStep.current === nextStep.nodeId) return;
    lastStep.current = nextStep.nodeId;
    run(nextStep.nodeId, nextStep.reason);
  }, [planning, isPending, nextStep, run]);

  function startAll() {
    setConfirming(false);
    lastStep.current = null;
    setPlanAll({ total: stepsLeft, done: 0, costUsd: 0 });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TreeLabel>{label}</TreeLabel>
        {planAll && planning ? (
          <span className="flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
            <span aria-live="polite">
              {nextStep?.label ?? "Planning everything"}… · {planAll.done} of {planAll.total}
            </span>
            <Button variant="secondary" size="sm" className="border border-border" onClick={() => setPlanAll(null)}>
              Stop
            </Button>
          </span>
        ) : planAll ? (
          <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
            Planned {planAll.done} unit{planAll.done === 1 ? "" : "s"} · {formatCostUsd(planAll.costUsd)}
          </span>
        ) : confirming ? (
          <span className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
            <span>
              Plan {stepsLeft} unit{stepsLeft === 1 ? "" : "s"} in one go, about {formatCostUsd(stepsLeft * STEP_COST_USD)}?
            </span>
            <Button size="sm" onClick={startAll} disabled={isPending}>
              Start
            </Button>
            <Button variant="secondary" size="sm" className="border border-border" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          stepsLeft > 0 && (
            <Button variant="secondary" size="sm" className="border border-border" onClick={() => setConfirming(true)} disabled={isPending}>
              Plan everything
            </Button>
          )
        )}
      </div>
      <PlanTree
        root={root}
        materials={materials}
        hoursPerWeek={hoursPerWeek}
        daysPerWeek={daysPerWeek}
        mode="track"
        highlight={new Set()}
        lockBefore={0}
        currentLeafId={current?.id ?? null}
        pending={pending}
        collapsed={collapsed}
        openChips={openChips}
        busy={isPending}
        onToggle={(id) =>
          setCollapsed((c) => {
            const next = new Set(c);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onToggleChip={(id) =>
          setOpenChips((c) => {
            const next = new Set(c);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onExpand={(id) => run(id, "expand")}
        onSplit={(id, days) => run(id, "split", days)}
        leafHref={(node) => `/tracks/${trackId}/nodes/${node.id}`}
      />
      {lastCost !== null && <p className="text-xs text-muted-foreground">Estimated cost: {formatCostUsd(lastCost)}</p>}
      {error && (
        <p className="text-sm text-red-600">
          {error}
          {errorLink && (
            <>
              {" "}
              <Link href="/settings" className="underline">
                Open Settings
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
