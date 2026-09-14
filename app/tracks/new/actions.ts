"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { generateOutlineDraft, type GenerateOutlineDraftResult } from "@/lib/ai/outline";
import { createTrackWithOutline } from "@/lib/db/queries";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { outlineDraftSchema, type OutlineDraft } from "@/lib/schemas/outline";
import { sourceInputSchema, type SourceInput } from "@/lib/schemas/source";

const topicSchema = z.string().trim().min(1).max(200);

export async function generateOutlineDraftAction(input: {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string }[];
  existingDraft?: OutlineDraft;
  instructions?: string;
  feedback?: string;
}): Promise<GenerateOutlineDraftResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  return generateOutlineDraft({ ...input, log: { userId, onLog: insertGenerationLog } });
}

export async function confirmTrackAction(input: {
  topic: string;
  instructions?: string;
  sources: SourceInput[];
  draft: OutlineDraft;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const topic = topicSchema.parse(input.topic);
  const draft = outlineDraftSchema.parse(input.draft);
  const sources = z.array(sourceInputSchema).parse(input.sources);

  const { trackId } = await createTrackWithOutline({
    userId,
    title: topic,
    instructions: input.instructions,
    sources,
    items: draft.items,
  });

  revalidatePath("/dashboard");
  redirect(`/tracks/${trackId}`);
}
