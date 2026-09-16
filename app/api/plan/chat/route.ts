import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { runPlanChat } from "@/lib/ai/planChat";
import { db } from "@/lib/db/client";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { tracks } from "@/lib/db/schema";
import { ndjsonResponse } from "@/lib/ndjson";
import { fromTreeInput } from "@/lib/planInput";
import { granularitySchema, planTreeInputSchema } from "@/lib/schemas/plan";
import { sourceInputSchema } from "@/lib/schemas/source";

const bodySchema = z.object({
  mode: z.enum(["create", "adjust"]),
  topic: z.string().trim().min(1).max(200),
  granularity: granularitySchema,
  instructions: z.string().trim().max(2000).optional(),
  sources: z.array(sourceInputSchema).max(50),
  tree: planTreeInputSchema,
  lockBefore: z.number().int().min(0).optional(),
  trackId: z.string().uuid().optional(),
  transcript: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(60),
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
  return ndjsonResponse(
    runPlanChat(
      { ...body, days: tree.len, instructions: body.instructions || undefined, tree },
      { log: { userId, trackId: body.trackId, onLog: insertGenerationLog } },
    ),
  );
}
