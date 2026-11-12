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
 * One object with a `kind` and every field required rather than a union: some providers' structured output takes only
 * an object at the root, and Anthropic refuses a schema with more than 16 nullable or union-typed parameters (it
 * counts each copy of a nested unit). So no field is nullable: "nothing" is a sentinel the descriptions name, `""` for
 * no text, `0` for no number and `[]` for no list, and the transform turns them back into the `null`s of `ImportDraft`.
 * Units nest three levels at most (month, week, day) so the schema stays plain JSON with no recursion.
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
  author: z.string().describe('The author when the file names one; "" when it names none'),
  kind: z.string().describe(`One of: ${MATERIAL_KINDS.join(", ")}. "other" when none fits`),
  practiceFormat: z
    .string()
    .describe(`For a source the learner practises from (a problem site, a question bank), its format, one of: ${PRACTICE_FORMATS.join(", ")}; "" for something only read or watched`),
  items: itemLabels.describe('For a practice source whose items the file numbers, every label the plan uses, in the order the file first gives them ("703", "1046"); [] otherwise'),
});

const readingDraftSchema = z.object({
  id: z.string().describe("The id of the material this unit reads, from `materials`"),
  part: z.string().describe('The part this unit reads, as the file names it ("Ch. 1–3"); "" for the whole work'),
  minutes: z.number().describe("Minutes the file gives this reading; 0 when the file gives no time"),
});

const practiceDraftSchema = z.object({
  format: z.string().describe(`One of: ${PRACTICE_FORMATS.join(", ")}. "other" when none fits`),
  id: z.string().describe('The id of the practice source on `materials` this row uses; "" for a task with no source'),
  items: itemLabels.describe("The source's items this row names, by the file's labels, in the file's order; [] when it names none"),
  task: z.string().describe("The task in the file's words"),
  done: z.string().describe("How the learner knows it is finished, from the file when it says"),
  minutes: z.number().describe("Minutes the file gives this task; 0 when the file gives no time"),
});

const unitFields = {
  title: z.string().describe('The unit\'s title as the file writes it, without the "Week 3 ·" numbering the app adds itself'),
  summary: z.string().describe("One or two sentences on what the unit does, plus its exit or done-when line when the file gives one"),
  budgetHours: z.number().describe("The unit's hours when the file gives them (the sum of its lines' hours); 0 when the file gives none"),
  reading: capped(readingDraftSchema, MAX_ROWS, "readings").describe("What this unit reads or watches; [] when nothing"),
  practice: capped(practiceDraftSchema, MAX_ROWS, "practice rows").describe("Everything else this unit does; [] when nothing"),
};

const dayDraftSchema = z.object(unitFields);
const midDraftSchema = z.object({
  ...unitFields,
  children: capped(dayDraftSchema, MAX_CHILDREN, "children").describe("The days inside this week, only when the file writes them; [] otherwise"),
});
const topDraftSchema = z.object({
  ...unitFields,
  children: capped(midDraftSchema, MAX_CHILDREN, "children").describe("The units one level down, only when the file writes them; [] otherwise"),
});

const answerSchema = z.object({
  kind: z.enum(["plan", "no_plan"]).describe('"plan" when the file holds a plan with a timeline; "no_plan" otherwise'),
  reason: z.string().describe('For no_plan, one line on why this is not a plan ("a reading list with no timeline"); "" for a plan'),
  title: z.string().describe('The plan\'s title, from the file; "" for no_plan'),
  hoursPerWeek: z.number().describe("Study hours a week when the file states them; 0 when it does not, or for no_plan"),
  daysPerWeek: z.number().describe("Study days a week when the file states them; 0 when it does not, or for no_plan"),
  level: z.enum(["month", "week", "day"]).describe('The file\'s own top level; "week" for no_plan'),
  materials: capped(materialDraftSchema, MAX_MATERIALS, "materials").describe("Every book, course, site or other source the plan names, each once; [] for no_plan"),
  units: capped(topDraftSchema, MAX_UNITS, "units").describe("The top-level units, in file order; [] for no_plan"),
  kept: capped(z.string(), MAX_NOTES, "kept headings").describe("Headings of plan-wide sections kept as context (target, rules, phases); [] for no_plan"),
  skipped: capped(
    z.object({
      heading: z.string().describe("The section's heading"),
      reason: z.string().describe("One line on why it could not be placed"),
    }),
    MAX_NOTES,
    "skipped sections",
  ).describe("Sections that belong to no single unit and are not plan-wide; [] when none, or for no_plan"),
});

type AnswerUnit = z.infer<typeof dayDraftSchema> & { children?: AnswerUnit[] };

/** The sentinels back to null: "" for text, 0 (or less) for a number, [] for a list. */
function text(value: string): string | null {
  return value.trim() ? value : null;
}
function amount(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}
function list<T>(value: T[]): T[] | null {
  return value.length > 0 ? value : null;
}

function toUnit(unit: AnswerUnit): ImportUnitDraft {
  return {
    title: unit.title,
    summary: unit.summary,
    budgetHours: amount(unit.budgetHours),
    reading: unit.reading.map((r) => ({ id: r.id, part: text(r.part), minutes: amount(r.minutes) })),
    practice: unit.practice.map((p) => ({ format: p.format, id: text(p.id), items: list(p.items), task: p.task, done: p.done, minutes: amount(p.minutes) })),
    children: unit.children && unit.children.length > 0 ? unit.children.map(toUnit) : null,
  };
}

export const importDraftSchema: z.ZodType<ImportDraft> = answerSchema.transform((answer): ImportDraft => {
  if (answer.kind === "no_plan") return { kind: "no_plan", reason: answer.reason.trim() };
  return {
    kind: "plan",
    title: answer.title,
    hoursPerWeek: amount(answer.hoursPerWeek),
    daysPerWeek: amount(answer.daysPerWeek),
    level: answer.level,
    materials: answer.materials.map((m) => ({
      id: m.id,
      title: m.title,
      author: text(m.author),
      kind: m.kind,
      practiceFormat: text(m.practiceFormat),
      items: list(m.items),
    })),
    units: answer.units.map(toUnit),
    kept: answer.kept,
    skipped: answer.skipped,
  };
});
