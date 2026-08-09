"use client";

import { useState } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PhaseBlock } from "@/components/pensieve/PhaseBlock";
import { DayChip } from "@/components/pensieve/DayChip";
import { TrackFormFields, type TrackFormValue } from "@/components/pensieve/TrackFormFields";
import { formatCostUsd } from "@/lib/formatCost";
import { buildPhases } from "@/lib/outlinePhases";
import type { OutlineDraft } from "@/lib/schemas/outline";
import type { GenerateOutlineDraftResult } from "@/lib/ai/outline";

interface OutlinePlanEditorProps {
  mode: "create" | "adjust";
  backHref: string;
  backLabel: string;
  heading: string;
  subtext: string;
  lockedNote?: string;
  initialDraft: OutlineDraft;
  initialCostUsd: number;
  formValue?: TrackFormValue;
  onFormChange?: (value: TrackFormValue) => void;
  onRegenerate: (feedback: string) => Promise<GenerateOutlineDraftResult>;
  onConfirm: (draft: OutlineDraft) => Promise<void>;
}

export function OutlinePlanEditor({
  mode,
  backHref,
  backLabel,
  heading,
  subtext,
  lockedNote,
  initialDraft,
  initialCostUsd,
  formValue,
  onFormChange,
  onRegenerate,
  onConfirm,
}: OutlinePlanEditorProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [costUsd, setCostUsd] = useState(initialCostUsd);
  const [feedback, setFeedback] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phases = buildPhases(draft.items);

  async function handleRegenerate() {
    setIsPending(true);
    setError(null);
    try {
      const result = await onRegenerate(feedback);
      setDraft(result.draft);
      setCostUsd(result.costUsd);
      setFeedback("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败，请重试");
    } finally {
      setIsPending(false);
    }
  }

  async function handleConfirm() {
    setIsPending(true);
    setError(null);
    try {
      await onConfirm(draft);
    } catch (err) {
      unstable_rethrow(err);
      setError(err instanceof Error ? err.message : "确认失败，请重试");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-[13px] text-foreground/60">
        <Link href={backHref} className="hover:text-primary">
          ← {backLabel}
        </Link>
      </div>
      <div className="mx-auto max-w-[640px] space-y-3 pb-2">
        <h1>{heading}</h1>
        <p className="text-muted-foreground">{subtext}</p>
      </div>

      <div className="space-y-5">
        <label className="text-[11px] tracking-wide text-muted-foreground uppercase">Plan at a glance</label>
        {lockedNote && (
          <p className="rounded-2xl bg-secondary px-4 py-3 text-[13px] text-foreground/80">{lockedNote}</p>
        )}
        {phases.map((phase) => (
          <PhaseBlock key={phase.label} label={phase.label} range={phase.range} focus={phase.focus}>
            {phase.days.map((day) => (
              <DayChip key={day.dayIndex} dayIndex={day.dayIndex} title={day.title} status="pending" />
            ))}
          </PhaseBlock>
        ))}

        <div className="mx-auto max-w-[640px] space-y-1.5">
          {mode === "create" && formValue && onFormChange && (
            <div className="mb-1 space-y-5">
              <TrackFormFields value={formValue} onChange={onFormChange} />
              <label className="text-[11px] tracking-wide text-muted-foreground uppercase">Anything else?</label>
            </div>
          )}
          <Textarea
            placeholder="e.g. days 5-10 are too advanced, spread them out"
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
        </div>

        <div className="mx-auto flex max-w-[640px] items-center gap-3">
          <Button variant="secondary" onClick={handleRegenerate} disabled={isPending}>
            {feedback.trim() ? "Regenerate with feedback" : "Regenerate"}
          </Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            Confirm plan
          </Button>
        </div>
        <p className="mx-auto max-w-[640px] text-xs text-muted-foreground">
          Estimated cost: {formatCostUsd(costUsd)}
        </p>
        {error && <p className="mx-auto max-w-[640px] text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
