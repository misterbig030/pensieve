import { z } from "zod";

export const PLAN_LEVELS = ["month", "week", "day"] as const;
export const planLevelSchema = z.enum(PLAN_LEVELS);
export const granularityChoiceSchema = z.enum(["day", "week", "auto"]);
export const granularitySchema = z.enum(["day", "week"]);

/** What the model writes for one unit whose span the server already decided. */
export const unitDraftSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
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
});
const leafInputSchema = nodeInputBase.extend({ children: z.null().optional() });
const midInputSchema = nodeInputBase.extend({ children: z.array(leafInputSchema).max(60).nullable().optional() });
const topInputSchema = nodeInputBase.extend({ children: z.array(midInputSchema).max(60).nullable().optional() });
export const planTreeInputSchema = z.array(topInputSchema).min(1).max(60);
export type PlanTreeInput = z.infer<typeof planTreeInputSchema>;
export type PlanNodeInput = PlanTreeInput[number];
