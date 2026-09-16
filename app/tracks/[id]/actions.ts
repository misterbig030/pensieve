"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { streamExpandNode } from "@/lib/ai/planDraft";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { getTrackDetail, updateTrackSummary } from "@/lib/db/queries";
import { insertChildren, logSession, markLeafComplete, replacePlanTree } from "@/lib/db/planQueries";
import { fromTreeInput } from "@/lib/planInput";
import { summarizePlan } from "@/lib/planSummary";
import { findNode, lockBoundary, type PlanNode } from "@/lib/planTree";
import { planTreeInputSchema, type PlanTreeInput } from "@/lib/schemas/plan";
import { z } from "zod";

export async function confirmRevisionAction(input: { trackId: string; tree: PlanTreeInput }): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const root = fromTreeInput(planTreeInputSchema.parse(input.tree));
  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  // The client never changes locked nodes, but the server re-checks before writing.
  const lockBefore = lockBoundary(detail.root);
  const missingLocked = lockedIds(detail.root, lockBefore).filter((id) => !findNode(root, id));
  if (missingLocked.length > 0) throw new Error("The revised plan drops days you have already completed");

  await replacePlanTree(input.trackId, userId, root);
  const fresh = await getTrackDetail(input.trackId, userId);
  await updateTrackSummary(input.trackId, userId, summarizePlan(fresh!.root, detail.track.title));
  revalidatePath(`/tracks/${input.trackId}`);
  revalidatePath("/dashboard");
  redirect(`/tracks/${input.trackId}`);
}

function lockedIds(root: PlanNode, lockBefore: number): string[] {
  const ids: string[] = [];
  const visit = (node: PlanNode) => {
    for (const child of node.children ?? []) {
      if (lockBefore > 0 && child.end <= lockBefore) ids.push(child.id);
      visit(child);
    }
  };
  visit(root);
  return ids;
}

/** Plans a heading in detail (`expand`) or splits a week leaf into days (`split`) on a saved track. */
export async function expandNodeAction(input: { trackId: string; nodeId: string; reason: "expand" | "split" }): Promise<{ costUsd: number }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  let children: PlanNode[] | null = null;
  let costUsd = 0;
  for await (const event of streamExpandNode({
    topic: detail.track.title,
    days: detail.root.len,
    granularity: detail.track.granularity,
    instructions: detail.track.instructions ?? undefined,
    sources: detail.sources.map((s) => ({ url: s.url, title: s.title ?? undefined, type: s.type })),
    tree: detail.root,
    nodeId: input.nodeId,
    reason: input.reason,
    log: { userId, trackId: input.trackId, onLog: insertGenerationLog },
  })) {
    if (event.type === "finish") {
      children = event.children;
      costUsd = event.costUsd;
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }
  if (!children) throw new Error("Planning ended early. Try again.");

  await insertChildren(input.trackId, userId, input.nodeId, children, input.reason === "split");
  const fresh = await getTrackDetail(input.trackId, userId);
  await updateTrackSummary(input.trackId, userId, summarizePlan(fresh!.root, detail.track.title));
  revalidatePath(`/tracks/${input.trackId}`);
  return { costUsd };
}

export async function markCompleteAction(nodeId: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const { trackId } = await markLeafComplete(nodeId, userId);
  revalidatePath(`/tracks/${trackId}`);
  revalidatePath(`/tracks/${trackId}/nodes/${nodeId}`);
  revalidatePath("/dashboard");
}

const hoursSchema = z.number().min(0.25).max(24);

export async function logSessionAction(nodeId: string, hours: number): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const { trackId } = await logSession(nodeId, userId, hoursSchema.parse(hours));
  revalidatePath(`/tracks/${trackId}`);
  revalidatePath(`/tracks/${trackId}/nodes/${nodeId}`);
  revalidatePath("/dashboard");
}
