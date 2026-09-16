import { streamText, tool, stepCountIs, type LanguageModelUsage, type ModelMessage } from "ai";
import { z } from "zod";
import type { PlanChatEvent, PlanChatRequest } from "@/lib/planChat";
import { diffChangedNodes, type ChangedNodes } from "@/lib/planSummary";
import { cloneTree, layout, type PlanNode } from "@/lib/planTree";
import { buildGenerationLogRow, emitGenerationLog, type GenerationLogContext } from "./logged";
import { type AiModelId } from "./models";
import { buildPlanChatSystemPrompt, renderTree } from "./planPrompt";
import { revisePlanTree } from "./planRevision";

/** Chat turns are short and latency-sensitive; the revision tool uses the outline model. */
export const DEFAULT_CHAT_MODEL: AiModelId = "anthropic/claude-haiku-4.5";

const revisePlanInput = z.object({
  changeRequest: z
    .string()
    .min(1)
    .describe(
      'A precise, self-contained instruction for revising the plan, naming units by label, e.g. "Swap Week 3 and Week 4; leave the days inside each untouched." or "Inside Week 2, move Day 10 (quantization) before Day 9 (roofline)."',
    ),
});

export interface RunPlanChatOptions {
  log?: GenerationLogContext;
  model?: AiModelId;
}

/**
 * Runs one conversation turn. The model answers questions as text and calls `revisePlan` for changes; the tool runs
 * the revision generator so the whole tree is reconciled server-side before the client sees it.
 */
export type PlanChatInput = Omit<PlanChatRequest, "tree"> & { tree: PlanNode };

export async function* runPlanChat(req: PlanChatInput, options: RunPlanChatOptions = {}): AsyncGenerator<PlanChatEvent> {
  const model = options.model ?? DEFAULT_CHAT_MODEL;
  const log = options.log;
  const startedAt = performance.now();
  const tree = layout(cloneTree(req.tree));
  const lockBefore = req.mode === "adjust" ? (req.lockBefore ?? 0) : 0;

  let revised: { tree: PlanNode; changed: ChangedNodes } | null = null;
  let revisionCostUsd = 0;

  const revisePlan = tool({
    description:
      "Revise the plan. Call this only when the learner asks for the plan to change. Do not call it to answer questions.",
    inputSchema: revisePlanInput,
    execute: async ({ changeRequest }) => {
      const result = await revisePlanTree({
        topic: req.topic,
        instructions: req.instructions,
        sources: req.sources,
        granularity: req.granularity,
        tree,
        lockBefore,
        changeRequest,
        log,
      });
      revisionCostUsd += result.costUsd;
      const changed = diffChangedNodes(tree, result.tree);
      revised = { tree: result.tree, changed };
      return {
        totalDays: result.tree.len,
        changedLevel: changed.level,
        changedUnits: changed.tags,
        plan: renderTree(result.tree),
      };
    },
  });

  const messages: ModelMessage[] = req.transcript.map((t) => ({ role: t.role, content: t.content }));

  const result = streamText({
    model,
    system: buildPlanChatSystemPrompt({
      mode: req.mode,
      topic: req.topic,
      instructions: req.instructions,
      sources: req.sources,
      granularity: req.granularity,
      tree,
      lockBefore,
    }),
    messages,
    tools: { revisePlan },
    stopWhen: stepCountIs(2),
  });

  let usage: LanguageModelUsage | null = null;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        if (part.text) yield { type: "text", text: part.text };
        break;
      case "tool-call":
        yield { type: "revising" };
        break;
      case "tool-result":
        if (revised) {
          const r: { tree: PlanNode; changed: ChangedNodes } = revised;
          yield { type: "revised", tree: r.tree, changed: r.changed, costUsd: revisionCostUsd };
        }
        break;
      case "tool-error":
        yield { type: "error", message: part.error instanceof Error ? part.error.message : "Revision failed" };
        break;
      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      case "finish":
        usage = part.totalUsage;
        break;
      default:
        break;
    }
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  let chatCostUsd = 0;
  if (usage) {
    const row = buildGenerationLogRow({ caller: "chat", model, usage, latencyMs, trackId: log?.trackId, userId: log?.userId });
    chatCostUsd = row.costUsd;
    await emitGenerationLog(log?.onLog, row);
  }
  yield { type: "finish", costUsd: chatCostUsd + revisionCostUsd };
}
