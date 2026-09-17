"use client";

import { PlanWorkspace } from "@/components/pensieve/PlanWorkspace";
import { toTreeInput } from "@/lib/planInput";
import type { Granularity, PlanNode } from "@/lib/planTree";
import type { SourceInput } from "@/lib/schemas/source";
import { confirmRevisionAction } from "../actions";

interface AdjustPlanProps {
  trackId: string;
  trackTitle: string;
  granularity: Granularity;
  instructions?: string;
  sources: SourceInput[];
  root: PlanNode;
  lockBefore: number;
}

export function AdjustPlan({ trackId, trackTitle, granularity, instructions, sources, root, lockBefore }: AdjustPlanProps) {
  return (
    <PlanWorkspace
      mode="adjust"
      topic={trackTitle}
      days={root.len}
      granularity={granularity}
      instructions={instructions}
      sources={sources}
      initialTree={root}
      lockBefore={lockBefore}
      trackId={trackId}
      backHref={`/tracks/${trackId}`}
      backLabel={trackTitle}
      heading="Adjust your plan"
      subtext="Only the days you haven't finished will change."
      onConfirm={(tree) => confirmRevisionAction({ trackId, tree: toTreeInput(tree) })}
    />
  );
}
