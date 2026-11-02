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

/** Minutes the outline gave one heading unit per activity: reading, and each practice format. */
export const unitTimeSchema = z.object({
  reading: z.number().int().min(0).max(30000),
  practice: z.partialRecord(z.enum(PRACTICE_FORMATS), z.number().int().min(0).max(30000)),
});
export type UnitTime = { reading: number; practice: Partial<Record<PracticeFormat, number>> };
/** The same as the model writes it: practice as an array, for a plainer JSON schema. */
export const unitTimeDraftSchema = z.object({
  reading: z.number().int().min(0),
  practice: z.array(z.object({ format: z.enum(PRACTICE_FORMATS), minutes: z.number().int().min(0) })),
});
/** Learner-facing lines for code-checked problems, saved on the node whose level they belong to. */
export const problemsSchema = z.array(z.string().min(1).max(500)).max(40);

/**
 * What the model writes for one unit whose span the server already decided. Headings reserve materials (`covers`) and
 * practice sources (`practiceCovers`); leaves assign them (`materials`, `practice`). Each is left out when the plan has
 * nothing for it.
 */
export const unitDraftSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  covers: z.array(coverRefDraftSchema).optional().describe("Headings only: materials this unit reserves, by id"),
  materials: z.array(materialRefDraftSchema).optional().describe("Leaves only: this unit's Read table"),
  practiceCovers: z.array(practiceCoverDraftSchema).optional().describe("Headings only: practice sources this unit reserves, by id"),
  practice: z.array(practiceRefDraftSchema).optional().describe("Leaves only: this unit's practice rows"),
});
export const unitListSchema = z.object({
  units: z.array(unitDraftSchema).min(1).max(40),
});
export type UnitDraft = z.infer<typeof unitDraftSchema>;

/**
 * The revised tree the model returns from a change request. Depth is fixed at three levels (month → week → day) so
 * the schema stays plain JSON with no recursion. `ref` echoes the node's ref from the prompt when a node is kept.
 */
const revisedLeafSchema = z.object({
  ref: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  days: z.number().int().min(1),
  covers: z.array(coverRefDraftSchema).optional(),
  materials: z.array(materialRefDraftSchema).optional(),
  practiceCovers: z.array(practiceCoverDraftSchema).optional(),
  practice: z.array(practiceRefDraftSchema).optional(),
});
const revisedMidSchema = revisedLeafSchema.extend({
  children: z.array(revisedLeafSchema).min(1).max(40).optional(),
});
const revisedTopSchema = revisedLeafSchema.extend({
  children: z.array(revisedMidSchema).min(1).max(40).optional(),
});
export const revisedTreeSchema = z.object({
  units: z.array(revisedTopSchema).min(1).max(40),
});
export type RevisedTree = z.infer<typeof revisedTreeSchema>;
export type RevisedNode = z.infer<typeof revisedTopSchema>;

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
