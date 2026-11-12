"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isAdmin } from "@/lib/admin";
import { collectCalls } from "@/lib/ai/collectCalls";
import { creditRefusal } from "@/lib/ai/creditGate";
import { GatewayFundsError } from "@/lib/ai/gatewayFunds";
import type { ModelCall } from "@/lib/ai/logged";
import type { KeyErrorKind } from "@/lib/ai/models";
import { resolveModels } from "@/lib/ai/resolve";
import { vetMaterials } from "@/lib/ai/research/vet";
import { UserKeyError, guardUserKeyCall } from "@/lib/ai/userKeyError";
import { insertGenerationLog } from "@/lib/db/generationLog";
import type { ImportedPlan } from "@/lib/import/convert";
import { runImport } from "@/lib/import/run";
import { createTrackWithPlan } from "@/lib/db/queries";
import { removeMaterialRefs } from "@/lib/materials";
import { fromTreeInput } from "@/lib/planInput";
import { materialListSchema, type Material } from "@/lib/schemas/material";
import { granularitySchema, planTreeInputSchema, problemsSchema, type PlanTreeInput } from "@/lib/schemas/plan";
import type { Granularity } from "@/lib/planTree";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK, daysPerWeekSchema, hoursPerWeekSchema, planSplitSchema, type PlanSplit } from "@/lib/studyTime";

const topicSchema = z.string().trim().min(1).max(200);

/** The most characters of a plan file an import reads (and a saved track keeps for redrafts). */
const MAX_IMPORT_CHARS = 65536;
const BAD_FILE_MESSAGE = "Pensieve imports .md or .txt files up to 64 KB.";
const OUT_OF_CREDITS_MESSAGE = "You're out of free credits for now.";
const importInputSchema = z.object({ fileName: z.string().max(255), text: z.string() });

/** `calls` is present only when the server confirmed the caller is an admin: the model call behind this import, for the dock. */
export type ImportPlanResult =
  | { ok: true; plan: ImportedPlan; calls?: ModelCall[] }
  | {
      ok: false;
      reason: "no_plan" | "too_long" | "bad_file" | "out_of_credits" | "key";
      message: string;
      code?: KeyErrorKind;
      resetsAt?: string;
      calls?: ModelCall[];
    };

/**
 * Reads an uploaded plan file into the app's plan shapes. Every refusal comes back as a value, so the learner stays on
 * the form with a message; nothing is saved here.
 */
export async function importPlanAction(input: { fileName: string; text: string }): Promise<ImportPlanResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  // A server action takes whatever the browser sends: a malformed call is a bad file, as a wrong one is.
  const parsed = importInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "bad_file", message: BAD_FILE_MESSAGE };
  const { fileName, text } = parsed.data;
  if (!/\.(md|txt)$/i.test(fileName) || text.trim().length < 1 || text.length > MAX_IMPORT_CHARS) {
    return { ok: false, reason: "bad_file", message: BAD_FILE_MESSAGE };
  }

  const admin = await isAdmin(userId);
  const calls: ModelCall[] = [];
  const extra = admin ? { calls } : {};
  const models = await resolveModels(userId);

  const refused = await creditRefusal(userId, [models.outline]);
  if (refused) {
    const body = (await refused.json().catch(() => ({}))) as { resetsAt?: string };
    return { ok: false, reason: "out_of_credits", message: OUT_OF_CREDITS_MESSAGE, ...(body.resetsAt ? { resetsAt: body.resetsAt } : {}), ...extra };
  }

  try {
    const { result } = await guardUserKeyCall(
      () =>
        runImport({
          fileName,
          text,
          model: models.outline,
          log: collectCalls(admin, { userId, onLog: insertGenerationLog, keyOwner: models.outline.keyOwner }, calls),
        }),
      { userId, models },
    );
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message, ...extra };
    return { ok: true, plan: result.plan, ...extra };
  } catch (error) {
    // A refused user key comes back as a value: a thrown error's message does not survive to the browser in production.
    if (error instanceof UserKeyError) return { ok: false, reason: "key", message: error.message, code: error.code, ...extra };
    if (error instanceof GatewayFundsError) return { ok: false, reason: "key", message: error.message, ...extra };
    throw error;
  }
}

export async function confirmTrackAction(input: {
  topic: string;
  instructions?: string;
  granularity: Granularity;
  hoursPerWeek?: number;
  daysPerWeek?: number;
  split?: PlanSplit | null;
  materials: Material[];
  tree: PlanTreeInput;
  summary?: string;
  /** Learner lines for the top level's code-checked problems. */
  problems?: string[];
  /** The plan file's text, for a track made by import: kept so a redraft still sees it. */
  importText?: string;
}): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");

  // Every input is checked before anything is written or vetted.
  const topic = topicSchema.parse(input.topic);
  let root = fromTreeInput(planTreeInputSchema.parse(input.tree));
  const granularity = granularitySchema.parse(input.granularity);
  const hoursPerWeek = hoursPerWeekSchema.parse(input.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK);
  const daysPerWeek = daysPerWeekSchema.parse(input.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK);
  const split = planSplitSchema.nullable().parse(input.split ?? null);
  const problems = problemsSchema.parse(input.problems ?? []);
  const importText = z.string().max(MAX_IMPORT_CHARS).optional().parse(input.importText);
  const listed = materialListSchema.parse(input.materials);

  // A forged "verified" badge must not reach a saved plan: unsigned research materials are checked again.
  const { materials, dropped } = await vetMaterials(listed);
  for (const m of dropped) root = removeMaterialRefs(root, m.id);

  const { trackId, droppedRefs } = await createTrackWithPlan({
    userId,
    title: topic,
    instructions: input.instructions,
    summary: input.summary,
    granularity,
    hoursPerWeek,
    daysPerWeek,
    split,
    problems,
    materials,
    root,
    importText,
  });

  if (dropped.length > 0 || droppedRefs > 0) {
    console.info(`[materials] saved track ${trackId}: ${dropped.length} material(s) failed re-verification, ${droppedRefs} reference(s) to unknown ids dropped`);
  }

  revalidatePath("/");
  redirect(`/tracks/${trackId}`);
}
