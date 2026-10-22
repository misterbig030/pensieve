"use server";

import { auth } from "@clerk/nextjs/server";
import { isAdminUserId } from "@/lib/admin";
import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { collectCalls } from "@/lib/ai/collectCalls";
import { generateDailyContent, type LessonMaterial, type LessonPractice } from "@/lib/ai/dailyContent";
import { chapterAt } from "@/lib/schemas/material";
import type { ModelCall } from "@/lib/ai/logged";
import { PRACTICE_REGISTRY } from "@/lib/practice";
import { getNodePracticeList, getNodeReadList, getOwnedNode, upsertLeafContent } from "@/lib/db/planQueries";
import { resolveModels } from "@/lib/ai/resolve";
import { UserKeyError, guardUserKeyCall } from "@/lib/ai/userKeyError";
import type { KeyErrorKind } from "@/lib/ai/models";
import { insertGenerationLog } from "@/lib/db/generationLog";

/** `calls` is present only when the server confirmed the caller is an admin: the model call behind this lesson, for the dock. */
export type GenerateLeafContentResult =
  | { ok: true; contentMarkdown: string; citations: { title: string; url: string }[]; costUsd: number; calls?: ModelCall[] }
  | { ok: false; message: string; code: KeyErrorKind; calls?: ModelCall[] };

export async function generateLeafContentAction(input: {
  trackId: string;
  nodeId: string;
}): Promise<GenerateLeafContentResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const admin = isAdminUserId(userId);
  const calls: ModelCall[] = [];
  const extra = admin ? { calls } : {};

  const node = await getOwnedNode(input.nodeId, userId);
  if (!node || node.trackId !== input.trackId) throw new Error("Plan node not found");

  // The lesson reads the leaf's Read table. Plans saved before materials were assigned fall back to the whole list.
  const reads = await getNodeReadList(node.id);
  const materials: LessonMaterial[] =
    reads.length > 0
      ? reads.map((r) => ({
          title: r.source.title ?? r.source.url,
          url: r.source.url,
          type: r.source.type,
          kind: r.source.kind,
          tier: r.tier,
          minutes: r.minutes,
          note: r.note,
          chapter: chapterAt(r.source.toc, r.chapter || null),
          activity: r.activity,
        }))
      : (await db.query.sources.findMany({ where: eq(sources.trackId, input.trackId), orderBy: [asc(sources.position)] })).map((s) => ({
          title: s.title ?? s.url,
          url: s.url,
          type: s.type,
          kind: s.kind,
        }));

  // The Do table: a generated recall row keeps its reading as source, any other generated row has none.
  const practice: LessonPractice[] = (await getNodePracticeList(node.id)).map((p) => ({
    format: p.format,
    label: PRACTICE_REGISTRY[p.format].label,
    task: p.task,
    done: p.done ?? "",
    minutes: p.minutes ?? 0,
    source: p.source ? { title: p.source.title ?? p.source.url, url: p.source.url } : null,
    generated: p.generated,
  }));

  const models = await resolveModels(userId);
  let generated: Awaited<ReturnType<typeof generateDailyContent>>;
  try {
    generated = await guardUserKeyCall(
      () =>
        generateDailyContent({
          title: node.title,
          summary: node.summary,
          unit: node.level === "day" ? "day" : "week",
          spanDays: node.len,
          materials,
          practice,
          model: models.content,
          log: collectCalls(admin, { trackId: input.trackId, userId, onLog: insertGenerationLog, keyOwner: models.content.keyOwner }, calls),
        }),
      { userId, models },
    );
  } catch (error) {
    // A refused user key comes back as a value: a thrown error's message does not survive to the browser in production.
    if (error instanceof UserKeyError) return { ok: false, message: error.message, code: error.code, ...extra };
    throw error;
  }
  const { content, costUsd } = generated;

  await upsertLeafContent(node.id, {
    contentMarkdown: content.contentMarkdown,
    citations: content.citations,
    model: models.content.id,
  });

  revalidatePath(`/tracks/${input.trackId}`);
  revalidatePath(`/tracks/${input.trackId}/nodes/${input.nodeId}`);

  return { ok: true, ...content, costUsd, ...extra };
}
