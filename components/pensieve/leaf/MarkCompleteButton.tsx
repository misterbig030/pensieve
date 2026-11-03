"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { markCompleteAction } from "@/app/tracks/[id]/actions";
import { Button } from "@/components/ui/button";
import { ActionError } from "./ActionError";

/** Finishes a day or week. Without `onDone` the page refreshes to show the new state. */
export function MarkCompleteButton({
  nodeId,
  completed,
  onDone,
  label = "Mark complete",
  variant = "default",
  className,
}: {
  nodeId: string;
  completed: boolean;
  onDone?: () => void;
  label?: string;
  variant?: "default" | "outline";
  className?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markComplete() {
    setPending(true);
    setError(null);
    try {
      await markCompleteAction(nodeId);
      if (onDone) onDone();
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark this complete. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button onClick={markComplete} disabled={pending || completed} variant={variant} className={className}>
        {completed ? "Completed" : label}
      </Button>
      {error && <ActionError message={error} />}
    </>
  );
}
