import { z } from "zod";
import type { PlanSplit } from "@/lib/studyTime";

/**
 * The practice formats a plan can assign in place of "left for practice" time: one registry that the picking step,
 * research, drafting and the lesson all read from. Pure and client-safe. `lib/studyTime.ts` imports the pick schemas
 * from here, so this file must not import it at runtime.
 */

export const PRACTICE_FORMATS = ["problem-set", "recall", "design-exercise", "lab", "project", "mock", "session"] as const;
export type PracticeFormat = (typeof PRACTICE_FORMATS)[number];

/** Most formats a split can pick. */
export const MAX_PRACTICE_PICKS = 4;

/** When a row of this format may be written by the model rather than found in a source. */
export type PracticeGenerated = "never" | "from-reading" | "with-rubric" | "milestones" | "interview-only" | "from-programme";

export interface PracticeFormatSpec {
  id: PracticeFormat;
  /** What the learner sees on the row and the split card. */
  label: string;
  /** The line the prompts use to say what the learner does. */
  prompt: string;
  /** How the learner knows a row is finished. */
  doneWhen: string;
  /** Minutes per problem, question or step, or null when the format is not sized by a count. */
  perItemMinutes: number | null;
  /** Minutes for one whole row, or null when the format is not a fixed block. */
  fixedMinutes: number | null;
  /** What research looks for. */
  research: string;
  generated: PracticeGenerated;
  /** Whether a row needs an answer key, worked solution or rubric to check against. */
  needsAnswers: boolean;
}

export const PRACTICE_REGISTRY: Record<PracticeFormat, PracticeFormatSpec> = {
  "problem-set": {
    id: "problem-set",
    label: "Problems",
    prompt: "solves many small problems, each with an answer to check against",
    doneWhen: "solved and checked against the solution",
    perItemMinutes: 10,
    fixedMinutes: null,
    research:
      "curated problem lists with solutions (NeetCode, LeetCode lists, DataLemur, Rustlings, Exercism, a book's practice problems)",
    generated: "never",
    needsAnswers: true,
  },
  recall: {
    id: "recall",
    label: "Recall",
    prompt: "answers questions or flashcards from memory, aloud or written",
    doneWhen: "checked against the answers or the reading",
    perItemMinutes: 3,
    fixedMinutes: null,
    research: "question banks with answers, official revision questions",
    generated: "from-reading",
    needsAnswers: true,
  },
  "design-exercise": {
    id: "design-exercise",
    label: "Design",
    prompt: "takes one open prompt, timed, then compares the result with a worked solution",
    doneWhen: "compared with a worked solution or rubric",
    perItemMinutes: null,
    fixedMinutes: 50,
    research: "design question sets with worked solutions, worked designs in the materials",
    generated: "with-rubric",
    needsAnswers: true,
  },
  lab: {
    id: "lab",
    label: "Lab",
    prompt: "follows guided steps in a real tool",
    doneWhen: "the source's own check passes",
    perItemMinutes: 5,
    fixedMinutes: null,
    research: "interactive tutorials, course labs (Learn Git Branching, vimtutor, CS:APP labs)",
    generated: "never",
    needsAnswers: false,
  },
  project: {
    id: "project",
    label: "Project",
    prompt: "builds one thing across units, one milestone per unit",
    doneWhen: "the milestone runs or exists",
    perItemMinutes: null,
    fixedMinutes: null,
    research: "a course's project, else none",
    generated: "milestones",
    needsAnswers: false,
  },
  mock: {
    id: "mock",
    label: "Mock",
    prompt: "does a full run under real conditions, then reviews it",
    doneWhen: "scored, or recorded and reviewed",
    perItemMinutes: null,
    // A 60-minute round plus 15 minutes of review.
    fixedMinutes: 75,
    research: "official mock tests, mock-interview formats",
    generated: "interview-only",
    needsAnswers: true,
  },
  session: {
    id: "session",
    label: "Session",
    prompt: "repeats a routine with one thing to notice",
    doneWhen: "done and logged",
    perItemMinutes: null,
    fixedMinutes: null,
    research: "training programmes, technique exercises, recipes",
    generated: "from-programme",
    needsAnswers: false,
  },
};

/** One practice format the plan's split picked, with its share of the practice time and what it is aimed at. */
export const practicePickSchema = z.object({
  format: z.enum(PRACTICE_FORMATS),
  share: z.number().int().min(1).max(100),
  focus: z.string().trim().min(1).max(160),
  reason: z.string().trim().max(300),
});
export type PracticePick = z.infer<typeof practicePickSchema>;

/** What the model writes: looser, so an odd share or a long line never fails the whole level. */
export const practicePickDraftSchema = z.object({
  format: z.string().describe(`One of: ${PRACTICE_FORMATS.join(", ")}`),
  share: z.number().describe("Percent of the practice time this format gets"),
  focus: z.string().describe("What this practice is aimed at, in a few words"),
  reason: z.string().describe("One sentence: why this format suits this topic"),
});
export type PracticePickDraft = z.infer<typeof practicePickDraftSchema>;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The model's picks made valid: known formats only, each once, at most four, shares scaled to sum to exactly 100.
 * A pick with no positive share or no focus is dropped. Rounding error lands on the largest share.
 */
export function normalizePicks(drafts: PracticePickDraft[] | null | undefined): PracticePick[] {
  const seen = new Set<string>();
  const kept: { format: PracticeFormat; share: number; focus: string; reason: string }[] = [];
  for (const d of drafts ?? []) {
    const format = typeof d?.format === "string" ? d.format.trim().toLowerCase() : "";
    if (!(PRACTICE_FORMATS as readonly string[]).includes(format) || seen.has(format)) continue;
    if (typeof d.share !== "number" || !Number.isFinite(d.share) || d.share <= 0) continue;
    const focus = (d.focus ?? "").trim();
    if (!focus) continue;
    seen.add(format);
    kept.push({ format: format as PracticeFormat, share: d.share, focus: clip(focus, 160), reason: clip((d.reason ?? "").trim(), 300) });
    if (kept.length === MAX_PRACTICE_PICKS) break;
  }
  if (kept.length === 0) return [];

  const total = kept.reduce((sum, p) => sum + p.share, 0);
  const picks = kept.map((p) => ({ ...p, share: Math.max(1, Math.round((p.share / total) * 100)) }));
  const largest = picks.reduce((best, p) => (p.share > best.share ? p : best), picks[0]);
  largest.share += 100 - picks.reduce((sum, p) => sum + p.share, 0);
  return picks;
}

/**
 * The split's picks with their hours: each pick's share of the practice hours (the total less the rounded reading
 * hours), rounded, with the rounding difference on the largest pick so the hours sum exactly. Empty without picks.
 */
export function formatHours(split: PlanSplit, totalHours: number): { format: PracticeFormat; label: string; hours: number; focus: string }[] {
  const picks = split.formats ?? [];
  if (picks.length === 0) return [];
  const practiceHours = totalHours - Math.round((totalHours * split.readingShare) / 100);
  const rows = picks.map((p) => ({ format: p.format, label: PRACTICE_REGISTRY[p.format].label, hours: Math.round((practiceHours * p.share) / 100), focus: p.focus }));
  const largest = picks.reduce((best, p, i) => (p.share > picks[best].share ? i : best), 0);
  rows[largest].hours += practiceHours - rows.reduce((sum, r) => sum + r.hours, 0);
  return rows;
}
