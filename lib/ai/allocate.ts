import { z } from "zod";
import { isPracticeOnly, pickSources } from "@/lib/materials";
import { MAX_PRACTICE_PICKS, PRACTICE_FORMATS, PRACTICE_REGISTRY, normalizePicks, practicePickDraftSchema, type PracticeGenerated } from "@/lib/practice";
import { MIN_CHAPTERS, clip, type Chapter, type Material, type MaterialPractice } from "@/lib/schemas/material";
import { normalizeSplit, totalHours, type PlanSplit } from "@/lib/studyTime";
import { loggedGenerateObject, type GenerationLogContext } from "./logged";
import { formatMinutes, practiceTag, sizingSentence } from "./planPrompt";
import { providerError } from "./providerError";
import type { DroppedMaterial } from "./research/events";
import type { ResolvedModel } from "./resolve";

/** The split used when the allocation gives none: all reading, which is what a plan without practice formats always was. */
export const ALL_READING: PlanSplit = { readingShare: 100, practice: "reading", reason: "", formats: [] };

export interface AllocationInput {
  topic: string;
  instructions?: string;
  weeks: number;
  daysPerWeek: number;
  hoursPerWeek: number;
  materials: Material[];
}

/** What the model writes: loose on purpose, so an odd number never fails the call; `applyAllocation` makes it valid. */
export const allocationDraftSchema = z.object({
  readingShare: z.number().describe("Your own estimate of the percent of all study time spent reading or watching, 0 to 100. Code recomputes it from the reading parts you keep."),
  practice: z.string().describe("What the practice time is spent on, in two or three words in the topic's own terms"),
  reason: z.string().describe("One or two sentences for the learner: how the plan's time is divided and why"),
  picks: z
    .array(practicePickDraftSchema)
    .describe(`The practice formats the practice time goes to, at most ${MAX_PRACTICE_PICKS}, with shares of the practice time summing to 100; empty when the plan is all reading`),
  parts: z
    .array(
      z.object({
        id: z.string().describe("A material id from the list, e.g. M3"),
        uses: z.string().nullable().describe('The part the plan uses, in a few words ("chapters on replication", "the core patterns"); null for the whole'),
        minutes: z.number().nullable().describe("Minutes of reading or watching for that part, for a material without a chapter list; null for the whole"),
        chapters: z.array(z.number()).nullable().describe("For a material with a chapter list: the bracketed positions of the chapters the plan keeps; null for every chapter"),
        items: z.number().nullable().describe("For a practice source: how many of its items the plan works through; null for all of them"),
        drop: z.boolean().describe("True when the plan does not use this material at all"),
        dropReason: z.string().nullable().describe("Why the plan does not use it, when drop is true"),
      }),
    )
    .describe("One entry per material: the part of it the plan uses, or that it is dropped"),
});
export type AllocationDraft = z.infer<typeof allocationDraftSchema>;
type AllocationPart = AllocationDraft["parts"][number];

/** Whether a format's rows can be written without a source, as the prompt says it. */
const WRITABLE: Record<PracticeGenerated, string> = {
  never: "It needs a source in the list; it can't be written without one.",
  "from-reading": "It can be written from the plan's own reading.",
  "with-rubric": "It can be written as a prompt with a rubric.",
  milestones: "It can be written as milestones of one build.",
  "interview-only": "It can be written for an interview, never for an exam.",
  "from-programme": "It can be written only from a programme in the list or the plan's own reading.",
};

/** `M1 [book · backbone] "Title" — Author, 2020 · reading about 10 h (estimated). Why: …`, then its chapters by position. */
function materialLines(m: Material): string[] {
  const tags = [m.kind, m.backbone ? "backbone" : null, m.origin === "learner" ? "the learner's own" : null].filter(Boolean).join(" · ");
  const byline = [m.author, m.year].filter(Boolean).join(", ");
  const size = m.minutes
    ? `reading about ${formatMinutes(m.minutes)}${m.minutesBasis ? ` (${m.minutesBasis})` : ""}`
    : m.practice
      ? "no reading time"
      : "reading size unknown";
  const practice = m.practice ? ` · ${practiceTag(m.practice)}${m.practice.minutes ? ` · doing about ${formatMinutes(m.practice.minutes)}` : ""}` : "";
  const uses = m.uses ? ` · as listed: ${m.uses}` : "";
  const line = `${m.id} [${tags}] "${m.title}"${byline ? ` — ${byline}` : ""} · ${size}${practice}${uses}${m.why ? `. Why: ${m.why}` : ""}`;
  if (!m.toc) return [line];
  const chapters = m.toc.chapters.map(
    (c, i) => `  [${i + 1}] ${c.n !== null ? `ch. ${c.n} ` : ""}"${c.title}"${c.minutes !== null ? ` · about ${formatMinutes(c.minutes)}` : ""}`,
  );
  return [line, ...chapters];
}

/**
 * The allocation prompt: the brief, every material with its size, chapters and practice role, every practice format
 * with how it is sized and whether it can be written, and what to weigh. It names no target share: the split is the
 * model's judgement, and the reading share is worked out in code from the parts it keeps.
 */
export function buildAllocationPrompt(input: AllocationInput): string {
  const hours = totalHours(input.weeks, input.hoursPerWeek);
  const weeks = `${input.weeks} week${input.weeks === 1 ? "" : "s"}`;
  const days = `${input.daysPerWeek} study day${input.daysPerWeek === 1 ? "" : "s"} a week`;
  return [
    "You divide a self-study plan's time now that research has found its materials. You decide which part of each material the plan uses and how the practice time is shared between practice formats. The reading share is then worked out from the reading parts you keep, so choose the parts this learner needs rather than adding up the list.",
    "",
    "The learner's brief:",
    `Topic: ${input.topic}`,
    ...(input.instructions?.trim() ? [`The learner's focus & instructions: "${input.instructions.trim()}"`] : []),
    `Time: ${weeks}, ${days}, about ${input.hoursPerWeek} hours a week: ${hours} hours in all.`,
    "",
    ...(input.materials.length > 0
      ? [
          'The materials, by id. Those marked "the learner\'s own" were supplied by the learner; the rest were found and checked by research. A book with a chapter list shows each chapter\'s position in brackets.',
          ...input.materials.flatMap(materialLines),
        ]
      : ["There are no materials: research found none and the learner supplied none."]),
    "",
    "The practice formats:",
    ...PRACTICE_FORMATS.map((f) => {
      const spec = PRACTICE_REGISTRY[f];
      const sizing = sizingSentence(f) ?? `${spec.label} is sized by the time given to it.`;
      return `- ${f} (${spec.label}): the learner ${spec.prompt}. ${sizing} ${WRITABLE[spec.generated]}`;
    }),
    "",
    "What to weigh:",
    "- The learner's goal and instructions come first. Where they say what to use, avoid or aim at, that decides.",
    "- Reading and practice both count. Weigh what this learner needs to understand against what they need to be able to do, and give each the time that takes.",
    "- A book followed in order is worth more than scattered pieces on the same ground. A long book is not a reason to drop it; keep the chapters the plan needs.",
    "- A block format needs whole blocks: a few full runs are worth more than many fragments. Give a block format time for whole blocks, or none.",
    "- A format that nothing in the list serves and that can't be written gets no time.",
    "- The learner's own materials stay in the plan. You may choose which part of one it uses, but never drop it.",
    "",
    "How to answer:",
    "- parts: one entry per material, by id. For a material with a chapter list, chapters are the bracketed positions the plan keeps. For other reading, minutes and uses name the part. For a practice source, items is how many of its items the plan works through, and uses says which. Leave a field null to keep that material whole.",
    "- drop: true, with dropReason, for a researched material the plan won't use; say why in a few words. Length alone is not a reason.",
    `- picks: the formats the practice time goes to, at most ${MAX_PRACTICE_PICKS}, each with its share of the practice time (the shares sum to 100), a focus saying what it is aimed at, and a one-sentence reason. Pick none when the plan is all reading.`,
    "- readingShare: your own estimate of the percent of all study time spent reading or watching.",
    "- practice: the practice in two or three words, in the topic's own terms.",
    "- reason: one or two sentences for the learner on how the time is divided.",
  ].join("\n");
}

/** "ch. 5–7, 9": chapter numbers with consecutive runs joined. */
function chapterRange(numbers: number[]): string {
  const runs: [number, number][] = [];
  for (const n of numbers) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return `ch. ${runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")}`;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** The reading part: the kept chapters (sizing the material from them), else the part's minutes and words. */
function readingPart(m: Material, part: AllocationPart): Material {
  const toc = m.toc;
  if (toc && Array.isArray(part.chapters) && part.chapters.length > 0) {
    const positions = [...new Set(part.chapters.filter((n) => Number.isInteger(n) && n >= 1 && n <= toc.chapters.length))].sort((a, b) => a - b);
    // No valid position: the model's chapter set says nothing usable, so the book stays whole.
    if (positions.length === 0) return m;
    const kept: Chapter[] = positions.map((p) => toc.chapters[p - 1]);
    const sized = kept.filter((c) => c.minutes !== null);
    let minutes = m.minutes ?? null;
    if (sized.length > 0) minutes = sized.reduce((sum, c) => sum + c.minutes!, 0);
    else if (finite(part.minutes) && m.minutes) minutes = Math.round(part.minutes);
    if (minutes !== null && m.minutes) minutes = Math.max(1, Math.min(minutes, m.minutes));
    // Positions shift once the list is cut; `end` is the position after the last kept chapter.
    const after = toc.chapters[positions[positions.length - 1]];
    return {
      ...m,
      minutes,
      uses: clip(chapterRange(positions.map((p) => toc.chapters[p - 1].n ?? p)), 120),
      // A list shorter than a chapter list may be is not one; the part stays in `uses` and `minutes`.
      toc: kept.length >= MIN_CHAPTERS ? { ...toc, chapters: kept, end: after ? after.page : toc.end } : null,
    };
  }
  const minutes = finite(part.minutes) && m.minutes ? Math.max(1, Math.min(Math.round(part.minutes), m.minutes)) : m.minutes;
  return { ...m, minutes, uses: clip(part.uses, 120) ?? m.uses ?? null };
}

/** The practice part: `items` of the whole, timed per item; the whole count kept as `totalItems`. Out of range: unchanged. */
function practicePart(p: MaterialPractice | null | undefined, items: number | null): MaterialPractice | null | undefined {
  if (!p || !finite(items)) return p;
  const whole = p.totalItems ?? p.items;
  const n = Math.round(items);
  if (!whole || n < 1 || n > whole) return p;
  const per = p.perItemMinutes ?? PRACTICE_REGISTRY[p.format].perItemMinutes;
  const minutes = per ? n * per : p.minutes && p.items ? Math.round((p.minutes * n) / p.items) : p.minutes;
  return { ...p, items: n, totalItems: whole, minutes: minutes === null ? null : Math.max(1, Math.min(60000, minutes)) };
}

function hoursOf(minutes: number): number {
  return Math.round(minutes / 6) / 10;
}

export interface Allocation {
  split: PlanSplit;
  materials: Material[];
  dropped: DroppedMaterial[];
  facts: string[];
}

/**
 * The model's allocation made valid, with no judgement of its own: each material cut to its part (the learner's own
 * never dropped), the reading share worked out from the kept reading, and the picks kept only where something serves
 * them or they can be written, reshared to 100. The model's own reading share is only a fact. When the split is
 * unusable the materials stay as research sized them and the plan is all reading.
 */
export function applyAllocation(draft: AllocationDraft, input: AllocationInput): Allocation {
  const totalMinutes = totalHours(input.weeks, input.hoursPerWeek) * 60;
  const known = new Set(input.materials.map((m) => m.id));
  const parts = new Map<string, AllocationPart>();
  for (const part of draft.parts ?? []) {
    const id = typeof part?.id === "string" ? part.id.trim() : "";
    if (known.has(id) && !parts.has(id)) parts.set(id, part);
  }

  const materials: Material[] = [];
  const dropped: DroppedMaterial[] = [];
  const materialFacts: string[] = [];
  for (const m of input.materials) {
    const part = parts.get(m.id);
    if (!part) {
      materials.push(m);
      continue;
    }
    if (part.drop === true) {
      if (m.origin === "learner") {
        materialFacts.push(`${m.id} is the learner's own; kept`);
      } else {
        const reason = clip(part.dropReason, 200) ?? "no reason given";
        dropped.push({ title: m.title, url: m.url, reason: `not used by the plan: ${reason}` });
        materialFacts.push(`dropped ${m.id} "${m.title}": ${reason}`);
        continue;
      }
    }
    const read = readingPart(m, part);
    const practice = practicePart(read.practice, part.items);
    materials.push(practice === read.practice ? read : { ...read, practice });
  }

  const readingMinutes = materials.filter((m) => !isPracticeOnly(m)).reduce((sum, m) => sum + (m.minutes ?? 0), 0);
  const readingShare = Math.min(100, Math.round((readingMinutes / totalMinutes) * 100));

  const picks = normalizePicks(draft.picks);
  const provisional = normalizeSplit({ readingShare, practice: draft.practice, reason: draft.reason, picks });
  if (!provisional) return { split: ALL_READING, materials: input.materials, dropped: [], facts: ["no split returned"] };
  const unassignable = pickSources(provisional, materials)
    .filter((s) => !s.assignable)
    .map((s) => s.pick.format);
  const kept = picks.filter((p) => !unassignable.includes(p.format));
  const split = normalizeSplit({ readingShare, practice: draft.practice, reason: draft.reason, picks: normalizePicks(kept) }) ?? ALL_READING;

  const formats = split.formats ?? [];
  const facts = [
    `model reading ${finite(draft.readingShare) ? `${Math.round(draft.readingShare)}%` : "none"} → ${readingShare}% from the parts`,
    `reading parts ${hoursOf(readingMinutes)} h of ${totalMinutes / 60} h`,
    `split: reading ${split.readingShare}%${formats.length > 0 ? `, ${formats.map((p) => `${p.format} ${p.share}%`).join(", ")}` : ", no picks"}`,
    ...materialFacts,
    ...unassignable.map((f) => `${f} dropped: nothing serves it and it can't be written`),
  ];
  // A per-item format's kept items against its time: a mismatch is a fact for the drafter's checks, not an error.
  const practiceMinutes = totalMinutes - Math.round((totalMinutes * split.readingShare) / 100);
  for (const p of formats) {
    const registryPer = PRACTICE_REGISTRY[p.format].perItemMinutes;
    if (!registryPer) continue;
    const serving = materials.filter((m) => m.practice?.format === p.format && m.practice.items);
    if (serving.length === 0) continue;
    const itemMinutes = serving.reduce((sum, m) => sum + m.practice!.items! * (m.practice!.perItemMinutes ?? registryPer), 0);
    const time = Math.round((practiceMinutes * p.share) / 100);
    if (time > 0 && Math.abs(itemMinutes - time) > time / 4) facts.push(`${p.format}: kept items take ${itemMinutes} min, its time is ${time} min`);
  }
  return { split, materials, dropped, facts };
}

/**
 * Asks the allocate model, after research, which part of each material the plan uses and how the practice time is
 * shared, then applies it in code (`applyAllocation`). A call that fails keeps the materials as research sized them
 * and makes the plan all reading, so the draft goes on; but a refusal on the learner's own key is theirs to hear
 * about, and a request that has gone away stops here.
 */
export async function allocatePlan(
  input: AllocationInput & { model: ResolvedModel; log?: GenerationLogContext; signal?: AbortSignal },
): Promise<{ split: PlanSplit; materials: Material[]; dropped: DroppedMaterial[]; costUsd: number }> {
  try {
    const { object, costUsd } = await loggedGenerateObject(
      {
        model: input.model.id,
        languageModel: typeof input.model.model === "string" ? undefined : input.model.model,
        keyOwner: input.model.keyOwner,
        schema: allocationDraftSchema,
        prompt: buildAllocationPrompt(input),
        label: "Allocate",
        check: (draft) => applyAllocation(draft, input).facts,
        abortSignal: input.signal,
      },
      { ...input.log, caller: "outline" },
    );
    const { split, materials, dropped } = applyAllocation(object, input);
    return { split, materials, dropped, costUsd };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (input.model.keyOwner === "user" && providerError(error)) throw error;
    console.error("[draft] allocation failed; the plan is all reading with the materials as research sized them", error);
    return { split: ALL_READING, materials: input.materials, dropped: [], costUsd: 0 };
  }
}
