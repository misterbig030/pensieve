"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { PendingSlots } from "@/components/pensieve/PlanTree";
import { pushModelCalls } from "@/lib/modelCalls";
import { childLevel, childSpans, findNode, nextPlanningStep, planningStepsLeft, type Granularity, type PlanNode } from "@/lib/planTree";
import { expandNodeAction } from "./actions";

/** What one planning step is likely to cost, for the estimate shown before planning everything. */
export const STEP_COST_USD = 0.01;

export interface PlanAll {
  total: number;
  done: number;
  costUsd: number;
}

/** Planning a saved track: one unit at a time, or everything in a run. Each step saves and the page refreshes. */
export function usePlanning({ trackId, root, granularity, daysPerWeek }: { trackId: string; root: PlanNode; granularity: Granularity; daysPerWeek: number }) {
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

  return {
    run,
    pending,
    isPending,
    error,
    errorLink,
    lastCost,
    stepsLeft,
    planAll,
    planning,
    nextStepLabel: nextStep?.label ?? null,
    confirming,
    setConfirming,
    startAll,
    stopAll: () => setPlanAll(null),
  };
}
