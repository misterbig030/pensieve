"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AVAILABLE_MODELS, DEFAULT_OUTLINE_MODEL, type AiModelId } from "@/lib/ai/models";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { generateOutlineDraftAction, confirmTrackAction } from "./actions";

interface Props {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string; type: "link" | "youtube" }[];
  initialDraft: OutlineDraft;
}

export function OutlineDraftEditor({ topic, periodDays, sources, initialDraft }: Props) {
  const [draft, setDraft] = useState(initialDraft);
  const [feedback, setFeedback] = useState("");
  const [model, setModel] = useState<AiModelId>(DEFAULT_OUTLINE_MODEL);
  const [isPending, setIsPending] = useState(false);

  async function handleRegenerate() {
    setIsPending(true);
    try {
      const newDraft = await generateOutlineDraftAction({
        topic,
        periodDays,
        sources,
        existingDraft: draft,
        feedback,
        model,
      });
      setDraft(newDraft);
      setFeedback("");
    } finally {
      setIsPending(false);
    }
  }

  async function handleConfirm() {
    setIsPending(true);
    try {
      await confirmTrackAction({ topic, sources, draft });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {draft.items.map((item) => (
          <li key={item.dayIndex} className="rounded border p-3">
            <div className="font-medium">Day {item.dayIndex}: {item.title}</div>
            <div className="text-sm text-muted-foreground">{item.summary}</div>
          </li>
        ))}
      </ul>

      <Textarea
        placeholder="有什么想调整的？比如'第5-10天太难了，拆细一点'"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />

      <div className="flex items-center gap-2">
        <Select value={model} onValueChange={(v) => setModel(v as AiModelId)}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVAILABLE_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="secondary" onClick={handleRegenerate} disabled={isPending}>
          重新生成
        </Button>
        <Button onClick={handleConfirm} disabled={isPending}>
          确认
        </Button>
      </div>
    </div>
  );
}
