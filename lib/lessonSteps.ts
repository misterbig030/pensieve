import { STEP_FENCE } from "@/lib/schemas/dailyContent";

/** A lesson in reading order: markdown between steps, and the steps. */
export type LessonPart =
  | { kind: "text"; markdown: string }
  | {
      kind: "step";
      /** 1-based across the lesson. */
      n: number;
      /** The day task the step is about; null when the writer named none that exists. */
      taskId: string | null;
      /** How many earlier steps name the same task. */
      nth: number;
      minutes: number | null;
      body: string;
    };

/** A `step` fence at the start of a line, closed by the next line that is only a fence. */
function stepFences(): RegExp {
  return new RegExp(String.raw`^\x60\x60\x60${STEP_FENCE}[ \t]*\r?\n([\s\S]*?)^\x60\x60\x60[ \t]*$`, "gim");
}

const TASK_LINE = /^task:[ \t]*(.*?)[ \t]*$/i;
const MINUTES_LINE = /^minutes:[ \t]*(\d+)[ \t]*$/i;

/** The `task:` and `minutes:` lines at the top of a step's body, in either order, and the rest of it. */
function stepHeader(inner: string): { task: string | null; minutes: number | null; body: string } {
  const lines = inner.split(/\r?\n/);
  let task: string | null = null;
  let minutes: number | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const t = TASK_LINE.exec(lines[i]!);
    const m = MINUTES_LINE.exec(lines[i]!);
    if (t) task = t[1] || null;
    else if (m) minutes = Number(m[1]);
    else break;
  }
  return { task, minutes, body: lines.slice(i).join("\n").trim() };
}

/** Splits a lesson at its step fences. A lesson without any comes back whole, as one text part. */
export function splitLesson(markdown: string): LessonPart[] {
  const parts: LessonPart[] = [];
  const seen = new Map<string, number>();
  let last = 0;
  let n = 0;
  const pushText = (text: string) => {
    if (text.trim()) parts.push({ kind: "text", markdown: text });
  };
  for (const match of markdown.matchAll(stepFences())) {
    pushText(markdown.slice(last, match.index));
    last = match.index + match[0].length;
    const { task, minutes, body } = stepHeader(match[1]!);
    const nth = task ? (seen.get(task) ?? 0) : 0;
    if (task) seen.set(task, nth + 1);
    parts.push({ kind: "step", n: ++n, taskId: task, nth, minutes, body });
  }
  if (n === 0) return [{ kind: "text", markdown }];
  pushText(markdown.slice(last));
  return parts;
}

/** Rewrites the writer's task labels ("T1") in step fences to task ids; a label not on the day is emptied. */
export function resolveStepTokens(markdown: string, ids: ReadonlyMap<string, string>): string {
  const byToken = new Map([...ids].map(([token, id]) => [token.toLowerCase(), id]));
  return markdown.replace(stepFences(), (fence) =>
    fence.replace(/^task:[ \t]*(.*?)[ \t]*$/im, (_line, token: string) => {
      const id = byToken.get(token.toLowerCase());
      return id ? `task: ${id}` : "task:";
    }),
  );
}

/** A step's tick key: its task and how many steps for that task came before it. */
export function stepKey(taskId: string, nth: number): string {
  return `${taskId}@${nth}`;
}

/** True when a step names a task the day no longer has: the plan changed after the lesson was written. */
export function hasStaleSteps(parts: LessonPart[], taskIds: ReadonlySet<string>): boolean {
  return parts.some((p) => p.kind === "step" && p.taskId !== null && !taskIds.has(p.taskId));
}
