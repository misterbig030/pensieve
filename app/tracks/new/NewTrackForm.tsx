"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PlanWorkspace } from "@/components/pensieve/PlanWorkspace";
import { TrackFormFields, type TrackFormValue } from "@/components/pensieve/TrackFormFields";
import { toTreeInput } from "@/lib/planInput";
import { resolveGranularity } from "@/lib/planTree";
import { confirmTrackAction } from "./actions";

const EMPTY_FORM: TrackFormValue = { topic: "", days: 30, granularity: "auto", instructions: "", sources: [] };

export function NewTrackForm() {
  const [form, setForm] = useState<TrackFormValue>(EMPTY_FORM);
  const [brief, setBrief] = useState<TrackFormValue | null>(null);

  if (brief && brief.days) {
    const topic = brief.topic.trim();
    const days = brief.days;
    const granularity = resolveGranularity(brief.granularity, days);
    const instructions = brief.instructions.trim() || undefined;
    return (
      <PlanWorkspace
        mode="create"
        topic={topic}
        days={days}
        granularity={granularity}
        instructions={instructions}
        sources={brief.sources}
        backHref="/dashboard"
        backLabel="Dashboard"
        heading={`Here's the plan for "${topic}"`}
        subtext="Skim the plan, expand what you want to see, then confirm — or talk it over on the right."
        onConfirm={(tree, summary) =>
          confirmTrackAction({
            topic,
            instructions,
            granularity,
            sources: brief.sources,
            tree: toTreeInput(tree),
            summary,
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
      <Button className="mt-2 w-full" onClick={() => setBrief(form)} disabled={!form.topic.trim() || !form.days}>
        Generate outline
      </Button>
    </div>
  );
}
