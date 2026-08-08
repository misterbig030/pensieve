"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AVAILABLE_MODELS, DEFAULT_CONTENT_MODEL, type AiModelId } from "@/lib/ai/models";
import { generateDailyContentAction } from "./actions";
import { markCompleteAction } from "../../actions";

interface Source {
  url: string;
  title: string | null;
  type: "link" | "youtube";
}

interface Props {
  trackId: string;
  dayIndex: number;
  outlineItemId: string;
  initialContent: { contentMarkdown: string; citations: { title: string; url: string }[]; model: string } | null;
  youtubeSources: Source[];
  isCompleted: boolean;
}

export function DailyContentView({
  trackId,
  dayIndex,
  outlineItemId,
  initialContent,
  youtubeSources,
  isCompleted,
}: Props) {
  const [content, setContent] = useState(initialContent);
  const [model, setModel] = useState<AiModelId>(
    (initialContent?.model as AiModelId) ?? DEFAULT_CONTENT_MODEL,
  );
  const [isPending, setIsPending] = useState(false);
  const [completed, setCompleted] = useState(isCompleted);

  async function handleGenerate() {
    setIsPending(true);
    try {
      const result = await generateDailyContentAction({ trackId, dayIndex, model });
      setContent({ ...result, model });
    } finally {
      setIsPending(false);
    }
  }

  async function handleMarkComplete() {
    setIsPending(true);
    try {
      await markCompleteAction(outlineItemId);
      setCompleted(true);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-4">
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
        <Button variant="secondary" onClick={handleGenerate} disabled={isPending}>
          {content ? "换个模型重新生成" : "生成教材"}
        </Button>
      </div>

      {content && (
        <>
          <article className="prose max-w-none">
            <ReactMarkdown>{content.contentMarkdown}</ReactMarkdown>
          </article>

          {content.citations.length > 0 && (
            <div className="text-sm text-muted-foreground">
              <div className="font-medium">引用来源：</div>
              <ul className="list-disc pl-5">
                {content.citations.map((c) => (
                  <li key={c.url}>
                    <a href={c.url} target="_blank" rel="noreferrer" className="underline">
                      {c.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {youtubeSources.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">相关视频：</div>
              {youtubeSources.map((s) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded border p-3 hover:bg-muted"
                >
                  {s.title ?? s.url}
                </a>
              ))}
            </div>
          )}

          <Button onClick={handleMarkComplete} disabled={isPending || completed}>
            {completed ? "已完成" : "标记完成"}
          </Button>
        </>
      )}
    </div>
  );
}
