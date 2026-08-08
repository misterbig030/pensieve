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
import type { OutlineDraft } from "@/lib/schemas/outline";
import { reviseOutlineDraftAction, confirmRevisionAction } from "../actions";

export function AdjustDraftEditor({ trackId }: { trackId: string }) {
  const [draft, setDraft] = useState<OutlineDraft | null>(null);
  const [feedback, setFeedback] = useState("");
  const [model, setModel] = useState<AiModelId>(DEFAULT_OUTLINE_MODEL);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setIsPending(true);
    setError(null);
    try {
      const result = await reviseOutlineDraftAction({ trackId, feedback, existingDraft: draft ?? undefined, model });
      setDraft(result);
      setFeedback("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败，请重试");
    } finally {
      setIsPending(false);
    }
  }

  async function handleConfirm() {
    if (!draft) return;
    setIsPending(true);
    setError(null);
    try {
      await confirmRevisionAction({ trackId, draft });
    } catch (err) {
      unstable_rethrow(err);
      setError(err instanceof Error ? err.message : "确认失败，请重试");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {draft && (
        <ul className="space-y-2">
          {draft.items.map((item) => (
            <li key={item.dayIndex} className="rounded border p-3">
              <div className="font-medium">Day {item.dayIndex}: {item.title}</div>
              <div className="text-sm text-muted-foreground">{item.summary}</div>
            </li>
          ))}
        </ul>
      )}

      <Textarea
        placeholder="想怎么调整？比如'加两天专门讲缓存'"
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
              <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="secondary" onClick={handleGenerate} disabled={isPending || !feedback.trim()}>
          {draft ? "重新生成" : "生成草稿"}
        </Button>
        {draft && (
          <Button onClick={handleConfirm} disabled={isPending}>确认</Button>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
