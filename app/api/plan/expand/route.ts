import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { isAdminUserId } from "@/lib/admin";
import { withCallEvents } from "@/lib/ai/callEvents";
import { streamExpandNode } from "@/lib/ai/planDraft";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { resolveModels } from "@/lib/ai/resolve";
import { guardUserKey } from "@/lib/ai/userKeyError";
import { ndjsonResponse } from "@/lib/ndjson";
import { fromTreeInput } from "@/lib/planInput";
import { granularitySchema, planTreeInputSchema } from "@/lib/schemas/plan";
import { materialListSchema } from "@/lib/schemas/material";
import { weeksOf } from "@/lib/planTree";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK, daysPerWeekSchema, hoursPerWeekSchema, planSplitSchema } from "@/lib/studyTime";

const bodySchema = z.object({
  topic: z.string().trim().min(1).max(200),
  granularity: granularitySchema,
  instructions: z.string().trim().max(2000).optional(),
  materials: materialListSchema,
  hoursPerWeek: hoursPerWeekSchema.optional(),
  daysPerWeek: daysPerWeekSchema.optional(),
  splitDays: daysPerWeekSchema.optional(),
  split: planSplitSchema.nullable().optional(),
  tree: planTreeInputSchema,
  nodeId: z.string().min(1),
  reason: z.enum(["expand", "split"]),
  debug: z.boolean().optional(),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Not authenticated", { status: 401 });

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const body = parsed.data;
  const tree = fromTreeInput(body.tree);
  const daysPerWeek = body.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK;
  const debug = body.debug === true && isAdminUserId(userId);
  const models = await resolveModels(userId);

  return ndjsonResponse(
    withCallEvents(debug, { userId, onLog: insertGenerationLog, keyOwner: models.outline.keyOwner }, (log) =>
      guardUserKey(
        streamExpandNode({
          topic: body.topic,
          weeks: weeksOf(tree, tree, daysPerWeek),
          daysPerWeek,
          granularity: body.granularity,
          instructions: body.instructions || undefined,
          materials: body.materials,
          hoursPerWeek: body.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
          split: body.split ?? null,
          tree,
          nodeId: body.nodeId,
          reason: body.reason,
          splitDays: body.splitDays,
          outlineModel: models.outline,
          log,
        }),
        { userId, models },
      ),
    ),
  );
}
