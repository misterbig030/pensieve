"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { OutlinePlanEditor } from "@/components/pensieve/OutlinePlanEditor";
import { TrackFormFields, type TrackFormValue } from "@/components/pensieve/TrackFormFields";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { generateOutlineDraftAction, confirmTrackAction } from "./actions";

const EMPTY_FORM: TrackFormValue = { topic: "", days: 14, instructions: "", sources: [] };

export function NewTrackForm() {
  const [form, setForm] = useState<TrackFormValue>(EMPTY_FORM);
  const [draft, setDraft] = useState<OutlineDraft | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setIsPending(true);
    setError(null);
    try {
      const result = await generateOutlineDraftAction({
        topic: form.topic,
        periodDays: form.days || undefined,
        sources: form.sources,
        instructions: form.instructions || undefined,
      });
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
        mode="create"
        backHref="/dashboard"
        backLabel="Dashboard"
        heading={`Here's the plan for "${form.topic}"`}
        subtext="Skim the days below, then confirm or ask for changes."
        initialDraft={draft}
        initialCostUsd={costUsd}
        formValue={form}
        onFormChange={setForm}
        onRegenerate={(feedback) =>
          generateOutlineDraftAction({
            topic: form.topic,
            periodDays: form.days || undefined,
            sources: form.sources,
            instructions: form.instructions || undefined,
            existingDraft: draft,
            feedback,
          })
        }
        onConfirm={(confirmedDraft) =>
          confirmTrackAction({
            topic: form.topic,
            instructions: form.instructions || undefined,
            sources: form.sources,
            draft: confirmedDraft,
          })
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-[640px] space-y-4">
      <div className="space-y-3 pb-2">
        <h1>What do you want to learn?</h1>
        <p className="text-muted-foreground">
          Give it a topic and any reference material — it drafts a plan you can shape before committing.
        </p>
      </div>
      <TrackFormFields value={form} onChange={setForm} />
      <Button
        className="mt-2 w-full"
        onClick={handleGenerate}
        disabled={isPending || !form.topic.trim() || !form.days}
      >
        Generate outline
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
