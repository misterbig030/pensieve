import { z } from "zod";
import {
  coverRefDraftSchema,
  coverRefSchema,
  materialRefDraftSchema,
  materialRefSchema,
  practiceCoverDraftSchema,
  practiceCoverSchema,
  practiceRefDraftSchema,
  practiceRefSchema,
} from "./material";
import { PRACTICE_FORMATS, type PracticeFormat } from "@/lib/practice";

export const PLAN_LEVELS = ["month", "week", "day"] as const;
export const planLevelSchema = z.enum(PLAN_LEVELS);
export const granularityChoiceSchema = z.enum(["day", "week", "auto"]);
export const granularitySchema = z.enum(["day", "week"]);

/** The most minutes a saved unit gives one activity (`unitTimeSchema`); what the model writes past it is clamped. */
export const MAX_UNIT_MINUTES = 30000;
/** Minutes the outline gave one heading unit per activity: reading, and each practice format. */
export const unitTimeSchema = z.object({
  reading: z.number().int().min(0).max(MAX_UNIT_MINUTES),
  practice: z.partialRecord(z.enum(PRACTICE_FORMATS), z.number().int().min(0).max(MAX_UNIT_MINUTES)),
});
export type UnitTime = { reading: number; practice: Partial<Record<PracticeFormat, number>> };
/** The same as the model writes it: practice as an array, for a plainer JSON schema. */
export const unitTimeDraftSchema = z.object({
  reading: z.number().int().min(0),
  practice: z.array(z.object({ format: z.enum(PRACTICE_FORMATS), minutes: z.number().int().min(0) })),
});
/** The most problem lines a node or track keeps, and the most characters in one. */
export const MAX_PROBLEMS = 40;
export const MAX_PROBLEM_CHARS = 500;
/** Learner-facing lines for code-checked problems, saved on the node whose level they belong to. */
export const problemsSchema = z.array(z.string().min(1).max(MAX_PROBLEM_CHARS)).max(MAX_PROBLEMS);

/**
 * Problem lines as they are kept, within `problemsSchema`: a line past the limit is shortened, its ellipsis inside it,
 * and past the most lines the first ones stay with a last line saying how many more there were. Every writer of
 * `problems` goes through it, so a long list never fails a save or a later request.
 */
export function capProblems(lines: readonly string[]): string[] {
  const fit = (line: string) => (line.length > MAX_PROBLEM_CHARS ? `${line.slice(0, MAX_PROBLEM_CHARS - 1)}…` : line);
  if (lines.length <= MAX_PROBLEMS) return lines.map(fit);
  const kept = lines.slice(0, MAX_PROBLEMS - 1).map(fit);
  return [...kept, `…and ${lines.length - kept.length} more.`];
}

/**
 * What the model writes for one unit whose span the server already decided. Headings reserve materials (`covers`) and
 * practice sources (`practiceCovers`) and say how they spend their hours (`time`); leaves assign them (`materials`,
 * `practice`). Each is left out when the plan has nothing for it.
 */
export const unitDraftSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  covers: z.array(coverRefDraftSchema).optional().describe("Headings only: materials this unit reserves, by id"),
  materials: z.array(materialRefDraftSchema).optional().describe("Leaves only: this unit's Read table"),
  practiceCovers: z.array(practiceCoverDraftSchema).optional().describe("Headings only: practice sources this unit reserves, by id"),
  practice: z.array(practiceRefDraftSchema).optional().describe("Leaves only: this unit's practice rows"),
  time: unitTimeDraftSchema.optional().describe("Headings only: this unit's minutes of must-reading and of each practice format"),
});
/** The most units one level call may return. */
export const MAX_LEVEL_UNITS = 40;
/**
 * One level call's answer. The cap on units is checked here, not sent: Gemini refuses the outline's JSON schema
 * ("Request contains an invalid argument") once its top-level list carries `maxItems`, so the cap is a refinement,
 * which the schema sent to the model leaves out.
 */
export const unitListSchema = z.object({
  units: z
    .array(unitDraftSchema)
    .min(1)
    .refine((units) => units.length <= MAX_LEVEL_UNITS, { message: `At most ${MAX_LEVEL_UNITS} units` }),
});
export type UnitDraft = z.infer<typeof unitDraftSchema>;

/** The deepest a revised tree nests: month → week → day. */
const MAX_REVISED_DEPTH = 3;

/**
 * One unit of a revised tree as the model writes it: the tree is one flat list in outline order, each unit followed by
 * the units inside it, and `depth` places it. `ref` echoes the node's ref from the prompt when a node is kept; `time` is
 * a heading's minutes per activity, written when the model changes them or adds the heading.
 */
const revisedUnitSchema = z.object({
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_REVISED_DEPTH)
    .describe("1 for a top-level unit; 2 for a unit inside the nearest depth-1 unit above it; 3 for a unit inside the nearest depth-2 unit above it"),
  ref: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  days: z.number().int().min(1),
  covers: z.array(coverRefDraftSchema).optional(),
  materials: z.array(materialRefDraftSchema).optional(),
  practiceCovers: z.array(practiceCoverDraftSchema).optional(),
  practice: z.array(practiceRefDraftSchema).optional(),
  time: unitTimeDraftSchema.optional(),
});
type RevisedUnitDraft = z.infer<typeof revisedUnitSchema>;

/** A unit of the revised tree once nested: what `applyRevision` reads. A unit with nothing inside it has no `children`. */
export interface RevisedNode extends Omit<RevisedUnitDraft, "depth"> {
  children?: RevisedNode[];
}
export interface RevisedTree {
  units: RevisedNode[];
}

/**
 * The outline's units under their parents. A unit deeper than one level below the unit before it (a skipped level, or
 * a first unit below the top) goes just inside that unit, or at the top.
 */
function nestRevisedUnits(flat: RevisedUnitDraft[]): { tops: RevisedNode[]; widest: number } {
  const tops: RevisedNode[] = [];
  /** The open unit at each depth: `open[0]` the latest top-level unit. */
  const open: RevisedNode[] = [];
  let widest = 0;
  for (const { depth, ...fields } of flat) {
    const node: RevisedNode = fields;
    const d = Math.min(Math.max(1, depth), open.length + 1, MAX_REVISED_DEPTH);
    open.length = d - 1;
    const siblings = d === 1 ? tops : (open[d - 2].children ??= []);
    siblings.push(node);
    widest = Math.max(widest, siblings.length);
    open.push(node);
  }
  return { tops, widest };
}

/**
 * The revised tree the model returns from a change request. The model writes it flat (`revisedUnitSchema`) and the
 * transform nests it. A nested month → week → day schema repeats every optional field once per level (38), and
 * Anthropic's strict output, which a user's own key goes through, refuses more than 24 optional parameters. Each level
 * takes at most `MAX_LEVEL_UNITS` units, checked here rather than sent.
 */
export const revisedTreeSchema = z
  .object({ units: z.array(revisedUnitSchema).min(1) })
  .transform(({ units }, ctx): RevisedTree => {
    const { tops, widest } = nestRevisedUnits(units);
    if (widest > MAX_LEVEL_UNITS) {
      ctx.addIssue({ code: "custom", message: `At most ${MAX_LEVEL_UNITS} units at one level` });
      return z.NEVER;
    }
    return { units: tops };
  });

/** A node as the browser sends it back on confirm. Ids are temporary (`tmp-…`) or real uuids in adjust mode. */
const nodeInputBase = z.object({
  id: z.string().min(1),
  level: planLevelSchema,
  title: z.string().min(1).max(300),
  summary: z.string().min(1).max(2000),
  len: z.number().int().min(1).max(365),
  status: z.enum(["pending", "generated", "completed"]).optional(),
  budgetHours: z.number().int().min(1).max(500).nullable().optional(),
  manualSplit: z.boolean().optional(),
  covers: z.array(coverRefSchema).max(40).optional(),
  materials: z.array(materialRefSchema).max(40).optional(),
  practice: z.array(practiceRefSchema).max(40).optional(),
  practiceCovers: z.array(practiceCoverSchema).max(40).optional(),
  time: unitTimeSchema.optional(),
  problems: problemsSchema.optional(),
});
const leafInputSchema = nodeInputBase.extend({ children: z.null().optional() });
const midInputSchema = nodeInputBase.extend({ children: z.array(leafInputSchema).max(60).nullable().optional() });
const topInputSchema = nodeInputBase.extend({ children: z.array(midInputSchema).max(60).nullable().optional() });
export const planTreeInputSchema = z.array(topInputSchema).min(1).max(60);
export type PlanTreeInput = z.infer<typeof planTreeInputSchema>;
export type PlanNodeInput = PlanTreeInput[number];
