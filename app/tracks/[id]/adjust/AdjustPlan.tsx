"use client";

import { PlanWorkspace } from "@/components/pensieve/PlanWorkspace";
import { toTreeInput } from "@/lib/planInput";
import { weeksOf, type Granularity, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
import { confirmRevisionAction } from "../actions";

interface AdjustPlanProps {
  trackId: string;
  trackTitle: string;
  granularity: Granularity;
  hoursPerWeek: number;
  daysPerWeek: number;
  split: PlanSplit | null;
  instructions?: string;
  materials: Material[];
  root: PlanNode;
  lockBefore: number;
  /** The plan file this track was imported from, when it was: chat, redraft and expand send it along. */
  importText?: string;
}

export function AdjustPlan({ trackId, trackTitle, granularity, hoursPerWeek, daysPerWeek, split, instructions, materials, root, lockBefore, importText }: AdjustPlanProps) {
  return (
    <PlanWorkspace
      mode="adjust"
      topic={trackTitle}
      weeks={weeksOf(root, root, daysPerWeek)}
      daysPerWeek={daysPerWeek}
      granularity={granularity}
      hoursPerWeek={hoursPerWeek}
      initialSplit={split}
      instructions={instructions}
      sources={[]}
      initialMaterials={materials}
      initialTree={root}
      lockBefore={lockBefore}
      trackId={trackId}
      imported={importText ? { fileName: "your plan file", text: importText, kept: [], skipped: [] } : undefined}
      backHref={`/tracks/${trackId}`}
      backLabel={trackTitle}
      heading="Adjust your plan"
      subtext="Only the days you haven't finished will change."
      onConfirm={(tree, _summary, kept, time) =>
        confirmRevisionAction({
          trackId,
          tree: toTreeInput(tree),
          materialIds: kept.map((m) => m.id),
          hoursPerWeek: time.hoursPerWeek,
          daysPerWeek: time.daysPerWeek,
          split: time.split,
          problems: time.problems,
        })
      }
    />
  );
}
