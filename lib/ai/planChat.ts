import { streamText, tool, stepCountIs, type LanguageModelUsage, type ModelMessage, type ProviderMetadata } from "ai";
import { z } from "zod";
import type { PlanChatEvent, PlanChatRequest } from "@/lib/planChat";
import { diffChangedNodes, type ChangedNodes } from "@/lib/planSummary";
import { childLevel, cloneTree, labelOf, layout, parentOf, walk, weeksOf, type PlanNode } from "@/lib/planTree";
import { buildGenerationLogRow, emitGenerationLog, type GenerationLogContext } from "./logged";
import { DEFAULT_CHAT_MODEL } from "./models";
import { buildPlanChatSystemPrompt, renderTree } from "./planPrompt";
import { unitsAreLeaves } from "./planDraft";
import { NothingToRedraftError, redraftPlan, type RedraftScope } from "./planRedraft";
import { LockedNodeError, revisePlanTree } from "./planRevision";
import { appModel, type ResolvedModel } from "./resolve";
import { GATEWAY_FUNDS_MESSAGE, isGatewayOutOfFunds } from "./gatewayFunds";

export { DEFAULT_CHAT_MODEL } from "./models";

const revisePlanInput = z.object({
  changeRequest: z
    .string()
    .min(1)
    .describe(
      'A precise, self-contained instruction for revising the plan, naming units by label, e.g. "Swap Week 3 and Week 4; leave the days inside each untouched." or "Inside Week 2, move Day 4 (quantization) before Day 3 (roofline)."',
    ),
});

const redraftPlanInput = z.object({
  scope: z.enum(["plan", "level"]),
  unit: z
    .string()
    .nullable()
    .describe('The heading whose units to re-draft, by label, e.g. "Week 3" or "Month 2 · Week 1"; null for the top level. Ignored when the scope is "plan".'),
});

/** A node named the way the learner and the plan listing name it: its own label under each heading above it, "Month 2 · Week 1". */
function pathLabel(root: PlanNode, node: PlanNode): string {
  const parts: string[] = [];
  for (let n: PlanNode | null = node; n && n.id !== root.id; n = parentOf(root, n.id)) parts.unshift(labelOf(root, n));
  return parts.join(" · ");
}

/**
 * The one heading a unit label names, or the sentence saying why none: a label matches the end of a unit's path, so
 * "Week 1" names a unit only when no other month has a Week 1. Case and spacing around the dots are ignored.
 */
function resolveUnit(root: PlanNode, unit: string, granularity: PlanChatInput["granularity"]): { node: PlanNode } | { error: string } {
  const norm = (label: string) => label.split("·").map((part) => part.trim().replace(/\s+/g, " ").toLowerCase()).join(" · ");
  const want = norm(unit);
  const matches: { node: PlanNode; path: string }[] = [];
  walk(root, (node) => {
    if (node.id === root.id) return;
    const path = pathLabel(root, node);
    const full = norm(path);
    if (full === want || full.endsWith(` · ${want}`)) matches.push({ node, path });
  });
  if (matches.length === 0) return { error: `No unit "${unit}" in the plan. Name a unit by its label as the plan lists it, e.g. "Week 3" or "Month 2 · Week 1".` };
  if (matches.length > 1) return { error: `"${unit}" names more than one unit (${matches.map((m) => m.path).join(", ")}). Name the one you mean with its full label.` };
  const { node, path } = matches[0];
  if (!childLevel(node.level) || (unitsAreLeaves(node.level, granularity) && !node.children)) return { error: `${path} is a finest unit with no level below it to re-draft. Name a heading instead, or revise it with revisePlan.` };
  return { node };
}

/** What a second plan change in one turn is told: the turn's first change has the tree. */
const TURN_ALREADY_CHANGED = "This turn already changed the plan. Tell the learner what changed, and ask them to send the next change as a new message.";

export interface RunPlanChatOptions {
  log?: GenerationLogContext;
  /** The model that answers; the app's chat model when omitted. */
  model?: ResolvedModel;
  /** The model the revision tool drafts with; the app's outline model when omitted. */
  outlineModel?: ResolvedModel;
}

/**
 * Runs one conversation turn. The model answers questions as text and calls `revisePlan` for changes; the tool runs
 * the revision generator so the whole tree is reconciled server-side before the client sees it.
 */
export type PlanChatInput = Omit<PlanChatRequest, "tree"> & { tree: PlanNode };

export async function* runPlanChat(req: PlanChatInput, options: RunPlanChatOptions = {}): AsyncGenerator<PlanChatEvent> {
  const chat = options.model ?? appModel(DEFAULT_CHAT_MODEL);
  const log = options.log;
  const startedAt = performance.now();
  const tree = layout(cloneTree(req.tree));
  const lockBefore = req.mode === "adjust" ? (req.lockBefore ?? 0) : 0;

  /** What the turn's plan change did, held until its tool result is streamed, then sent once. */
  let revised: { tree: PlanNode; changed: ChangedNodes; problems: string[] } | null = null;
  let revisionCostUsd = 0;
  /**
   * One plan change a turn: both tools draft from the turn's own tree, so a second change would drop the first. The
   * first call to start claims the turn, synchronously (the SDK may run calls at once); a call that comes back with
   * only a message for the model (an unknown unit, locked work, nothing to re-draft) releases it.
   */
  let claimed = false;

  /** The tool's answer to the chat model for a revised tree; the tree itself goes to the client as a `revised` event. */
  const settle = (result: { tree: PlanNode; problems: string[]; costUsd: number }) => {
    revisionCostUsd += result.costUsd;
    const changed = diffChangedNodes(tree, result.tree);
    revised = { tree: result.tree, changed, problems: result.problems };
    return {
      weeks: Math.round(weeksOf(result.tree, result.tree, req.daysPerWeek)),
      changedLevel: changed.level,
      changedUnits: changed.tags,
      plan: renderTree(result.tree, { daysPerWeek: req.daysPerWeek }),
    };
  };

  const revisePlan = tool({
    description:
      "Revise the plan. Call this only when the learner asks for the plan to change. Do not call it to answer questions.",
    inputSchema: revisePlanInput,
    execute: async ({ changeRequest }) => {
      if (claimed) return TURN_ALREADY_CHANGED;
      claimed = true;
      const result = await revisePlanTree({
        topic: req.topic,
        instructions: req.instructions,
        materials: req.materials,
        granularity: req.granularity,
        hoursPerWeek: req.hoursPerWeek,
        daysPerWeek: req.daysPerWeek,
        split: req.split,
        tree,
        lockBefore,
        changeRequest,
        outlineModel: options.outlineModel,
        log,
      });
      return settle(result);
    },
  });

  const redraftPlanTool = tool({
    description:
      "Re-draft the plan, or one level of it, from scratch, as a new plan is drafted: units already done or started stay. Call this only when the learner asks to regenerate, redo or re-draft the plan or part of it. For a targeted edit, call revisePlan.",
    inputSchema: redraftPlanInput,
    execute: async ({ scope, unit }) => {
      if (claimed) return TURN_ALREADY_CHANGED;
      claimed = true;
      let target: RedraftScope = { kind: "plan" };
      if (scope === "level") {
        if (unit === null) target = { kind: "level", parentId: null };
        else {
          const found = resolveUnit(tree, unit, req.granularity);
          if ("error" in found) {
            claimed = false;
            return found.error;
          }
          target = { kind: "level", parentId: found.node.id };
        }
      }
      try {
        const result = await redraftPlan({
          topic: req.topic,
          instructions: req.instructions,
          materials: req.materials,
          granularity: req.granularity,
          // Mirrors the route, which sets the request's weeks from the tree.
          weeks: Math.round(weeksOf(tree, tree, req.daysPerWeek)),
          daysPerWeek: req.daysPerWeek,
          hoursPerWeek: req.hoursPerWeek,
          split: req.split,
          tree,
          lockBefore,
          scope: target,
          outlineModel: options.outlineModel,
          log,
        });
        return settle(result);
      } catch (error) {
        if (error instanceof LockedNodeError || error instanceof NothingToRedraftError) {
          claimed = false;
          return error.message;
        }
        throw error;
      }
    },
  });

  const messages: ModelMessage[] = req.transcript.map((t) => ({ role: t.role, content: t.content }));
  const system = buildPlanChatSystemPrompt({
    mode: req.mode,
    topic: req.topic,
    instructions: req.instructions,
    materials: req.materials,
    granularity: req.granularity,
    hoursPerWeek: req.hoursPerWeek,
    daysPerWeek: req.daysPerWeek,
    split: req.split,
    tree,
    lockBefore,
  });

  const result = streamText({
    model: chat.model,
    system,
    messages,
    tools: { revisePlan, redraftPlan: redraftPlanTool },
    stopWhen: stepCountIs(2),
  });

  let usage: LanguageModelUsage | null = null;
  let text = "";
  /** Each tool call the model made, as the admin reads it: "revisePlan: <request>" / "redraftPlan: level Week 3". */
  const toolCalls: { name: string; summary: string }[] = [];
  let finishReason: string | null = null;
  /** Each request's metadata: answering after a revision is a second request, charged on its own. */
  const charged: (ProviderMetadata | undefined)[] = [];
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        if (part.text) {
          text += part.text;
          yield { type: "text", text: part.text };
        }
        break;
      case "tool-call":
        toolCalls.push({ name: part.toolName, summary: describeCall(part.toolName, part.input) });
        yield { type: "revising" };
        break;
      case "tool-result":
        if (revised) {
          const r: { tree: PlanNode; changed: ChangedNodes; problems: string[] } = revised;
          revised = null;
          yield { type: "revised", tree: r.tree, changed: r.changed, problems: r.problems, costUsd: revisionCostUsd };
        }
        break;
      case "tool-error":
        yield {
          type: "error",
          message: isGatewayOutOfFunds(part.error) ? GATEWAY_FUNDS_MESSAGE : part.error instanceof Error ? part.error.message : "Revision failed",
        };
        break;
      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      case "finish-step":
        charged.push(part.providerMetadata);
        break;
      case "finish":
        usage = part.totalUsage;
        finishReason = part.finishReason;
        break;
      default:
        break;
    }
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  let chatCostUsd = 0;
  const toolNames = [...new Set(toolCalls.map((c) => c.name))];
  if (usage) {
    const row = buildGenerationLogRow({ caller: "chat", model: chat.id, keyOwner: chat.keyOwner, usage, latencyMs, providerMetadata: charged, trackId: log?.trackId, userId: log?.userId });
    chatCostUsd = row.costUsd ?? 0;
    await emitGenerationLog(log?.onLog, row);
    log?.onCall?.({
      ...row,
      label: toolCalls.length > 0 ? `Answer · ${toolNames.join(" + ")}` : "Answer",
      system,
      prompt: renderTranscript(messages),
      response: toolCalls.length > 0 ? `${text}${toolCalls.map((c) => `\n\n[tool call] ${c.name}: ${c.summary}`).join("")}` : text,
      finishReason,
      facts: [
        `${messages.length} transcript turn${messages.length === 1 ? "" : "s"}`,
        toolCalls.length > 0 ? `tool: ${toolNames.join(" + ")}` : "no tool call",
      ],
    });
  }
  yield { type: "finish", costUsd: chatCostUsd + revisionCostUsd };
}

function describeCall(name: string, input: unknown): string {
  if (name === "redraftPlan") {
    const { scope, unit } = (input ?? {}) as { scope?: string; unit?: string | null };
    return scope === "level" ? `level ${unit ?? "(top)"}` : "plan";
  }
  return (input as { changeRequest?: string } | undefined)?.changeRequest ?? "";
}

/** The transcript as an admin reads it: each turn under its role, oldest first. */
export function renderTranscript(messages: ModelMessage[]): string {
  return messages
    .map((m) => `[${m.role}]\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2)}`)
    .join("\n\n");
}
