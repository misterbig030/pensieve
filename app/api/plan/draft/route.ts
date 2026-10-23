import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { isAdminUserId } from "@/lib/admin";
import { withCallEvents } from "@/lib/ai/callEvents";
import { streamResearchedPlanDraft } from "@/lib/ai/planDraft";
import { defaultArm, defaultChapterFinder } from "@/lib/ai/research/pipeline";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { resolveModels } from "@/lib/ai/resolve";
import { guardUserKey } from "@/lib/ai/userKeyError";
import { ndjsonResponse } from "@/lib/ndjson";
import { granularitySchema } from "@/lib/schemas/plan";
import { sourceInputSchema } from "@/lib/schemas/source";
import { MAX_WEEKS } from "@/lib/planTree";
import { DEFAULT_HOURS_PER_WEEK, daysPerWeekSchema, hoursPerWeekSchema } from "@/lib/studyTime";

// Research (a minute or two at most) runs before drafting in the same request.
export const maxDuration = 300;

const bodySchema = z.object({
  topic: z.string().trim().min(1).max(200),
  weeks: z.number().int().min(1).max(MAX_WEEKS),
  daysPerWeek: daysPerWeekSchema,
  granularity: granularitySchema,
  instructions: z.string().trim().max(2000).optional(),
  materials: z.array(sourceInputSchema).max(50),
  hoursPerWeek: hoursPerWeekSchema.optional(),
  debug: z.boolean().optional(),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Not authenticated", { status: 401 });

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const body = parsed.data;
  const debug = body.debug === true && isAdminUserId(userId);
  const models = await resolveModels(userId);

  return ndjsonResponse(
    withCallEvents(debug, { userId, onLog: insertGenerationLog, keyOwner: models.research.keyOwner }, (log) =>
      guardUserKey(
        streamResearchedPlanDraft({
          topic: body.topic,
          weeks: body.weeks,
          daysPerWeek: body.daysPerWeek,
          granularity: body.granularity,
          instructions: body.instructions || undefined,
          materials: body.materials,
          hoursPerWeek: body.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
          arm: defaultArm(process.env, { model: models.research.model }),
          research: { chapters: defaultChapterFinder(process.env, { model: models.research.model }) ?? undefined },
          outlineModel: models.outline,
          allocateModel: models.allocate,
          // A client that disconnects stops research: the signal reaches search and fetch.
          signal: request.signal,
          log,
        }),
        { userId, models },
      ),
    ),
  );
}
