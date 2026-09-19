import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { isAdminUserId } from "@/lib/admin";
import { withCallEvents } from "@/lib/ai/callEvents";
import { streamExpandNode } from "@/lib/ai/planDraft";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { ndjsonResponse } from "@/lib/ndjson";
import { fromTreeInput } from "@/lib/planInput";
import { granularitySchema, planTreeInputSchema } from "@/lib/schemas/plan";
import { sourceInputSchema } from "@/lib/schemas/source";

const bodySchema = z.object({
  topic: z.string().trim().min(1).max(200),
  granularity: granularitySchema,
  instructions: z.string().trim().max(2000).optional(),
  sources: z.array(sourceInputSchema).max(50),
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
  const debug = body.debug === true && isAdminUserId(userId);

  return ndjsonResponse(
    withCallEvents(debug, { userId, onLog: insertGenerationLog }, (log) =>
      streamExpandNode({
        topic: body.topic,
        days: tree.len,
        granularity: body.granularity,
        instructions: body.instructions || undefined,
        sources: body.sources,
        tree,
        nodeId: body.nodeId,
        reason: body.reason,
        log,
      }),
    ),
  );
}
