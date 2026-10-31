"use client";

import { useState, useTransition } from "react";
import { expandNodeAction } from "@/app/tracks/[id]/actions";
import { pushModelCalls } from "@/lib/modelCalls";
import { Button } from "@/components/ui/button";
import { SplitControl } from "@/components/pensieve/PlanTree";
import { ActionError } from "./ActionError";

/**
 * Plans one unit from the day pane: plans a heading, or splits a week into the learner's usual number of days or
 * another they pick. The page refreshes with the result.
 */
export function PlanUnitButton({
  trackId,
  nodeId,
  reason,
  label,
  daysPerWeek,
  hoursPerWeek,
}: {
  trackId: string;
  nodeId: string;
  reason: "expand" | "split";
  label: string;
  daysPerWeek: number;
  hoursPerWeek: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ message: string; settingsLink: boolean } | null>(null);

  function plan(splitDays?: number) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await expandNodeAction({ trackId, nodeId, reason, splitDays });
        if (result.calls) pushModelCalls(result.calls);
        if (!result.ok) setError({ message: result.message, settingsLink: true });
      } catch (err) {
        setError({ message: err instanceof Error ? err.message : "Planning failed. Try again.", settingsLink: false });
      }
    });
  }

  return (
    <>
      {reason === "split" ? (
        pending ? (
          <span className="text-[12.5px] text-muted-foreground">Splitting…</span>
        ) : (
          <SplitControl usual={daysPerWeek} hoursPerWeek={hoursPerWeek} onSplit={plan} />
        )
      ) : (
        <Button onClick={() => plan()} disabled={pending}>
          {pending ? "Planning…" : label}
        </Button>
      )}
      {error && <ActionError message={error.message} settingsLink={error.settingsLink} />}
    </>
  );
}
