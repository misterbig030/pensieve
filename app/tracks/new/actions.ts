"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { generateOutlineDraft } from "@/lib/ai/outline";
import { createTrackWithOutline } from "@/lib/db/queries";
import { outlineDraftSchema, type OutlineDraft } from "@/lib/schemas/outline";
import type { AiModelId } from "@/lib/ai/models";

const topicSchema = z.string().trim().min(1).max(200);

export async function generateOutlineDraftAction(input: {
  topic: string;
  periodDays?: number;
  sources: { url: string; title?: string }[];
  existingDraft?: OutlineDraft;
  feedback?: string;
  model: AiModelId;
}): Promise<OutlineDraft> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  return generateOutlineDraft(input);
}

export async function confirmTrackAction(input: {
  topic: string;
  sources: { url: string; title?: string; type: "link" | "youtube" }[];
  draft: OutlineDraft;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const topic = topicSchema.parse(input.topic);
  const draft = outlineDraftSchema.parse(input.draft);

  const { trackId } = await createTrackWithOutline({
    userId,
    title: topic,
    sources: input.sources,
    items: draft.items,
  });

  revalidatePath("/dashboard");
  redirect(`/tracks/${trackId}`);
}
