import type { ModelCall } from "@/lib/ai/logged";
import type { Granularity, PlanLevel, PlanNode } from "@/lib/planTree";
import type { ChangedNodes } from "@/lib/planSummary";
import type { PlanTreeInput } from "@/lib/schemas/plan";
import type { SourceInput } from "@/lib/schemas/source";

export type { ModelCall };

/** Admins only: one model call with its exact prompt and raw response. Sent when the request set `debug` and the server agrees. */
export type CallEvent = { type: "call"; call: ModelCall };

/** Messages shown in the conversation rail. Kept as plain data so the rail is a pure render of this list. */
export type ChatMessage =
  | { id: string; kind: "sys"; text: string }
  | { id: string; kind: "brief"; topic: string; days: number; granularity: Granularity; focus?: string; materials: SourceInput[] }
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "answer"; text: string; streaming: boolean }
  | {
      id: string;
      kind: "change";
      text: string;
      level: PlanLevel;
      nodeIds: string[];
      tags: string[];
      prevTree: PlanNode;
      prevNote: string;
      undone: boolean;
      streaming: boolean;
    };

export interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
}

interface PlanContext {
  topic: string;
  /** Total length of the plan in days. */
  days: number;
  granularity: Granularity;
  instructions?: string;
  sources: SourceInput[];
  /** Ask for a `call` event per model call. Honoured only for admins; ignored for everyone else. */
  debug?: boolean;
}

/** Request body for POST /api/plan/draft. */
export type PlanDraftRequest = PlanContext;

/** Events streamed back from POST /api/plan/draft. Nodes arrive one at a time, each placed under `parentId`. */
export type PlanDraftEvent =
  | { type: "node"; parentId: string; node: PlanNode }
  | { type: "finish"; root: PlanNode; costUsd: number }
  | { type: "error"; message: string }
  | CallEvent;

/** Request body for POST /api/plan/expand: plan the children of one node of the draft. */
export interface PlanExpandRequest extends PlanContext {
  /** The draft as `planTreeInputSchema` (top-level units, derived fields stripped). */
  tree: PlanTreeInput;
  nodeId: string;
  /** `split` turns a week leaf into day leaves by hand; `expand` plans a heading's children. */
  reason: "expand" | "split";
}

export type PlanExpandEvent =
  | { type: "child"; node: PlanNode }
  | { type: "finish"; children: PlanNode[]; costUsd: number }
  | { type: "error"; message: string }
  | CallEvent;

/** Request body for POST /api/plan/chat. */
export interface PlanChatRequest extends PlanContext {
  mode: "create" | "adjust";
  tree: PlanTreeInput;
  /** Adjust mode only: the last completed day; nothing on or before it may change. */
  lockBefore?: number;
  trackId?: string;
  /** Prior turns, oldest first. The latest user message must be last. */
  transcript: TranscriptTurn[];
}

/** Events streamed back from POST /api/plan/chat. */
export type PlanChatEvent =
  | { type: "text"; text: string }
  | { type: "revising" }
  | { type: "revised"; tree: PlanNode; changed: ChangedNodes; costUsd: number }
  | { type: "finish"; costUsd: number }
  | { type: "error"; message: string }
  | CallEvent;

let counter = 0;
export function nextMessageId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export function describeBrief(m: Extract<ChatMessage, { kind: "brief" }>): string {
  const lines = [`Topic: ${m.topic}`, `Length: ${m.days} days, planned in ${m.granularity} units`];
  if (m.focus?.trim()) lines.push(`Focus: ${m.focus.trim()}`);
  if (m.materials.length > 0) lines.push(`Materials: ${m.materials.map((s) => s.title ?? s.url).join("; ")}`);
  return lines.join("\n");
}

/**
 * Flattens rail messages into the user/assistant transcript the model sees. Change turns become assistant text so
 * later turns know what already happened; sys lines are covered by the system prompt and skipped.
 */
export function toTranscript(messages: ChatMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const m of messages) {
    switch (m.kind) {
      case "brief":
        turns.push({ role: "user", content: describeBrief(m) });
        break;
      case "user":
        turns.push({ role: "user", content: m.text });
        break;
      case "answer":
        if (m.text.trim()) turns.push({ role: "assistant", content: m.text });
        break;
      case "change":
        turns.push({
          role: "assistant",
          content: m.undone
            ? `[Plan change undone by the learner] ${m.text}`
            : `[Plan changed at the ${m.level} level — ${m.tags.join(", ") || "n/a"}] ${m.text}`,
        });
        break;
      case "sys":
        break;
    }
  }
  return turns;
}

/** Only the most recent non-undone change can be undone. */
export function undoableChangeId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "change" && !m.undone) return m.id;
  }
  return null;
}

export function hasUserTurn(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.kind === "user");
}
