import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin } from "@/lib/admin";
import { withCallEvents } from "@/lib/ai/callEvents";
import { creditRefusal } from "@/lib/ai/creditGate";
import { DRAFT_BUDGET_MS } from "@/lib/ai/planDraft";
import { NothingToRedraftError, redraftPlan, type RedraftInput } from "@/lib/ai/planRedraft";
import { LockedNodeError } from "@/lib/ai/planRevision";
import { db } from "@/lib/db/client";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { tracks } from "@/lib/db/schema";
import { resolveModels } from "@/lib/ai/resolve";
import { guardUserKey } from "@/lib/ai/userKeyError";
import { ndjsonResponse } from "@/lib/ndjson";
import type { PlanRedraftEvent } from "@/lib/planChat";
import { fromTreeInput } from "@/lib/planInput";
import { granularitySchema, planTreeInputSchema } from "@/lib/schemas/plan";
import { materialListSchema } from "@/lib/schemas/material";
import { weeksOf } from "@/lib/planTree";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK, daysPerWeekSchema, hoursPerWeekSchema, planSplitSchema } from "@/lib/studyTime";

// A whole-plan re-draft runs the outline as a new draft does: the top level, then the first unit's branch. It keeps
// inside `DRAFT_BUDGET_MS`, as a draft does, rather than running past this limit.
export const maxDuration = 300;

/** The chat's body without the transcript, plus what to re-draft: the hours and split pickers re-draft the whole open plan. */
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
  scope: z.object({ kind: z.literal("plan") }),
  debug: z.boolean().optional(),
});

/** The re-draft as a stream of one event. Nothing left to re-draft, or a locked unit, is told to the learner; the plan stays as it was. */
async function* redraftEvents(input: RedraftInput): AsyncGenerator<PlanRedraftEvent> {
  try {
    const { tree, problems, costUsd } = await redraftPlan(input);
    yield { type: "redrafted", tree, problems, costUsd };
  } catch (error) {
    if (error instanceof NothingToRedraftError || error instanceof LockedNodeError) {
      yield { type: "error", message: error.message };
      return;
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Not authenticated", { status: 401 });

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const body = parsed.data;

  if (body.trackId) {
    const owned = await db.query.tracks.findFirst({
      where: and(eq(tracks.id, body.trackId), eq(tracks.userId, userId)),
      columns: { id: true },
    });
    if (!owned) return new Response("Track not found", { status: 404 });
  }

  const tree = fromTreeInput(body.tree);
  const daysPerWeek = body.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK;
  const debug = body.debug === true && (await isAdmin(userId));
  const models = await resolveModels(userId);
  // A re-draft runs only the outline model.
  const refused = await creditRefusal(userId, [models.outline]);
  if (refused) return refused;
  const deadline = Date.now() + DRAFT_BUDGET_MS;

  return ndjsonResponse(
    withCallEvents(debug, { userId, trackId: body.trackId, onLog: insertGenerationLog, keyOwner: models.outline.keyOwner }, (log) =>
      guardUserKey(
        redraftEvents({
          topic: body.topic,
          instructions: body.instructions || undefined,
          materials: body.materials,
          granularity: body.granularity,
          // Whole weeks, as the chat's re-draft tool counts them.
          weeks: Math.round(weeksOf(tree, tree, daysPerWeek)),
          daysPerWeek,
          hoursPerWeek: body.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
          split: body.split ?? null,
          tree,
          // Only an adjusted plan has days behind the learner.
          lockBefore: body.mode === "adjust" ? (body.lockBefore ?? 0) : 0,
          scope: body.scope,
          outlineModel: models.outline,
          log,
          // A client that moves on (a newer hours or split change) stops the outline calls.
          signal: request.signal,
          deadline,
        }),
        { userId, models },
      ),
    ),
  );
}
