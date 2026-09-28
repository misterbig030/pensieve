import { dailyContentSchema, type DailyContentDraft } from "@/lib/schemas/dailyContent";
import type { MaterialKind, MaterialTier } from "@/lib/schemas/material";
import type { SourceType } from "@/lib/schemas/source";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { DEFAULT_CONTENT_MODEL } from "./models";
import { canonicalUrl } from "./research/verify";

/** One row of the unit's Read table, as the lesson prompt sees it. */
export interface LessonMaterial {
  title: string;
  url: string;
  type: SourceType;
  kind?: MaterialKind;
  tier?: MaterialTier | null;
  minutes?: number | null;
  note?: string | null;
}

interface BuildDailyContentPromptInput {
  title: string;
  summary: string;
  /** The unit's assigned materials. The lesson may cite only these. */
  materials: LessonMaterial[];
  /** A day is one lesson; a week is the material for several self-paced sessions. Defaults to a day. */
  unit?: "day" | "week";
  /** Span of the unit in days (weeks only). */
  spanDays?: number;
}

function row(m: LessonMaterial): string {
  const meta = [m.tier, m.minutes ? `${m.minutes} min` : null, m.note].filter(Boolean).join(", ");
  return `- ${m.title} (${m.url})${meta ? ` — ${meta}` : ""}`;
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
    parts.push(`This unit's reading list. Guide the learner through it in order of tier (must before should), and point to the part named in each note:`);
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
    for (const s of other) parts.push(`- ${s.title ?? s.url}`);
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
  const { object, costUsd } = await loggedGenerateObject(
    {
      model: DEFAULT_CONTENT_MODEL,
      schema: dailyContentSchema,
      prompt: buildDailyContentPrompt(input),
      facts: [`${input.materials.length} material${input.materials.length === 1 ? "" : "s"} on the list`],
      check: (object) => {
        const { citations, dropped } = enforceCitations(object.citations, input.materials);
        return [`${citations.length} citation${citations.length === 1 ? "" : "s"} kept`, ...(dropped > 0 ? [`${dropped} cited off the list, dropped`] : [])];
      },
    },
    { ...input.log, caller: "daily" },
  );
  const { citations, dropped } = enforceCitations(object.citations, input.materials);
  return { content: { ...object, citations }, costUsd, droppedCitations: dropped };
}
