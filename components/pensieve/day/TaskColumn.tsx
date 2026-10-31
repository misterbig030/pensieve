import type { ReactNode } from "react";
import { LESSON_TASK, taskMinutes, type DayTask } from "@/lib/dayTasks";
import { doneCount, taskTicked } from "@/lib/dayTicks";
import { formatDayTime } from "@/lib/studyTime";
import { TaskCard } from "./TaskCard";

/** The day page's left column: the day's tasks with their ticks and progress, then the day's controls (`children`). */
export function TaskColumn({
  unit,
  tasks,
  lessonMinutes,
  ticks,
  stepKeysOf,
  onToggleTask,
  children,
}: {
  unit: "day" | "week";
  tasks: DayTask[];
  /** The lesson's reading time once it is written; null before. */
  lessonMinutes: number | null;
  ticks: ReadonlySet<string>;
  stepKeysOf(taskId: string): string[];
  onToggleTask(taskId: string): void;
  children: ReactNode;
}) {
  const week = unit === "week";
  const total = tasks.reduce((t, task) => t + taskMinutes(task), 0);
  const ids = [...tasks.map((t) => t.id), ...(lessonMinutes !== null ? [LESSON_TASK] : [])];
  const done = doneCount(ids, stepKeysOf, ticks);
  const ticked = (id: string) => taskTicked(id, stepKeysOf(id), ticks);
  return (
    <>
      <h2 className="m-0 flex font-sans text-[11px] font-semibold tracking-[.04em] text-foreground/45 uppercase">
        {week ? "This week's tasks" : "Today's tasks"}
        {total > 0 && <span className="ml-auto font-medium tracking-normal normal-case">{formatDayTime(total)}</span>}
      </h2>
      {tasks.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">No tasks were assigned to this {week ? "week" : "day"}.</p>}
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} unit={unit} ticked={ticked(task.id)} onToggle={() => onToggleTask(task.id)} />
      ))}
      {lessonMinutes !== null && <TaskCard task={{ kind: "lesson", minutes: lessonMinutes }} unit={unit} ticked={ticked(LESSON_TASK)} onToggle={() => onToggleTask(LESSON_TASK)} />}
      {ids.length > 0 && (
        <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
          <span>
            {done} of {ids.length} done
          </span>
          <span
            role="progressbar"
            aria-label="Tasks done"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={ids.length}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/9"
          >
            <span className="block h-full rounded-full bg-accent-2-500 transition-[width]" style={{ width: `${(done / ids.length) * 100}%` }} />
          </span>
        </div>
      )}
      <div className="mt-auto flex flex-col gap-2.5 pt-2">{children}</div>
    </>
  );
}
