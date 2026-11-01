"use server";

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/admin";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { collectCalls } from "@/lib/ai/collectCalls";
import type { ModelCall } from "@/lib/ai/logged";
import { streamExpandNode } from "@/lib/ai/planDraft";
import { resolveModels } from "@/lib/ai/resolve";
import { UserKeyError, guardUserKey } from "@/lib/ai/userKeyError";
import { GatewayFundsError } from "@/lib/ai/gatewayFunds";
import type { KeyErrorKind } from "@/lib/ai/models";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { getTrackDetail, updateTrackStudyTime, updateTrackSummary } from "@/lib/db/queries";
import { insertChildren, logSession, markLeafComplete, replacePlanTree } from "@/lib/db/planQueries";
import { fromTreeInput } from "@/lib/planInput";
import { summarizePlan } from "@/lib/planSummary";
import { findNode, lockBoundary, weeksOf, type PlanNode } from "@/lib/planTree";
import { planTreeInputSchema, type PlanTreeInput } from "@/lib/schemas/plan";
import { daysPerWeekSchema, hoursPerWeekSchema, planSplitSchema, type PlanSplit } from "@/lib/studyTime";
import { z } from "zod";

/**
 * Saves the adjusted plan. `materialIds` is the list the learner kept: saved materials left out of it are removed,
 * with their references.
 */
export async function confirmRevisionAction(input: {
  trackId: string;
  tree: PlanTreeInput;
  materialIds: string[];
  /** The learner's weekly hours and the plan's split as the adjust page left them; left out, both stay as saved. */
  hoursPerWeek?: number;
  /** The learner's usual study days a week as the adjust page left it; left out, it stays as saved. */
  daysPerWeek?: number;
  split?: PlanSplit | null;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  const root = fromTreeInput(planTreeInputSchema.parse(input.tree));
  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  // The client never changes locked nodes, but the server re-checks before writing.
  const lockBefore = lockBoundary(detail.root);
  const missingLocked = lockedIds(detail.root, lockBefore).filter((id) => !findNode(root, id));
  if (missingLocked.length > 0) throw new Error("The revised plan drops days you have already completed");

  const materialIds = z.array(z.string().uuid()).max(200).parse(input.materialIds);
  await replacePlanTree(input.trackId, userId, root, materialIds);
  if (input.hoursPerWeek !== undefined) {
    await updateTrackStudyTime(input.trackId, userId, {
      hoursPerWeek: hoursPerWeekSchema.parse(input.hoursPerWeek),
      daysPerWeek: input.daysPerWeek === undefined ? undefined : daysPerWeekSchema.parse(input.daysPerWeek),
      split: input.split === undefined ? detail.track.split : planSplitSchema.nullable().parse(input.split),
    });
  }
  const fresh = await getTrackDetail(input.trackId, userId);
  await updateTrackSummary(input.trackId, userId, summarizePlan(fresh!.root, detail.track.title, fresh!.track.daysPerWeek));
  revalidatePath(`/tracks/${input.trackId}`);
  revalidatePath("/");
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
/** A refused user key comes back as a value: a thrown error's message does not survive to the browser in production. */
/** `calls` is present only when the server confirmed the caller is an admin: the model calls behind this request, for the dock. */
export type ExpandNodeResult =
  | { ok: true; costUsd: number; calls?: ModelCall[] }
  | { ok: false; message: string; code?: KeyErrorKind; calls?: ModelCall[] };

export async function expandNodeAction(input: { trackId: string; nodeId: string; reason: "expand" | "split"; splitDays?: number }): Promise<ExpandNodeResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const admin = await isAdmin(userId);
  const calls: ModelCall[] = [];
  const extra = admin ? { calls } : {};
  const detail = await getTrackDetail(input.trackId, userId);
  if (!detail) throw new Error("Track not found");

  const models = await resolveModels(userId);
  let children: PlanNode[] | null = null;
  let costUsd = 0;
  try {
    for await (const event of guardUserKey(
      streamExpandNode({
        topic: detail.track.title,
        weeks: weeksOf(detail.root, detail.root, detail.track.daysPerWeek),
        daysPerWeek: detail.track.daysPerWeek,
        granularity: detail.track.granularity,
        instructions: detail.track.instructions ?? undefined,
        materials: detail.materials,
        hoursPerWeek: detail.track.hoursPerWeek,
        split: detail.track.split,
        tree: detail.root,
        nodeId: input.nodeId,
        reason: input.reason,
        splitDays: input.splitDays === undefined ? undefined : daysPerWeekSchema.parse(input.splitDays),
        outlineModel: models.outline,
        log: collectCalls(admin, { userId, trackId: input.trackId, onLog: insertGenerationLog, keyOwner: models.outline.keyOwner }, calls),
      }),
      { userId, models },
    )) {
      if (event.type === "finish") {
        children = event.children;
        costUsd = event.costUsd;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
  } catch (error) {
    if (error instanceof UserKeyError) return { ok: false, message: error.message, code: error.code, ...extra };
    if (error instanceof GatewayFundsError) return { ok: false, message: error.message, ...extra };
    throw error;
  }
  if (!children) throw new Error("Planning ended early. Try again.");

  await insertChildren(input.trackId, userId, input.nodeId, children, input.reason === "split");
  const fresh = await getTrackDetail(input.trackId, userId);
  await updateTrackSummary(input.trackId, userId, summarizePlan(fresh!.root, detail.track.title, fresh!.track.daysPerWeek));
  revalidatePath(`/tracks/${input.trackId}`);
  return { ok: true, costUsd, ...extra };
}

export async function markCompleteAction(nodeId: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const { trackId } = await markLeafComplete(nodeId, userId);
  revalidatePath(`/tracks/${trackId}`);
  revalidatePath(`/tracks/${trackId}/nodes/${nodeId}`);
  revalidatePath("/");
}

const hoursSchema = z.number().min(0.25).max(24);

export async function logSessionAction(nodeId: string, hours: number): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const { trackId } = await logSession(nodeId, userId, hoursSchema.parse(hours));
  revalidatePath(`/tracks/${trackId}`);
  revalidatePath(`/tracks/${trackId}/nodes/${nodeId}`);
  revalidatePath("/");
}
