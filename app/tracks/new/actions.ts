"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { vetMaterials } from "@/lib/ai/research/vet";
import { createTrackWithPlan } from "@/lib/db/queries";
import { removeMaterialRefs } from "@/lib/materials";
import { fromTreeInput } from "@/lib/planInput";
import { materialListSchema, type Material } from "@/lib/schemas/material";
import { granularitySchema, planTreeInputSchema, type PlanTreeInput } from "@/lib/schemas/plan";
import type { Granularity } from "@/lib/planTree";

const topicSchema = z.string().trim().min(1).max(200);

export async function confirmTrackAction(input: {
  topic: string;
  instructions?: string;
  granularity: Granularity;
  materials: Material[];
  tree: PlanTreeInput;
  summary?: string;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const topic = topicSchema.parse(input.topic);
  let root = fromTreeInput(planTreeInputSchema.parse(input.tree));
  const granularity = granularitySchema.parse(input.granularity);

  // A forged "verified" badge must not reach a saved plan: unsigned research materials are checked again.
  const { materials, dropped } = await vetMaterials(materialListSchema.parse(input.materials));
  for (const m of dropped) root = removeMaterialRefs(root, m.id);

  const { trackId } = await createTrackWithPlan({
    userId,
    title: topic,
    instructions: input.instructions,
    summary: input.summary,
    granularity,
    materials,
    root,
  });

  revalidatePath("/dashboard");
  redirect(`/tracks/${trackId}`);
}
