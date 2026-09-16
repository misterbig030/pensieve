import { dailyContentSchema, type DailyContentDraft } from "@/lib/schemas/dailyContent";
import type { SourceInput } from "@/lib/schemas/source";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { DEFAULT_CONTENT_MODEL } from "./models";

interface BuildDailyContentPromptInput {
  title: string;
  summary: string;
  sources: SourceInput[];
  /** A day is one lesson; a week is the material for several self-paced sessions. Defaults to a day. */
  unit?: "day" | "week";
  /** Span of the unit in days (weeks only). */
  spanDays?: number;
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

  const linkSources = input.sources.filter((s) => s.type === "link");
  const youtubeSources = input.sources.filter((s) => s.type === "youtube");
  const otherSources = input.sources.filter((s) => s.type === "file" || s.type === "note");

  if (linkSources.length > 0) {
    parts.push(`Reference sources to draw from (cite them in the citations list when used):`);
    for (const s of linkSources) parts.push(`- ${s.title ?? s.url} (${s.url})`);
  }
  if (youtubeSources.length > 0) {
    parts.push(
      `The learner also provided these YouTube videos. Do not attempt to watch, summarize, or extract spoken content from them — just mention them by title in the lesson text as a suggested video, since the app will render them as an embed/link card separately:`,
    );
    for (const s of youtubeSources) parts.push(`- ${s.title ?? s.url} (${s.url})`);
  }
  if (otherSources.length > 0) {
    parts.push(
      `The learner also referenced these materials (a local file or a free-text note) — you cannot access their contents, so use them only as context for what to emphasize, not as a citable source:`,
    );
    for (const s of otherSources) parts.push(`- ${s.title ?? s.url}`);
  }

  parts.push(
    `Decide for yourself whether this lesson needs current, real-time information — if so, search the web before writing. Otherwise rely on your own knowledge and the sources above.`,
  );
  parts.push(
    `Write the lesson body as markdown in the "contentMarkdown" field. List every external source you actually drew from in "citations" with its title and URL.`,
  );

  return parts.join("\n");
}

type GenerateDailyContentInput = BuildDailyContentPromptInput & {
  /** Who is asking and where to record the call. Omit for no logging (eval harness, tests). */
  log?: GenerationLogContext;
};

export interface GenerateDailyContentResult {
  content: DailyContentDraft;
  costUsd: number;
}

export async function generateDailyContent(
  input: GenerateDailyContentInput,
): Promise<GenerateDailyContentResult> {
  const { object, costUsd } = await loggedGenerateObject(
    {
      model: DEFAULT_CONTENT_MODEL,
      schema: dailyContentSchema,
      prompt: buildDailyContentPrompt(input),
    },
    { ...input.log, caller: "daily" },
  );
  return { content: object, costUsd };
}
