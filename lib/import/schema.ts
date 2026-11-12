import { z } from "zod";
import { PRACTICE_FORMATS } from "@/lib/practice";
import { MATERIAL_KINDS } from "@/lib/schemas/material";

/**
 * What the import model writes for a plan file: either `no_plan` with a reason, or the file's plan copied as it stands.
 * Loose on purpose, as the other draft schemas are: kinds and formats are free strings and numbers are not bounded, so
 * one odd value never fails the whole file; `convertDraft` maps and bounds them. Array caps are refinements, which the
 * JSON schema sent to the model leaves out (Gemini refuses a schema whose lists carry `maxItems`); they are generous,
 * so a runaway answer fails and a long plan reaches `convertDraft`, which refuses it with its own message.
 *
 * One object with a `kind` and nullable plan fields rather than a union: some providers' structured output takes only
 * an object at the root. Units nest three levels at most (month, week, day) so the schema stays plain JSON with no
 * recursion. The transform turns the answer into `ImportDraft`.
 */

export interface ImportMaterialDraft {
  id: string;
  title: string;
  author: string | null;
  kind: string;
  practiceFormat: string | null;
  /** The file's labels for the source's numbered items, e.g. "703". */
  items: string[] | null;
}

export interface ImportReadingDraft {
  id: string;
  part: string | null;
  minutes: number | null;
}

export interface ImportPracticeDraft {
  format: string;
  id: string | null;
  items: string[] | null;
  task: string;
  done: string;
  minutes: number | null;
}

export interface ImportUnitDraft {
  title: string;
  summary: string;
  budgetHours: number | null;
  reading: ImportReadingDraft[];
  practice: ImportPracticeDraft[];
  children: ImportUnitDraft[] | null;
}

export type ImportLevel = "month" | "week" | "day";

export type ImportDraft =
  | { kind: "no_plan"; reason: string }
  | {
      kind: "plan";
      title: string;
      hoursPerWeek: number | null;
      daysPerWeek: number | null;
      /** The file's top level. */
      level: ImportLevel;
      /** Ids "M1", "M2"… */
      materials: ImportMaterialDraft[];
      /** Top level, in file order; children only when the file writes them. */
      units: ImportUnitDraft[];
      /** Headings kept as context (Target, Rules…). */
      kept: string[];
      skipped: { heading: string; reason: string }[];
    };

/** Bounds on what one answer may hold: well past any plan the import accepts. */
const MAX_UNITS = 200;
const MAX_CHILDREN = 60;
const MAX_ROWS = 100;
const MAX_MATERIALS = 200;
const MAX_ITEMS = 500;
const MAX_NOTES = 50;

function capped<T extends z.ZodTypeAny>(item: T, max: number, what: string) {
  return z.array(item).refine((list) => list.length <= max, { message: `At most ${max} ${what}` });
}

const itemLabels = capped(z.string(), MAX_ITEMS, "items");

const materialDraftSchema = z.object({
  id: z.string().describe('A short id for this material: "M1", "M2"…, in the order the file first names them'),
  title: z.string().describe("The material's title as the file names it, made specific enough to tell it apart (\"System Design Interview, vol. 1\")"),
  author: z.string().nullable().describe("The author when the file names one, else null"),
  kind: z.string().describe(`One of: ${MATERIAL_KINDS.join(", ")}. "other" when none fits`),
  practiceFormat: z
    .string()
    .nullable()
    .describe(`For a source the learner practises from (a problem site, a question bank), its format, one of: ${PRACTICE_FORMATS.join(", ")}; null for something only read or watched`),
  items: itemLabels.nullable().describe('For a practice source whose items the file numbers, every label the plan uses, in the order the file first gives them ("703", "1046"); else null'),
});

const readingDraftSchema = z.object({
  id: z.string().describe("The id of the material this unit reads, from `materials`"),
  part: z.string().nullable().describe('The part this unit reads, as the file names it ("Ch. 1–3"); null for the whole work'),
  minutes: z.number().nullable().describe("Minutes the file gives this reading; null when it gives none"),
});

const practiceDraftSchema = z.object({
  format: z.string().describe(`One of: ${PRACTICE_FORMATS.join(", ")}. "other" when none fits`),
  id: z.string().nullable().describe("The id of the practice source on `materials` this row uses; null for a task with no source"),
  items: itemLabels.nullable().describe("The source's items this row names, by the file's labels, in the file's order; null when it names none"),
  task: z.string().describe("The task in the file's words"),
  done: z.string().describe("How the learner knows it is finished, from the file when it says"),
  minutes: z.number().nullable().describe("Minutes the file gives this task; null when it gives none"),
});

const unitFields = {
  title: z.string().describe('The unit\'s title as the file writes it, without the "Week 3 ·" numbering the app adds itself'),
  summary: z.string().describe("One or two sentences on what the unit does, plus its exit or done-when line when the file gives one"),
  budgetHours: z.number().nullable().describe("The unit's hours when the file gives them (the sum of its lines' hours); null otherwise"),
  reading: capped(readingDraftSchema, MAX_ROWS, "readings").describe("What this unit reads or watches; empty when nothing"),
  practice: capped(practiceDraftSchema, MAX_ROWS, "practice rows").describe("Everything else this unit does; empty when nothing"),
};

const dayDraftSchema = z.object(unitFields);
const midDraftSchema = z.object({
  ...unitFields,
  children: capped(dayDraftSchema, MAX_CHILDREN, "children").nullish().describe("The days inside this week, only when the file writes them; else null"),
});
const topDraftSchema = z.object({
  ...unitFields,
  children: capped(midDraftSchema, MAX_CHILDREN, "children").nullish().describe("The units one level down, only when the file writes them; else null"),
});

const answerSchema = z.object({
  kind: z.enum(["plan", "no_plan"]).describe('"plan" when the file holds a plan with a timeline; "no_plan" otherwise'),
  reason: z.string().nullish().describe('no_plan only: one line on why this is not a plan ("a reading list with no timeline")'),
  title: z.string().nullish().describe("plan only: the plan's title, from the file"),
  hoursPerWeek: z.number().nullish().describe("plan only: study hours a week when the file states them; else null"),
  daysPerWeek: z.number().nullish().describe("plan only: study days a week when the file states them; else null"),
  level: z.enum(["month", "week", "day"]).nullish().describe("plan only: the file's own top level"),
  materials: capped(materialDraftSchema, MAX_MATERIALS, "materials").nullish().describe("plan only: every book, course, site or other source the plan names, each once"),
  units: capped(topDraftSchema, MAX_UNITS, "units").nullish().describe("plan only: the top-level units, in file order"),
  kept: capped(z.string(), MAX_NOTES, "kept headings").nullish().describe("plan only: headings of plan-wide sections kept as context (target, rules, phases)"),
  skipped: capped(
    z.object({
      heading: z.string().describe("The section's heading"),
      reason: z.string().describe("One line on why it could not be placed"),
    }),
    MAX_NOTES,
    "skipped sections",
  )
    .nullish()
    .describe("plan only: sections that belong to no single unit and are not plan-wide"),
});

type AnswerUnit = z.infer<typeof dayDraftSchema> & { children?: AnswerUnit[] | null };

function toUnit(unit: AnswerUnit): ImportUnitDraft {
  return {
    title: unit.title,
    summary: unit.summary,
    budgetHours: unit.budgetHours,
    reading: unit.reading,
    practice: unit.practice,
    children: unit.children ? unit.children.map(toUnit) : null,
  };
}

export const importDraftSchema: z.ZodType<ImportDraft> = answerSchema.transform((answer): ImportDraft => {
  if (answer.kind === "no_plan") return { kind: "no_plan", reason: answer.reason?.trim() ?? "" };
  return {
    kind: "plan",
    title: answer.title ?? "",
    hoursPerWeek: answer.hoursPerWeek ?? null,
    daysPerWeek: answer.daysPerWeek ?? null,
    level: answer.level ?? "week",
    materials: answer.materials ?? [],
    units: (answer.units ?? []).map(toUnit),
    kept: answer.kept ?? [],
    skipped: answer.skipped ?? [],
  };
});
