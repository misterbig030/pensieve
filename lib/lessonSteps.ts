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

const STEP_OPEN = new RegExp(String.raw`^\x60\x60\x60${STEP_FENCE}[ \t]*$`, "i");
const FENCE_CLOSE = /^```[ \t]*$/;
const FENCE_OPEN = /^```/;
const TASK_LINE = /^task:[ \t]*(.*?)[ \t]*$/i;
const MINUTES_LINE = /^minutes:[ \t]*(\d+)[ \t]*$/i;

/** A step fence's lines: its opening line, its closing line, and the lines of its header (`task:`, `minutes:`). */
interface StepSpan {
  open: number;
  close: number;
  header: number[];
}

/**
 * The lesson's lines and its step fences. A step opens with a ```step line at the start of a line, outside any other
 * code block, and closes at the first bare fence that does not close a code block opened inside it.
 */
function scan(markdown: string): { lines: string[]; steps: StepSpan[] } {
  const lines = markdown.split("\n");
  const bare = lines.map((l) => l.replace(/\r$/, ""));
  const steps: StepSpan[] = [];
  let outer = false;
  for (let i = 0; i < bare.length; i++) {
    const line = bare[i]!;
    if (outer) {
      if (FENCE_CLOSE.test(line)) outer = false;
      continue;
    }
    if (!STEP_OPEN.test(line)) {
      if (FENCE_OPEN.test(line)) outer = true;
      continue;
    }
    let inner = false;
    let close = -1;
    for (let j = i + 1; j < bare.length; j++) {
      if (inner) {
        if (FENCE_CLOSE.test(bare[j]!)) inner = false;
      } else if (FENCE_CLOSE.test(bare[j]!)) {
        close = j;
        break;
      } else if (FENCE_OPEN.test(bare[j]!)) inner = true;
    }
    if (close < 0) break; // An unclosed step stays text, as an unclosed fence would.
    const header: number[] = [];
    for (let j = i + 1; j < close && (TASK_LINE.test(bare[j]!) || MINUTES_LINE.test(bare[j]!)); j++) header.push(j);
    steps.push({ open: i, close, header });
    i = close;
  }
  return { lines: bare, steps };
}

/** Splits a lesson at its step fences. A lesson without any comes back whole, as one text part. */
export function splitLesson(markdown: string): LessonPart[] {
  const { lines, steps } = scan(markdown);
  if (steps.length === 0) return [{ kind: "text", markdown }];
  // Offsets of each line's start in the original text, so text between steps is sliced from it unchanged.
  const starts = [0];
  for (const line of markdown.split("\n")) starts.push(starts.at(-1)! + line.length + 1);
  const parts: LessonPart[] = [];
  const seen = new Map<string, number>();
  const pushText = (text: string) => {
    if (text.trim()) parts.push({ kind: "text", markdown: text });
  };
  let last = 0;
  steps.forEach((span, i) => {
    pushText(markdown.slice(last, starts[span.open]));
    last = starts[span.close]! + lines[span.close]!.length;
    let task: string | null = null;
    let minutes: number | null = null;
    for (const j of span.header) {
      const t = TASK_LINE.exec(lines[j]!);
      if (t) task = t[1] || null;
      else minutes = Number(MINUTES_LINE.exec(lines[j]!)![1]);
    }
    const body = lines.slice(span.open + 1 + span.header.length, span.close).join("\n").trim();
    const nth = task ? (seen.get(task) ?? 0) : 0;
    if (task) seen.set(task, nth + 1);
    parts.push({ kind: "step", n: i + 1, taskId: task, nth, minutes, body });
  });
  pushText(markdown.slice(last));
  return parts;
}

/**
 * Rewrites the writer's task labels in step headers to task ids. The label is found inside whatever the writer put
 * around it ("[T1]", "**T1**", "T1 (the reading)"); a label not on the day is emptied.
 */
export function resolveStepTokens(markdown: string, ids: ReadonlyMap<string, string>): string {
  const byToken = new Map([...ids].map(([token, id]) => [token.toLowerCase(), id]));
  const { steps } = scan(markdown);
  const lines = markdown.split("\n");
  for (const span of steps) {
    for (const j of span.header) {
      const value = TASK_LINE.exec(lines[j]!.replace(/\r$/, ""))?.[1];
      if (value === undefined) continue;
      const token = (/\bT\d+\b/i.exec(value)?.[0] ?? value).toLowerCase();
      const id = byToken.get(token);
      lines[j] = id ? `task: ${id}` : "task:";
    }
  }
  return lines.join("\n");
}

/** A step's tick key: its task and how many steps for that task came before it. */
export function stepKey(taskId: string, nth: number): string {
  return `${taskId}@${nth}`;
}

/** True when a step names a task the day no longer has: the plan changed after the lesson was written. */
export function hasStaleSteps(parts: LessonPart[], taskIds: ReadonlySet<string>): boolean {
  return parts.some((p) => p.kind === "step" && p.taskId !== null && !taskIds.has(p.taskId));
}
