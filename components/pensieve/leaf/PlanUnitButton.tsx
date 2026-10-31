"use client";

import { useState, useTransition } from "react";
import { expandNodeAction } from "@/app/tracks/[id]/actions";
import { pushModelCalls } from "@/lib/modelCalls";
import { Button } from "@/components/ui/button";
import { ActionError } from "./ActionError";

/** Plans one unit from the day pane: splits a week into days or plans a heading. The page refreshes with the result. */
export function PlanUnitButton({ trackId, nodeId, reason, label }: { trackId: string; nodeId: string; reason: "expand" | "split"; label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ message: string; settingsLink: boolean } | null>(null);

  function plan() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await expandNodeAction({ trackId, nodeId, reason });
        if (result.calls) pushModelCalls(result.calls);
        if (!result.ok) setError({ message: result.message, settingsLink: true });
      } catch (err) {
        setError({ message: err instanceof Error ? err.message : "Planning failed. Try again.", settingsLink: false });
      }
    });
  }

  return (
    <>
      <Button onClick={plan} disabled={pending}>
        {pending ? "Planning…" : label}
      </Button>
      {error && <ActionError message={error.message} settingsLink={error.settingsLink} />}
    </>
  );
}
