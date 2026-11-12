import { loggedGenerateObject, type GenerationLogContext } from "@/lib/ai/logged";
import { STRUCTURE_EFFORT } from "@/lib/ai/models";
import type { ResolvedModel } from "@/lib/ai/resolve";
import { convertDraft, type ConvertResult } from "./convert";
import { buildImportPrompt } from "./prompt";
import { importDraftSchema } from "./schema";

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
  return { result: convertDraft(object, fileName), costUsd };
}
