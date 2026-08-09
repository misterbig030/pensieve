"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCostUsd } from "@/lib/formatCost";
import { generateDailyContentAction } from "./actions";
import { markCompleteAction } from "../../actions";

interface Source {
  url: string;
  title: string | null;
}

interface Props {
  trackId: string;
  dayIndex: number;
  outlineItemId: string;
  initialContent: { contentMarkdown: string; citations: { title: string; url: string }[] } | null;
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
  const [isPending, setIsPending] = useState(false);
  const [completed, setCompleted] = useState(isCompleted);
  const [error, setError] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState<number | null>(null);

  async function handleGenerate() {
    setIsPending(true);
    setError(null);
    try {
      const { costUsd: cost, ...result } = await generateDailyContentAction({ trackId, dayIndex });
      setContent(result);
      setCostUsd(cost);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败，请重试");
    } finally {
      setIsPending(false);
    }
  }

  async function handleMarkComplete() {
    setIsPending(true);
    setError(null);
    try {
      await markCompleteAction(outlineItemId);
      setCompleted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "标记完成失败，请重试");
    } finally {
      setIsPending(false);
    }
  }

  if (!content) {
    return (
      <div className="elev-sm flex flex-col items-center gap-3.5 rounded-[32px] bg-secondary px-6 py-12 text-center">
        <div className="size-11 rounded-full bg-accent-100" />
        <h3 className="m-0">Today&apos;s lesson isn&apos;t written yet</h3>
        <p className="m-0 max-w-[38ch] text-muted-foreground">
          Generate it now — Pensieve will pull in your sources and cite what it uses.
        </p>
        <Button onClick={handleGenerate} disabled={isPending}>
          Generate today&apos;s lesson
        </Button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="elev-sm space-y-4 rounded-[32px] bg-card p-8">
        <div className="space-y-4">
          <ReactMarkdown
            components={{
              p: ({ children }) => <p className="text-[15px] leading-[1.7] last:mb-0">{children}</p>,
            }}
          >
            {content.contentMarkdown}
          </ReactMarkdown>
        </div>

        {content.citations.length > 0 && (
          <div>
            <p className="mb-2.5 text-[11px] tracking-wide text-muted-foreground uppercase">Sources</p>
            <div className="flex flex-wrap gap-2">
              {content.citations.map((c) => (
                <a key={c.url} href={c.url} target="_blank" rel="noreferrer">
                  <Badge variant="tagOutline">{c.title}</Badge>
                </a>
              ))}
            </div>
          </div>
        )}

        {youtubeSources.length > 0 && (
          <div>
            <p className="mb-2.5 text-[11px] tracking-wide text-muted-foreground uppercase">Related video</p>
            <div className="flex flex-col gap-2">
              {youtubeSources.map((s) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 rounded-2xl p-2 hover:bg-secondary"
                >
                  <span
                    className="h-10 w-16 shrink-0 rounded-[10px]"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(135deg, var(--neutral-300) 0 6px, var(--neutral-200) 6px 12px)",
                    }}
                  />
                  <span className="text-[13px]">{s.title ?? s.url}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={handleGenerate} disabled={isPending}>
          Try a different take
        </Button>
        <Button onClick={handleMarkComplete} disabled={isPending || completed}>
          {completed ? "Completed" : "Mark complete"}
        </Button>
      </div>
      {costUsd !== null && <p className="text-xs text-muted-foreground">Estimated cost: {formatCostUsd(costUsd)}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
