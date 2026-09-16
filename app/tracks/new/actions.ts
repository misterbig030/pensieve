"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createTrackWithPlan } from "@/lib/db/queries";
import { fromTreeInput } from "@/lib/planInput";
import { granularitySchema, planTreeInputSchema, type PlanTreeInput } from "@/lib/schemas/plan";
import { sourceInputSchema, type SourceInput } from "@/lib/schemas/source";
import type { Granularity } from "@/lib/planTree";

const topicSchema = z.string().trim().min(1).max(200);

export async function confirmTrackAction(input: {
  topic: string;
  instructions?: string;
  granularity: Granularity;
  sources: SourceInput[];
  tree: PlanTreeInput;
  summary?: string;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const topic = topicSchema.parse(input.topic);
  const root = fromTreeInput(planTreeInputSchema.parse(input.tree));
  const granularity = granularitySchema.parse(input.granularity);
  const sources = z.array(sourceInputSchema).parse(input.sources);

  const { trackId } = await createTrackWithPlan({
    userId,
    title: topic,
    instructions: input.instructions,
    summary: input.summary,
    granularity,
    sources,
    root,
  });

  revalidatePath("/dashboard");
  redirect(`/tracks/${trackId}`);
}
