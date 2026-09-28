"use client";

import { PlanWorkspace } from "@/components/pensieve/PlanWorkspace";
import { toTreeInput } from "@/lib/planInput";
import type { Granularity, PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { confirmRevisionAction } from "../actions";

interface AdjustPlanProps {
  trackId: string;
  trackTitle: string;
  granularity: Granularity;
  instructions?: string;
  materials: Material[];
  root: PlanNode;
  lockBefore: number;
}

export function AdjustPlan({ trackId, trackTitle, granularity, instructions, materials, root, lockBefore }: AdjustPlanProps) {
  return (
    <PlanWorkspace
      mode="adjust"
      topic={trackTitle}
      days={root.len}
      granularity={granularity}
      instructions={instructions}
      sources={[]}
      initialMaterials={materials}
      initialTree={root}
      lockBefore={lockBefore}
      trackId={trackId}
      backHref={`/tracks/${trackId}`}
      backLabel={trackTitle}
      heading="Adjust your plan"
      subtext="Only the days you haven't finished will change."
      onConfirm={(tree, _summary, kept) => confirmRevisionAction({ trackId, tree: toTreeInput(tree), materialIds: kept.map((m) => m.id) })}
    />
  );
}
