"use client";

import { useState } from "react";
import { unstable_rethrow } from "next/navigation";
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
import { formatCostUsd } from "@/lib/formatCost";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { generateOutlineDraftAction, confirmTrackAction } from "./actions";

interface Props {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string; type: "link" | "youtube" }[];
  initialDraft: OutlineDraft;
  initialCostUsd: number;
}

export function OutlineDraftEditor({ topic, periodDays, sources, initialDraft, initialCostUsd }: Props) {
  const [draft, setDraft] = useState(initialDraft);
  const [feedback, setFeedback] = useState("");
  const [model, setModel] = useState<AiModelId>(DEFAULT_OUTLINE_MODEL);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(initialCostUsd);

  async function handleRegenerate() {
    setIsPending(true);
    setError(null);
    try {
      const result = await generateOutlineDraftAction({
        topic,
        periodDays,
        sources,
        existingDraft: draft,
        feedback,
        model,
      });
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
      await confirmTrackAction({ topic, sources, draft });
    } catch (err) {
      unstable_rethrow(err);
      setError(err instanceof Error ? err.message : "确认失败，请重试");
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
      <p className="text-sm text-muted-foreground">预估花费：{formatCostUsd(costUsd)}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
