import { ArrowUpRight } from "lucide-react";
import { LessonMarkdown } from "@/components/pensieve/LessonMarkdown";
import { taskHref, taskTitle, type DayTask } from "@/lib/dayTasks";
import { cn } from "@/lib/utils";
import { Tick } from "./Tick";

/**
 * One step of a lesson: what to go and do, how long, and the task it is part of. Its tick is the task's: a task with
 * steps is done once they all are. A step whose task is not on the day has neither link nor tick.
 */
export function StepCard({ n, minutes, body, task, ticked, onToggle }: { n: number; minutes: number | null; body: string; task: DayTask | null; ticked: boolean; onToggle(): void }) {
  const href = task && taskHref(task);
  const done = task !== null && ticked;
  return (
    <div
      data-done={done}
      className={cn(
        "flex items-start gap-3 rounded-2xl px-3.5 py-2.5 text-[14px]",
        done ? "bg-accent-2-100 shadow-[inset_0_0_0_1px_var(--accent-2-200)]" : "bg-accent-100 shadow-[inset_0_0_0_1px_var(--accent-200)]",
      )}
    >
      <span className={cn("mt-[3px] text-[11px] font-bold tracking-[.05em] whitespace-nowrap uppercase", done ? "text-accent-2-600" : "text-primary")}>Step {n}</span>
      <div className="min-w-0 flex-1 space-y-1.5 [&_p]:text-[14px] [&_p]:leading-[1.55]">
        <LessonMarkdown>{body}</LessonMarkdown>
        {task &&
          (href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent-800 underline underline-offset-2">
              {taskTitle(task)}
              <ArrowUpRight className="size-3.5" />
            </a>
          ) : (
            <span className="text-[12.5px] font-semibold text-accent-800">{taskTitle(task)}</span>
          ))}
      </div>
      {minutes !== null && <span className="mt-[3px] text-[12px] whitespace-nowrap text-muted-foreground">{minutes} min</span>}
      {task && <Tick on={ticked} label={`Step ${n}`} onToggle={onToggle} />}
    </div>
  );
}
