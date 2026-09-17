import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { streamPlanDraft } from "@/lib/ai/planDraft";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { ndjsonResponse } from "@/lib/ndjson";
import { granularitySchema } from "@/lib/schemas/plan";
import { sourceInputSchema } from "@/lib/schemas/source";

const bodySchema = z.object({
  topic: z.string().trim().min(1).max(200),
  days: z.number().int().min(1).max(365),
  granularity: granularitySchema,
  instructions: z.string().trim().max(2000).optional(),
  sources: z.array(sourceInputSchema).max(50),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Not authenticated", { status: 401 });

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const body = parsed.data;

  return ndjsonResponse(
    streamPlanDraft({
      topic: body.topic,
      days: body.days,
      granularity: body.granularity,
      instructions: body.instructions || undefined,
      sources: body.sources,
      log: { userId, onLog: insertGenerationLog },
    }),
  );
}
