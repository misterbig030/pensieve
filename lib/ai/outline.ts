import { generateObject } from "ai";
import { outlineDraftSchema, type OutlineDraft } from "@/lib/schemas/outline";
import { estimateCostUsd, DEFAULT_OUTLINE_MODEL } from "./models";

interface BuildOutlinePromptInput {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string }[];
  existingDraft?: OutlineDraft;
  instructions?: string;
  feedback?: string;
}

export function buildOutlinePrompt(input: BuildOutlinePromptInput): string {
  const parts: string[] = [];

  parts.push(`You are designing a day-by-day self-study curriculum.`);
  parts.push(`Topic: ${input.topic}`);
  if (input.periodDays) {
    parts.push(`Target length: approximately ${input.periodDays} days.`);
  }
  if (input.instructions) {
    parts.push(`The learner's focus & instructions: "${input.instructions}"`);
  }
  if (input.sources.length > 0) {
    parts.push(
      `The learner provided these reference sources — use them to shape the curriculum's order and coverage where relevant:`,
    );
    for (const source of input.sources) {
      parts.push(`- ${source.title ?? source.url} (${source.url})`);
    }
  }
  parts.push(
    `Decide for yourself whether this topic needs current, real-time information (e.g. recent news, evolving best practices) — if so, search the web before producing the outline. Otherwise rely on your own knowledge.`,
  );
  parts.push(`Order days from easiest/foundational to hardest/advanced.`);

  if (input.existingDraft) {
    parts.push(`Here is the current draft outline:`);
    for (const item of input.existingDraft.items) {
      parts.push(`Day ${item.dayIndex}: ${item.title} — ${item.summary}`);
    }
  }
  if (input.feedback) {
    parts.push(`The learner's feedback on the draft above: "${input.feedback}"`);
    parts.push(`Revise the draft to address this feedback. Return the complete revised list of days.`);
  }

  return parts.join("\n");
}

type GenerateOutlineDraftInput = BuildOutlinePromptInput;

export interface GenerateOutlineDraftResult {
  draft: OutlineDraft;
  costUsd: number;
}

export async function generateOutlineDraft(
  input: GenerateOutlineDraftInput,
): Promise<GenerateOutlineDraftResult> {
  const { object, usage } = await generateObject({
    model: DEFAULT_OUTLINE_MODEL,
    schema: outlineDraftSchema,
    prompt: buildOutlinePrompt(input),
  });
  return { draft: object, costUsd: estimateCostUsd(DEFAULT_OUTLINE_MODEL, usage) };
}
