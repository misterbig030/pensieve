"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { generateLeafContentAction } from "@/app/tracks/[id]/nodes/[nodeId]/actions";
import { pushModelCalls } from "@/lib/modelCalls";
import { Button } from "@/components/ui/button";
import { ActionError } from "./ActionError";

/** Writes the day's lesson (or the week's material), then refreshes the page to show it. */
export function GenerateLessonButton({ trackId, nodeId, unit }: { trackId: string; nodeId: string; unit: "day" | "week" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; settingsLink: boolean } | null>(null);

  async function generate() {
    setPending(true);
    setError(null);
    try {
      const result = await generateLeafContentAction({ trackId, nodeId });
      if (result.calls) pushModelCalls(result.calls);
      if (!result.ok) setError({ message: result.message, settingsLink: true });
      else router.refresh();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Generation failed. Try again.", settingsLink: false });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button onClick={generate} disabled={pending}>
        {pending ? "Writing…" : unit === "week" ? "Generate this week's material" : "Generate today's lesson"}
      </Button>
      {error && <ActionError message={error.message} settingsLink={error.settingsLink} />}
    </>
  );
}
