import { loggedGenerateObject, type GenerationLogContext } from "@/lib/ai/logged";
import { STRUCTURE_EFFORT } from "@/lib/ai/models";
import type { ResolvedModel } from "@/lib/ai/resolve";
import { convertDraft, type ConvertResult } from "./convert";
import { buildImportPrompt } from "./prompt";
import { importDraftSchema } from "./schema";
import { materialListSchema } from "@/lib/schemas/material";
import { planTreeInputSchema } from "@/lib/schemas/plan";
import { planSplitSchema } from "@/lib/studyTime";

/**
 * Reads a plan file with one model call and converts the answer into the app's plan shapes. No research and no
 * lookups: the file's own structure is all there is. `costUsd` is what Pensieve paid (0 on the user's own key).
 */
export async function runImport(input: {
  fileName: string;
  text: string;
  model: ResolvedModel;
  log?: GenerationLogContext;
}): Promise<{ result: ConvertResult; costUsd: number }> {
  const { model, fileName } = input;
  const { object, costUsd } = await loggedGenerateObject(
    {
      model: model.id,
      languageModel: typeof model.model === "string" ? undefined : model.model,
      keyOwner: model.keyOwner,
      schema: importDraftSchema,
      prompt: buildImportPrompt({ fileName, text: input.text }),
      label: `Import · ${fileName}`,
      effort: STRUCTURE_EFFORT,
      check: (d) => (d.kind === "plan" ? [`${d.units.length} units`] : ["no plan"]),
    },
    { ...input.log, caller: "import" },
  );
  return { result: checkedPlan(convertDraft(object, fileName)), costUsd };
}

/** What the learner reads when the converted plan is not one the app can save. */
export const UNSAVABLE_PLAN_MESSAGE = "Its units don't fit the shape Pensieve saves a plan in.";

/**
 * The converted plan as the draft page and the confirm step take it, checked against the same schemas a save is: the
 * tree, the materials list and the split. One that fails is refused as no plan, with the reason logged here, so a bad
 * conversion stops before the learner shapes a plan that cannot be saved.
 */
export function checkedPlan(result: ConvertResult): ConvertResult {
  if (!result.ok) return result;
  const { tree, materials, split } = result.plan;
  for (const [name, check] of [
    ["tree", planTreeInputSchema.safeParse(tree)],
    ["materials", materialListSchema.safeParse(materials)],
    ["split", planSplitSchema.safeParse(split)],
  ] as const) {
    if (check.success) continue;
    console.error(`[import] the converted plan's ${name} failed validation`, check.error);
    return { ok: false, reason: "no_plan", message: UNSAVABLE_PLAN_MESSAGE };
  }
  return result;
}
