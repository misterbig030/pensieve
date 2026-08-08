"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AVAILABLE_MODELS, DEFAULT_OUTLINE_MODEL, type AiModelId } from "@/lib/ai/models";
import type { OutlineDraft } from "@/lib/schemas/outline";
import { generateOutlineDraftAction } from "./actions";
import { OutlineDraftEditor } from "./OutlineDraftEditor";

export default function NewTrackPage() {
  const [topic, setTopic] = useState("");
  const [periodDays, setPeriodDays] = useState<number | undefined>(undefined);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sources, setSources] = useState<{ url: string; title?: string; type: "link" | "youtube" }[]>([]);
  const [model, setModel] = useState<AiModelId>(DEFAULT_OUTLINE_MODEL);
  const [draft, setDraft] = useState<OutlineDraft | null>(null);
  const [isPending, setIsPending] = useState(false);

  function addSource() {
    if (!sourceUrl.trim()) return;
    const type = sourceUrl.includes("youtube.com") || sourceUrl.includes("youtu.be") ? "youtube" : "link";
    setSources((prev) => [...prev, { url: sourceUrl.trim(), type }]);
    setSourceUrl("");
  }

  async function handleGenerate() {
    setIsPending(true);
    try {
      const result = await generateOutlineDraftAction({ topic, periodDays, sources, model });
      setDraft(result);
    } finally {
      setIsPending(false);
    }
  }

  if (draft) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <h1 className="text-xl font-semibold">确认大纲：{topic}</h1>
        <OutlineDraftEditor topic={topic} periodDays={periodDays} sources={sources} initialDraft={draft} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">新建学习方向</h1>
      <Input placeholder="想学什么？比如 System Design 面试准备" value={topic} onChange={(e) => setTopic(e.target.value)} />
      <Input
        type="number"
        placeholder="计划学习天数（可选）"
        value={periodDays ?? ""}
        onChange={(e) => setPeriodDays(e.target.value ? Number(e.target.value) : undefined)}
      />
      <div className="flex gap-2">
        <Input placeholder="参考链接（可选，含 YouTube）" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        <Button variant="secondary" onClick={addSource}>添加</Button>
      </div>
      <ul className="text-sm text-muted-foreground">
        {sources.map((s) => (
          <li key={s.url}>{s.url}</li>
        ))}
      </ul>
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
      <Button onClick={handleGenerate} disabled={isPending || !topic.trim()}>
        生成大纲
      </Button>
    </div>
  );
}
