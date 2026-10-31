import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LessonMarkdown } from "@/components/pensieve/LessonMarkdown";
import type { DayTask } from "@/lib/dayTasks";
import { hasStaleSteps, splitLesson, stepKey } from "@/lib/lessonSteps";
import { StepCard } from "./StepCard";

/**
 * A written lesson: its markdown, with step cards where the writer sent the learner off to a task. A lesson written
 * before the day's tasks changed says so, and offers a rewrite.
 */
export function DayLesson({
  markdown,
  tasks,
  ticks,
  onToggleStep,
  onRewrite,
  rewriting,
}: {
  markdown: string;
  tasks: DayTask[];
  ticks: ReadonlySet<string>;
  onToggleStep(key: string): void;
  onRewrite(): void;
  rewriting: boolean;
}) {
  const parts = splitLesson(markdown);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stale = hasStaleSteps(parts, new Set(byId.keys()));
  return (
    <>
      {stale && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-secondary px-4 py-3 text-[13px]">
          <span className="flex-1">This day&apos;s tasks changed after the lesson was written.</span>
          <Button variant="outline" size="sm" onClick={onRewrite} disabled={rewriting}>
            <RefreshCw />
            Rewrite this lesson
          </Button>
        </div>
      )}
      <div className="space-y-4">
        {parts.map((part, i) => {
          if (part.kind === "text") return <LessonMarkdown key={i}>{part.markdown}</LessonMarkdown>;
          const task = part.taskId ? (byId.get(part.taskId) ?? null) : null;
          const key = task ? stepKey(task.id, part.nth) : null;
          return (
            <StepCard
              key={i}
              n={part.n}
              minutes={part.minutes}
              body={part.body}
              task={task}
              ticked={key !== null && ticks.has(key)}
              onToggle={() => key && onToggleStep(key)}
            />
          );
        })}
      </div>
    </>
  );
}
