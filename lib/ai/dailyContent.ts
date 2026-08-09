import { generateObject } from "ai";
import { dailyContentSchema, type DailyContentDraft } from "@/lib/schemas/dailyContent";
import type { SourceInput } from "@/lib/schemas/source";
import { estimateCostUsd, DEFAULT_CONTENT_MODEL } from "./models";

interface BuildDailyContentPromptInput {
  title: string;
  summary: string;
  sources: SourceInput[];
}

export function buildDailyContentPrompt(input: BuildDailyContentPromptInput): string {
  const parts: string[] = [];

  parts.push(`Write today's lesson for a self-study curriculum.`);
  parts.push(`Day title: ${input.title}`);
  parts.push(`Day summary: ${input.summary}`);

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

type GenerateDailyContentInput = BuildDailyContentPromptInput;

export interface GenerateDailyContentResult {
  content: DailyContentDraft;
  costUsd: number;
}

export async function generateDailyContent(
  input: GenerateDailyContentInput,
): Promise<GenerateDailyContentResult> {
  const { object, usage } = await generateObject({
    model: DEFAULT_CONTENT_MODEL,
    schema: dailyContentSchema,
    prompt: buildDailyContentPrompt(input),
  });
  return { content: object, costUsd: estimateCostUsd(DEFAULT_CONTENT_MODEL, usage) };
}
