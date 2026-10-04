import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { isAdminUserId } from "@/lib/admin";
import { withCallEvents } from "@/lib/ai/callEvents";
import { streamResearchedPlanDraft } from "@/lib/ai/planDraft";
import { defaultArm } from "@/lib/ai/research/pipeline";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { ndjsonResponse } from "@/lib/ndjson";
import { granularitySchema } from "@/lib/schemas/plan";
import { sourceInputSchema } from "@/lib/schemas/source";
import { DEFAULT_HOURS_PER_WEEK, hoursPerWeekSchema } from "@/lib/studyTime";

// Research (a minute or two at most) runs before drafting in the same request.
export const maxDuration = 300;

const bodySchema = z.object({
  topic: z.string().trim().min(1).max(200),
  days: z.number().int().min(1).max(365),
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

  return ndjsonResponse(
    withCallEvents(debug, { userId, onLog: insertGenerationLog }, (log) =>
      streamResearchedPlanDraft({
        topic: body.topic,
        days: body.days,
        granularity: body.granularity,
        instructions: body.instructions || undefined,
        materials: body.materials,
        hoursPerWeek: body.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
        arm: defaultArm(),
        // A client that disconnects stops research: the signal reaches search and fetch.
        signal: request.signal,
        log,
      }),
    ),
  );
}
