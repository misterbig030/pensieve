import { itemLabel, rowHref, type PracticeRow, type ReadRow } from "@/components/pensieve/ReadTable";
import { shortTitle } from "@/lib/shortTitle";

/**
 * One thing assigned for a day or week: a Read row or a Do row. `id` is drawn from what the row is, not where it sits,
 * so a step written against it still finds it after the plan is revised; `token` is the short label the lesson writer
 * sees ("T1").
 */
export type DayTask = { kind: "read"; id: string; token: string; row: ReadRow } | { kind: "practice"; id: string; token: string; row: PracticeRow };

/** The tick key of the "Read today's lesson" card. */
export const LESSON_TASK = "lesson";

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The day's tasks: its Read rows in the order given (must first), then its Do rows, labelled T1…Tn. */
export function dayTasks(readRows: ReadRow[], practiceRows: PracticeRow[]): DayTask[] {
  const seen = new Map<string, number>();
  const unique = (id: string) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}~${n}`;
  };
  const tasks: DayTask[] = [];
  for (const row of readRows) tasks.push({ kind: "read", id: unique(`read:${row.key}`), token: `T${tasks.length + 1}`, row });
  for (const row of practiceRows) {
    const id = `practice:${row.format}#${row.material?.id ?? "generated"}#${row.itemFrom ?? slug(row.task)}`;
    tasks.push({ kind: "practice", id: unique(id), token: `T${tasks.length + 1}`, row });
  }
  return tasks;
}

/** "AI Engineering, ch. 3" for a chapter, the short title for a whole resource; a problem by its item, else the task. */
export function taskTitle(task: DayTask): string {
  if (task.kind === "practice") return task.row.item ? itemLabel(task.row.item) : task.row.task;
  const { material, chapter } = task.row;
  const title = shortTitle(material.title);
  if (!chapter) return title;
  return `${title}, ${chapter.n !== null ? `ch. ${chapter.n}` : chapter.title}`;
}

/** Where a task opens: the chapter or material page, the problem's own page; null for a note or file. */
export function taskHref(task: DayTask): string | null {
  if (task.kind === "practice") return task.row.item?.url ?? task.row.material?.url ?? null;
  const type = task.row.material.type;
  return type === "note" || type === "file" ? null : rowHref(task.row);
}

export function taskMinutes(task: DayTask): number {
  return task.row.minutes ?? 0;
}

/** What the lesson will take the learner through, one line per task. */
export function lessonPreview(tasks: DayTask[]): string[] {
  return tasks.map((task) => {
    if (task.kind === "practice") return `${task.row.label}: ${taskTitle(task)}`;
    const verb = task.row.activity === "review" ? "Review" : task.row.material.type === "youtube" ? "Watch" : "Read";
    return `${verb} ${taskTitle(task)}`;
  });
}

/** Reading time of a lesson at 200 words a minute, to the nearest 5 minutes, at least 5. */
export function lessonMinutes(markdown: string): number {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.round(words / 200 / 5) * 5);
}
