import { ANSWERS_FENCE, STEP_FENCE, dailyContentSchema, type DailyContentDraft } from "@/lib/schemas/dailyContent";
import { resolveStepTokens } from "@/lib/lessonSteps";
import type { Chapter, MaterialKind, MaterialTier, RefActivity } from "@/lib/schemas/material";
import type { PracticeFormat } from "@/lib/practice";
import type { SourceType } from "@/lib/schemas/source";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { DEFAULT_CONTENT_MODEL } from "./models";
import { appModel, type ResolvedModel } from "./resolve";
import { canonicalUrl } from "./research/verify";

/** One row of the unit's Read table, as the lesson prompt sees it. */
export interface LessonMaterial {
  title: string;
  url: string;
  type: SourceType;
  kind?: MaterialKind;
  tier?: MaterialTier | null;
  minutes?: number | null;
  /** The part: a chapter's sections, or the part of a resource without chapters. */
  note?: string | null;
  /** The chapter this row reads, from the book's list. */
  chapter?: Pick<Chapter, "n" | "title" | "sections"> | null;
  /** "review" revisits something an earlier unit read. */
  activity?: RefActivity;
  /** The day task this row is: the label the writer sees and the id its steps are stored under. */
  step?: LessonStep;
}

/** A task's label in the prompt ("T1") and the task id a step naming it is stored with. */
export interface LessonStep {
  token: string;
  id: string;
}

/** One row of the unit's Do table, as the lesson prompt sees it. */
export interface LessonPractice {
  format: PracticeFormat;
  /** The format's name: "Problems", "Recall". */
  label: string;
  task: string;
  /** How the learner knows it is finished. */
  done: string;
  minutes: number;
  /** The material the row is from; for a generated recall row, the reading it is made from; null for any other generated row. */
  source: { title: string; url: string } | null;
  generated: boolean;
  step?: LessonStep;
}

interface BuildDailyContentPromptInput {
  title: string;
  summary: string;
  /** The unit's assigned materials. The lesson may cite only these. */
  materials: LessonMaterial[];
  /** The unit's Do table. The lesson explains how to do and check each task; its sources are linked, never cited. */
  practice?: LessonPractice[];
  /** A day is one lesson; a week is the material for several self-paced sessions. Defaults to a day. */
  unit?: "day" | "week";
  /** Span of the unit in days (weeks only). */
  spanDays?: number;
}

/**
 * `- AI Engineering (url) — ch. 2 "Understanding Foundation Models" · sections: Post-Training; Sampling — must, 35 min`.
 * The sections are the row's note when it has one, else the chapter's listed sections; a review says so.
 */
function row(m: LessonMaterial): string {
  const review = m.activity === "review";
  let part: string | null = null;
  if (m.chapter) {
    const sections = m.note ?? (m.chapter.sections.length > 0 ? m.chapter.sections.join("; ") : null);
    part = `${review ? "review of " : ""}${m.chapter.n !== null ? `ch. ${m.chapter.n} ` : ""}"${m.chapter.title}"${sections ? ` · sections: ${sections}` : ""}`;
  } else if (review) part = "review";
  const meta = [m.tier, m.minutes ? `${m.minutes} min` : null, m.chapter ? null : m.note].filter(Boolean).join(", ");
  return `- ${label(m)}${m.title} (${m.url})${part ? ` — ${part}` : ""}${meta ? ` — ${meta}` : ""}`;
}

/** `- Problems: Do problems 1-10 (60 min) — done when: … — source: Problem list (url)`, or `— generated` when no source stands behind it. */
function practiceRow(p: LessonPractice): string {
  const origin = p.source ? (p.generated ? `generated from the reading: ${p.source.title} (${p.source.url})` : `source: ${p.source.title} (${p.source.url})`) : "generated";
  return `- ${label(p)}${p.label}: ${p.task} (${p.minutes} min) — done when: ${p.done} — ${origin}`;
}

/** `[T1] ` before a task's row in steps mode, nothing otherwise. */
function label(row: { step?: LessonStep }): string {
  return row.step ? `[${row.step.token}] ` : "";
}

/** The practice section of the prompt: the tasks, and what the lesson writes for them. */
function practiceSection(practice: LessonPractice[], steps: boolean): string[] {
  const parts = [
    steps
      ? `This unit's practice. Give each task at least one step, and around its steps explain how to set it up, how to work through it, and how the learner knows it is done, by its "done when" line. Link a task's source where it helps, but cite none of these sources in "citations":`
      : `This unit's practice. End the lesson with a section on how to do and check each task: how to set it up, how to work through it, and how the learner knows it is done, by its "done when" line. Explain the tasks; do not just repeat the list. Link a task's source where it helps, but cite none of these sources in "citations":`,
    ...practice.map(practiceRow),
  ];
  if (practice.some((p) => p.generated && p.format === "recall")) {
    parts.push(
      `For each generated Recall task, write its questions, then their answers in a fenced code block with the info string "${ANSWERS_FENCE}" (\`\`\`${ANSWERS_FENCE}), written as markdown inside the fence; the lesson shows that block collapsed, so the learner answers first. Draw the questions and answers only from this unit's reading above.`,
    );
  }
  if (practice.some((p) => p.generated && p.format !== "recall")) {
    parts.push(`Generated tasks of any other format get how-to guidance only: do not write exercises, problems or other content for them.`);
  }
  return parts;
}

export function buildDailyContentPrompt(input: BuildDailyContentPromptInput): string {
  const parts: string[] = [];

  if (input.unit === "week") {
    parts.push(
      `Write this week's study material for a self-study curriculum. The learner works through it in several sessions of their own choosing over ${input.spanDays ?? 7} days, so organise it as a few clearly separated parts they can pick up one at a time, not as a day-by-day timetable.`,
    );
    parts.push(`Week title: ${input.title}`);
    parts.push(`Week summary: ${input.summary}`);
  } else {
    parts.push(`Write today's lesson for a self-study curriculum.`);
    parts.push(`Day title: ${input.title}`);
    parts.push(`Day summary: ${input.summary}`);
  }

  const readable = input.materials.filter((s) => s.type === "link");
  const videos = input.materials.filter((s) => s.type === "youtube");
  const other = input.materials.filter((s) => s.type === "file" || s.type === "note");

  if (readable.length > 0) {
    const reviews = readable.some((s) => s.activity === "review");
    parts.push(
      `This unit's reading list. Guide the learner through it in order of tier (must before should), and point to the part named in each note:${reviews ? " Rows marked review revisit material the learner read earlier: recap and connect it to today, do not teach it afresh." : ""}`,
    );
    for (const s of readable) parts.push(row(s));
  }
  if (videos.length > 0) {
    parts.push(
      `Videos on this unit's list. Do not attempt to watch, summarize, or extract spoken content from them — refer to them by title where they fit, since the app renders them as an embed/link card separately:`,
    );
    for (const s of videos) parts.push(row(s));
  }
  if (other.length > 0) {
    parts.push(
      `The learner also referenced these materials (a local file or a free-text note) — you cannot access their contents, so use them only as context for what to emphasize, not as a citable source:`,
    );
    for (const s of other) parts.push(`- ${label(s)}${s.title ?? s.url}`);
  }

  const steps = [...input.materials, ...(input.practice ?? [])].some((row) => row.step);
  if (input.practice && input.practice.length > 0) parts.push(...practiceSection(input.practice, steps));
  if (steps) {
    parts.push(
      `Each task above has a label in square brackets, like [T1]. Write the lesson as a walk-through of these tasks in this order. Each time the learner should go and do part of a task, write a step: a fenced code block with the info string "${STEP_FENCE}" (\`\`\`${STEP_FENCE}), at the top level of the lesson, never inside a list, whose first line names the one task by its label without brackets, as in "task: T1", whose second line is your estimate for that step, as in "minutes: 25", and whose other lines say in one or two sentences of markdown exactly what to do. A task may have several steps, such as the first half of a chapter and then the second. Write your explanation between the steps as ordinary markdown.`,
    );
  }

  parts.push(
    readable.length + videos.length > 0
      ? `Write the lesson body as markdown in the "contentMarkdown" field. In "citations", list only materials from this unit's list above that the lesson draws on, with their exact URL. Cite nothing else.`
      : `Write the lesson body as markdown in the "contentMarkdown" field. This unit has no citable materials, so leave "citations" empty.`,
  );

  return parts.join("\n");
}

/**
 * Keeps only citations that point at one of the unit's materials, by canonical URL, under the material's own title.
 * This is source fidelity checked in code: a lesson cannot cite something the plan did not assign.
 */
export function enforceCitations(
  citations: DailyContentDraft["citations"],
  materials: LessonMaterial[],
): { citations: DailyContentDraft["citations"]; dropped: number } {
  const byUrl = new Map<string, LessonMaterial>();
  for (const m of materials) {
    if (m.type !== "link" && m.type !== "youtube") continue;
    const key = canonicalUrl(m.url);
    if (key) byUrl.set(key, m);
  }
  const kept: DailyContentDraft["citations"] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const c of citations) {
    const key = canonicalUrl(c.url);
    const material = key ? byUrl.get(key) : undefined;
    if (!material || seen.has(key!)) {
      if (!material) dropped += 1;
      continue;
    }
    seen.add(key!);
    kept.push({ title: material.title, url: material.url });
  }
  return { citations: kept, dropped };
}

type GenerateDailyContentInput = BuildDailyContentPromptInput & {
  /** Who is asking and where to record the call. Omit for no logging (eval harness, tests). */
  log?: GenerationLogContext;
  /** The model that writes the content; the app's content model when omitted. */
  model?: ResolvedModel;
};

export interface GenerateDailyContentResult {
  content: DailyContentDraft;
  costUsd: number;
  /** Citations removed because they were not on the unit's list. */
  droppedCitations: number;
}

export async function generateDailyContent(
  input: GenerateDailyContentInput,
): Promise<GenerateDailyContentResult> {
  const model = input.model ?? appModel(DEFAULT_CONTENT_MODEL);
  const { object, costUsd } = await loggedGenerateObject(
    {
      model: model.id,
      languageModel: typeof model.model === "string" ? undefined : model.model,
      keyOwner: model.keyOwner,
      schema: dailyContentSchema,
      prompt: buildDailyContentPrompt(input),
      label: `Lesson · ${input.title}`,
      facts: [`${input.materials.length} material${input.materials.length === 1 ? "" : "s"} on the list`],
      check: (object) => {
        const { citations, dropped } = enforceCitations(object.citations, input.materials);
        return [`${citations.length} citation${citations.length === 1 ? "" : "s"} kept`, ...(dropped > 0 ? [`${dropped} cited off the list, dropped`] : [])];
      },
    },
    { ...input.log, caller: "daily" },
  );
  const { citations, dropped } = enforceCitations(object.citations, input.materials);
  // The writer names tasks by their labels; the lesson is stored with task ids, which survive a plan revision.
  const ids = new Map([...input.materials, ...(input.practice ?? [])].flatMap((row) => (row.step ? [[row.step.token, row.step.id] as const] : [])));
  const contentMarkdown = ids.size > 0 ? resolveStepTokens(object.contentMarkdown, ids) : object.contentMarkdown;
  return { content: { ...object, contentMarkdown, citations }, costUsd, droppedCitations: dropped };
}
