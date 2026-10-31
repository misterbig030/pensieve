import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isAdminUserId } from "@/lib/admin";
import { withCallEvents } from "@/lib/ai/callEvents";
import { creditRefusal } from "@/lib/ai/creditGate";
import { runPlanChat } from "@/lib/ai/planChat";
import { db } from "@/lib/db/client";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { tracks } from "@/lib/db/schema";
import { resolveModels } from "@/lib/ai/resolve";
import { guardUserKey } from "@/lib/ai/userKeyError";
import { ndjsonResponse } from "@/lib/ndjson";
import { fromTreeInput } from "@/lib/planInput";
import { granularitySchema, planTreeInputSchema } from "@/lib/schemas/plan";
import { materialListSchema } from "@/lib/schemas/material";
import { weeksOf } from "@/lib/planTree";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK, daysPerWeekSchema, hoursPerWeekSchema, planSplitSchema } from "@/lib/studyTime";

const bodySchema = z.object({
  mode: z.enum(["create", "adjust"]),
  topic: z.string().trim().min(1).max(200),
  granularity: granularitySchema,
  instructions: z.string().trim().max(2000).optional(),
  materials: materialListSchema,
  hoursPerWeek: hoursPerWeekSchema.optional(),
  daysPerWeek: daysPerWeekSchema.optional(),
  split: planSplitSchema.nullable().optional(),
  tree: planTreeInputSchema,
  lockBefore: z.number().int().min(0).optional(),
  trackId: z.string().uuid().optional(),
  transcript: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(60),
  debug: z.boolean().optional(),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Not authenticated", { status: 401 });

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const body = parsed.data;
  if (body.transcript[body.transcript.length - 1].role !== "user") {
    return new Response("Transcript must end with the learner's message", { status: 400 });
  }

  if (body.trackId) {
    const owned = await db.query.tracks.findFirst({
      where: and(eq(tracks.id, body.trackId), eq(tracks.userId, userId)),
      columns: { id: true },
    });
    if (!owned) return new Response("Track not found", { status: 404 });
  }

  const tree = fromTreeInput(body.tree);
  const daysPerWeek = body.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK;
  const debug = body.debug === true && isAdminUserId(userId);
  const models = await resolveModels(userId);
  // A chat turn is checked against the month's free credits: the chat model, and the outline model its revision uses.
  const refused = await creditRefusal(userId, [models.chat, models.outline]);
  if (refused) return refused;
  return ndjsonResponse(
    withCallEvents(debug, { userId, trackId: body.trackId, onLog: insertGenerationLog, keyOwner: models.chat.keyOwner }, (log) =>
      guardUserKey(
        runPlanChat(
          { ...body, weeks: weeksOf(tree, tree, daysPerWeek), daysPerWeek, instructions: body.instructions || undefined, hoursPerWeek: body.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK, split: body.split ?? null, tree },
          { log, model: models.chat, outlineModel: models.outline },
        ),
        { userId, models },
      ),
    ),
  );
}
