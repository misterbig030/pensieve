"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logSessionAction } from "@/app/tracks/[id]/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionError } from "./ActionError";

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

/** Logs hours against a week. Without `onLogged` the page refreshes to show the new total. */
export function LogSessionForm({
  nodeId,
  budgetHours,
  sessions,
  onLogged,
}: {
  nodeId: string;
  budgetHours: number | null;
  sessions: { hours: number }[];
  onLogged?: (hours: number) => void;
}) {
  const router = useRouter();
  const [hoursInput, setHoursInput] = useState("1");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loggedHours = sessions.reduce((a, s) => a + s.hours, 0);

  async function logSession() {
    const hours = Number(hoursInput);
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 24) {
      setError("Log between 0.25 and 24 hours.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await logSessionAction(nodeId, hours);
      if (onLogged) onLogged(hours);
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log the session. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3.5 rounded-[28px] bg-secondary px-5 py-3.5 text-[13.5px]">
        <span>
          Time budget about {budgetHours} hours ·{" "}
          {sessions.length > 0
            ? `${sessions.length} session${sessions.length > 1 ? "s" : ""}, ${formatHours(loggedHours)} h logged`
            : "no sessions logged yet"}
        </span>
        <span className="inline-flex items-center gap-2">
          <Input
            type="number"
            min={0.25}
            max={24}
            step={0.25}
            value={hoursInput}
            onChange={(e) => setHoursInput(e.target.value)}
            className="w-[76px]"
            aria-label="Hours studied"
          />
          <span className="text-[13px] text-muted-foreground">h</span>
          <Button variant="secondary" size="sm" className="border border-border" onClick={logSession} disabled={pending}>
            Log session
          </Button>
        </span>
      </div>
      {error && <ActionError message={error} />}
    </div>
  );
}
