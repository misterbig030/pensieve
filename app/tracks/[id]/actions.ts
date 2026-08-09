"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateOutlineDraft, type GenerateOutlineDraftResult } from "@/lib/ai/outline";
import { computeOutlineReplacement } from "@/lib/outlineRevision";
import {
  getTrackDetail,
  markOutlineItemComplete,
  replaceUnfinishedOutlineItems,
} from "@/lib/db/queries";
import { outlineDraftSchema, type OutlineDraft } from "@/lib/schemas/outline";

export async function reviseOutlineDraftAction(input: {
  trackId: string;
  feedback: string;
  existingDraft?: OutlineDraft;
}): Promise<GenerateOutlineDraftResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  const unfinished = detail.items.filter((i) => i.status !== "completed");
  const baseDraft: OutlineDraft =
    input.existingDraft ?? {
      items: unfinished.map((i) => ({ dayIndex: i.dayIndex, title: i.title, summary: i.summary })),
    };

  return generateOutlineDraft({
    topic: detail.track.title,
    sources: detail.sources.map((s) => ({ url: s.url, title: s.title ?? undefined })),
    existingDraft: baseDraft,
    instructions: detail.track.instructions ?? undefined,
    feedback: input.feedback,
  });
}

export async function confirmRevisionAction(input: {
  trackId: string;
  draft: OutlineDraft;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const draft = outlineDraftSchema.parse(input.draft);

  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  const reindexed = computeOutlineReplacement(
    detail.items.map((i) => ({ dayIndex: i.dayIndex, status: i.status })),
    draft.items.map((i) => ({ title: i.title, summary: i.summary })),
  );

  await replaceUnfinishedOutlineItems(input.trackId, userId, reindexed);
  revalidatePath(`/tracks/${input.trackId}`);
  revalidatePath("/dashboard");
  redirect(`/tracks/${input.trackId}`);
}

export async function markCompleteAction(outlineItemId: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const { trackId } = await markOutlineItemComplete(outlineItemId, userId);
  revalidatePath(`/tracks/${trackId}`);
  revalidatePath("/dashboard");
}
