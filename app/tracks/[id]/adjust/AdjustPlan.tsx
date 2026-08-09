"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { OutlinePlanEditor } from "@/components/pensieve/OutlinePlanEditor";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { reviseOutlineDraftAction, confirmRevisionAction } from "../actions";

interface AdjustPlanProps {
  trackId: string;
  trackTitle: string;
  lastDone: number;
}

export function AdjustPlan({ trackId, trackTitle, lastDone }: AdjustPlanProps) {
  const [draft, setDraft] = useState<OutlineDraft | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setIsPending(true);
    setError(null);
    try {
      const result = await reviseOutlineDraftAction({ trackId, feedback });
      setDraft(result.draft);
      setCostUsd(result.costUsd);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败，请重试");
    } finally {
      setIsPending(false);
    }
  }

  if (draft) {
    return (
      <OutlinePlanEditor
        mode="adjust"
        backHref={`/tracks/${trackId}`}
        backLabel={trackTitle}
        heading="Adjust your plan"
        subtext="Only the days you haven't finished will change."
        lockedNote={`Days 1–${lastDone} are already checked off and won't be touched.`}
        initialDraft={draft}
        initialCostUsd={costUsd}
        onRegenerate={(fb) => reviseOutlineDraftAction({ trackId, feedback: fb, existingDraft: draft })}
        onConfirm={(confirmedDraft) => confirmRevisionAction({ trackId, draft: confirmedDraft })}
      />
    );
  }

  return (
    <div className="mx-auto max-w-[640px] space-y-4">
      <div className="text-[13px] text-foreground/60">
        <Link href={`/tracks/${trackId}`} className="hover:text-primary">
          ← {trackTitle}
        </Link>
      </div>
      <div className="space-y-3 pb-2">
        <h1>Adjust your plan</h1>
        <p className="text-muted-foreground">Only the days you haven&apos;t finished will change.</p>
      </div>
      <p className="rounded-2xl bg-secondary px-4 py-3 text-[13px] text-foreground/80">
        Days 1–{lastDone} are already checked off and won&apos;t be touched.
      </p>
      <Textarea
        placeholder="e.g. add two more days on caching"
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <Button onClick={handleGenerate} disabled={isPending || !feedback.trim()}>
        Generate draft
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
