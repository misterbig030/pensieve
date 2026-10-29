import { z } from "zod";
import { granularitySchema } from "@/lib/schemas/plan";
import { sourceInputSchema } from "@/lib/schemas/source";
import { MAX_WEEKS } from "@/lib/planTree";
import { DEFAULT_HOURS_PER_WEEK, daysPerWeekSchema, hoursPerWeekSchema } from "@/lib/studyTime";
import type { GenerationLogContext } from "./logged";
import type { StreamResearchedDraftInput } from "./planDraft";
import { defaultArm, defaultStructureFinder } from "./research/pipeline";
import type { ResolvedModel, ResolvedModels } from "./resolve";
import { reportingModel } from "./serviceEvents";

export const draftRequestBodySchema = z.object({
  topic: z.string().trim().min(1).max(200),
  weeks: z.number().int().min(1).max(MAX_WEEKS),
  daysPerWeek: daysPerWeekSchema,
  granularity: granularitySchema,
  instructions: z.string().trim().max(2000).optional(),
  materials: z.array(sourceInputSchema).max(50),
  hoursPerWeek: hoursPerWeekSchema.optional(),
  debug: z.boolean().optional(),
});

export type DraftRequestBody = z.infer<typeof draftRequestBodySchema>;

/** The same role, its model wrapped to report failed attempts; its id and key owner are unchanged. */
function reporting(resolved: ResolvedModel, onService: NonNullable<GenerationLogContext["onService"]>): ResolvedModel {
  return { ...resolved, model: reportingModel(resolved.model, onService) };
}

/**
 * The input the draft route streams, and the eval runs: one builder so the eval exercises exactly the route's path.
 * When `log.onService` is set (admin debug, the eval) the models report their failed attempts.
 */
export function researchedDraftInput(args: {
  request: DraftRequestBody;
  models: ResolvedModels;
  deadline: number;
  signal?: AbortSignal;
  log: GenerationLogContext;
  env?: Record<string, string | undefined>;
}): StreamResearchedDraftInput {
  const { request, models, deadline, signal, log, env = process.env } = args;
  const onService = log.onService;
  const research = onService ? reportingModel(models.research.model, onService) : models.research.model;
  return {
    topic: request.topic,
    weeks: request.weeks,
    daysPerWeek: request.daysPerWeek,
    granularity: request.granularity,
    instructions: request.instructions || undefined,
    materials: request.materials,
    hoursPerWeek: request.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
    arm: defaultArm(env, { model: research }),
    research: { structure: defaultStructureFinder(env, { model: research }) },
    outlineModel: onService ? reporting(models.outline, onService) : models.outline,
    allocateModel: onService ? reporting(models.allocate, onService) : models.allocate,
    signal,
    deadline,
    log,
  };
}
