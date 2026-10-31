"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionError } from "@/components/pensieve/leaf/ActionError";
import { formatCostUsd } from "@/lib/formatCost";
import type { Granularity, PlanNode } from "@/lib/planTree";
import { STEP_COST_USD, usePlanning } from "./usePlanning";
import { Row, Skeletons, openUnits, type Ctx, type Planning } from "./OutlineRows";

interface Props {
  trackId: string;
  root: PlanNode;
  granularity: Granularity;
  daysPerWeek: number;
  selectedId: string;
  currentLeafId: string | null;
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
  // The learner's own opening and closing; the rest follows the plan as it refreshes after planning or finishing a day.
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const open = openUnits(root, currentLeafId, selectedId, toggles);
  const ctx: Ctx = {
    root,
    selectedId,
    currentLeafId,
    open,
    planning,
    toggle: (id) => setToggles((t) => new Map(t).set(id, !open.has(id))),
    reveal: (id) => setToggles((t) => new Map(t).set(id, true)),
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
