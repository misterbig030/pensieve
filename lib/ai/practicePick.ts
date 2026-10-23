import { PRACTICE_FORMATS, PRACTICE_REGISTRY, MAX_PRACTICE_PICKS } from "@/lib/practice";
import type { SourceInput } from "@/lib/schemas/source";
import { normalizeSplit, planSplitDraftSchema, type PlanSplit } from "@/lib/studyTime";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { providerError } from "./providerError";
import type { ResolvedModel } from "./resolve";

export interface PracticePickInput {
  topic: string;
  instructions?: string;
  weeks: number;
  daysPerWeek: number;
  hoursPerWeek?: number;
  sources: SourceInput[];
}

/** The split used when the model gives none: all reading, which is what a plan without practice formats always was. */
const ALL_READING: PlanSplit = { readingShare: 100, practice: "reading", reason: "", formats: [] };

/**
 * The prompt for the pick: the learner's brief, one line per practice format, and worked examples of how a topic maps
 * to picks. The examples are guidance, and the learner's instructions outrank them.
 */
export function buildPracticePickPrompt(input: PracticePickInput): string {
  const hours = input.hoursPerWeek ? `, about ${input.hoursPerWeek} hours a week` : "";
  const sources = input.sources.map((s) => `- ${s.title?.trim() || s.url} (${s.type})`);
  return [
    "You decide how a self-study plan divides its time between reading or watching and assigned practice, before any research is done.",
    "",
    "The learner's brief:",
    `Topic: ${input.topic}`,
    ...(input.instructions?.trim() ? [`Instructions: ${input.instructions.trim()}`] : []),
    `Length: ${input.weeks} weeks, ${input.daysPerWeek} study days a week${hours}.`,
    ...(sources.length > 0 ? ["Materials the learner supplied:", ...sources] : []),
    "",
    "The practice formats:",
    ...PRACTICE_FORMATS.map((f) => `- ${f} (${PRACTICE_REGISTRY[f].label}): the learner ${PRACTICE_REGISTRY[f].prompt}.`),
    "",
    `Pick 0 to ${MAX_PRACTICE_PICKS} formats, each with a share of the practice time (the shares sum to 100), a short focus saying what it is aimed at, and a one-sentence reason. Pick none when the topic is only learned by reading; then readingShare is 100. readingShare is the percent of all study time spent reading or watching; the rest goes to the picked formats.`,
    "Name the practice in two or three words in the topic's own terms (the \"practice\" field).",
    "",
    "The learner's instructions win over the examples. The examples show the kind of reasoning, they are guidance and not rules; decide from this topic and this learner.",
    "Worked examples:",
    "- an SDE interview loop: problem-set for coding problems, design-exercise for system design, mock for full rounds, recall for behavioral stories; reading is a small share.",
    "- an MLE interview loop: the same, with design-exercise for ML system design and recall for core concepts.",
    "- a history topic: mostly reading; recall to retain dates and causes; no other format.",
    "- Git: lab for guided steps in a real repository, a little recall; reading is small.",
    "- Couch to 5K: session for the programme's runs, almost no reading.",
  ].join("\n");
}

/**
 * Asks the outline model how the plan's time splits between reading and practice formats, before research runs. When
 * the model returns no usable split, or leaves its picks out, the plan is all reading and the call's facts say why.
 * A call that fails is all reading too, so the draft goes on; but a refusal on the learner's own key is theirs to hear
 * about, and a request that has gone away stops here.
 */
export async function pickPractice(
  input: PracticePickInput & { model: ResolvedModel; log?: GenerationLogContext; signal?: AbortSignal },
): Promise<{ split: PlanSplit; costUsd: number }> {
  let split: PlanSplit = ALL_READING;
  const check = (draft: Parameters<typeof normalizeSplit>[0]): string[] => {
    const normalized = normalizeSplit(draft);
    if (!normalized) return ["no split returned"];
    if (!normalized.formats) return ["no picks returned"];
    split = normalized;
    const picks = normalized.formats.map((p) => `${p.format} ${p.share}%`);
    return [`reading ${normalized.readingShare}%`, picks.length > 0 ? `picks: ${picks.join(", ")}` : "no picks"];
  };
  try {
    const { costUsd } = await loggedGenerateObject(
      {
        model: input.model.id,
        languageModel: typeof input.model.model === "string" ? undefined : input.model.model,
        keyOwner: input.model.keyOwner,
        schema: planSplitDraftSchema,
        prompt: buildPracticePickPrompt(input),
        label: "Practice · pick",
        check,
        abortSignal: input.signal,
      },
      { ...input.log, caller: "outline" },
    );
    return { split, costUsd };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (input.model.keyOwner === "user" && providerError(error)) throw error;
    console.error("[draft] practice pick failed; the plan is all reading", error);
    return { split: ALL_READING, costUsd: 0 };
  }
}
