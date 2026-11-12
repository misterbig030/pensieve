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
 * an object at the root, and Anthropic refuses a schema with more than 16 nullable or union-typed parameters. So no
 * field is nullable: "nothing" is a sentinel the descriptions name, `""` for no text, `0` for no number and `[]` for
 * no list, and the transform turns them back into the `null`s of `ImportDraft`.
 *
 * Units are one flat list, each with its `level` and the index of its `parent`, because Anthropic refuses the grammar a
 * nested unit tree compiles to as too large. The transform rebuilds the tree.
 */

export interface ImportMaterialDraft {
  id: string;
  title: string;
  author: string | null;
  kind: string;
  practiceFormat: string | null;
  /** The file's labels for the source's numbered items, e.g. "703". The model does not write them (rows name their items); null from `importDraftSchema`. */
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
const MAX_UNITS = 400;
const MAX_ROWS = 100;
const MAX_MATERIALS = 200;
const MAX_ITEMS = 500;
const MAX_NOTES = 50;

function capped<T extends z.ZodTypeAny>(item: T, max: number, what: string) {
  return z.array(item).refine((list) => list.length <= max, { message: `At most ${max} ${what}` });
}

const LEVELS = ["month", "week", "day"] as const;

const materialDraftSchema = z.object({
  id: z.string().describe('"M1", "M2"…, in the order the file first names them'),
  title: z.string().describe("As the file names it, specific enough to tell entries apart"),
  author: z.string().describe('"" when the file names none'),
  kind: z.string().describe(`One of: ${MATERIAL_KINDS.join(", ")}`),
  practiceFormat: z.string().describe('For a source the learner practises from, its practice format; "" otherwise'),
});

const readingDraftSchema = z.object({
  id: z.string().describe("The material's id"),
  part: z.string().describe('The part, as the file names it ("Ch. 1–3"); "" for the whole work'),
  minutes: z.number().describe("0 when the file gives no time"),
});

const practiceDraftSchema = z.object({
  format: z.string().describe(`One of: ${PRACTICE_FORMATS.join(", ")}`),
  id: z.string().describe('The practice source\'s material id; "" for a task with no source'),
  items: capped(z.string(), MAX_ITEMS, "items").describe('The source\'s items this row names, by the file\'s labels ("703"); [] when none'),
  task: z.string().describe("The task in the file's words"),
  done: z.string().describe("How the learner knows it is finished"),
  minutes: z.number().describe("0 when the file gives no time"),
});

const unitDraftSchema = z.object({
  level: z.enum(LEVELS),
  parent: z.number().describe("The index in `units` of the unit this one sits inside; -1 for a top-level unit"),
  title: z.string().describe('As the file writes it, without the "Week 3 ·" numbering'),
  summary: z.string().describe("What the unit does, ending with its exit line when the file gives one"),
  budgetHours: z.number().describe("The unit's hours from the file; 0 when it gives none"),
  reading: capped(readingDraftSchema, MAX_ROWS, "readings"),
  practice: capped(practiceDraftSchema, MAX_ROWS, "practice rows"),
});

const answerSchema = z.object({
  kind: z.enum(["plan", "no_plan"]),
  reason: z.string().describe('no_plan: one line on why this is not a plan; "" for a plan'),
  title: z.string().describe('The plan\'s title; "" for no_plan'),
  hoursPerWeek: z.number().describe("0 when the file does not state them"),
  daysPerWeek: z.number().describe("0 when the file does not state them"),
  materials: capped(materialDraftSchema, MAX_MATERIALS, "materials"),
  units: capped(unitDraftSchema, MAX_UNITS, "units").describe("Every unit in file order, each parent before its children"),
  kept: capped(z.string(), MAX_NOTES, "kept headings").describe("Headings of plan-wide sections"),
  skipped: capped(z.object({ heading: z.string(), reason: z.string() }), MAX_NOTES, "skipped sections").describe(
    "Sections that belong to no single unit and are not plan-wide",
  ),
});

type AnswerUnit = z.infer<typeof unitDraftSchema>;

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

/**
 * The flat units back into a tree. A unit whose parent is not an earlier unit, is a day, or is already two levels
 * down (the tree is month, week, day at most) goes to the top level, and the move is listed with the skipped sections.
 */
function toTree(units: AnswerUnit[], skipped: { heading: string; reason: string }[]): ImportUnitDraft[] {
  const nodes: { draft: ImportUnitDraft; kids: ImportUnitDraft[]; depth: number; level: ImportLevel }[] = [];
  const tops: ImportUnitDraft[] = [];
  units.forEach((u, i) => {
    const draft: ImportUnitDraft = {
      title: u.title,
      summary: u.summary,
      budgetHours: amount(u.budgetHours),
      reading: u.reading.map((r) => ({ id: r.id, part: text(r.part), minutes: amount(r.minutes) })),
      practice: u.practice.map((p) => ({ format: p.format, id: text(p.id), items: list(p.items), task: p.task, done: p.done, minutes: amount(p.minutes) })),
      children: null,
    };
    const node = { draft, kids: [] as ImportUnitDraft[], depth: 0, level: u.level };
    nodes.push(node);
    const p = u.parent;
    if (p === -1) {
      tops.push(draft);
      return;
    }
    const parent = Number.isInteger(p) && p >= 0 && p < i ? nodes[p] : null;
    const problem = !parent
      ? `Its parent (${p}) is not an earlier unit`
      : parent.level === "day"
        ? "It sits inside a day, which holds no units"
        : parent.depth >= 2
          ? "It sits deeper than month, week and day"
          : null;
    if (problem || !parent) {
      skipped.push({ heading: u.title.trim() || `Unit ${i + 1}`, reason: `${problem}, so it was imported at the top level.` });
      tops.push(draft);
      return;
    }
    node.depth = parent.depth + 1;
    parent.kids.push(draft);
  });
  for (const node of nodes) node.draft.children = list(node.kids);
  return tops;
}

export const importDraftSchema: z.ZodType<ImportDraft> = answerSchema.transform((answer): ImportDraft => {
  if (answer.kind === "no_plan") return { kind: "no_plan", reason: answer.reason.trim() };
  const skipped = [...answer.skipped];
  const units = toTree(answer.units, skipped);
  const firstTop = answer.units.find((u) => u.parent === -1);
  return {
    kind: "plan",
    title: answer.title,
    hoursPerWeek: amount(answer.hoursPerWeek),
    daysPerWeek: amount(answer.daysPerWeek),
    level: firstTop?.level ?? answer.units[0]?.level ?? "week",
    materials: answer.materials.map((m) => ({
      id: m.id,
      title: m.title,
      author: text(m.author),
      kind: m.kind,
      practiceFormat: text(m.practiceFormat),
      items: null,
    })),
    units,
    kept: answer.kept,
    skipped,
  };
});
