/**
 * The workspace's re-draft after an hours or split change: wait for the learner to settle, re-draft the open part of
 * the plan, and put the result in as an undoable change. Kept out of the component so the timing can be tested.
 */
import type { ModelCall } from "@/lib/ai/logged";
import { readNdjson } from "@/lib/ndjson";
import { nextMessageId, problemsText, type ChatMessage, type PlanRedraftEvent, type PlanRedraftRequest } from "@/lib/planChat";
import { layout, type PlanNode } from "@/lib/planTree";
import { diffChangedNodes, latestChangeNote } from "@/lib/planSummary";

/** How long the hours and split pickers wait after the last change before re-drafting. */
export const REDRAFT_DEBOUNCE_MS = 1500;

/** What the learner changed, for the conversation's line. */
export type RedraftChange = { kind: "hours"; hours: number } | { kind: "split" };

export interface RedraftResult {
  tree: PlanNode;
  problems: string[];
  costUsd: number;
}

export interface RedraftScheduler<T> {
  /** Re-drafts for `value` once the window passes; a pending one is replaced and a running one aborted. */
  schedule(value: T): void;
  /** Drops the pending re-draft and aborts the running one. */
  cancel(): void;
}

/**
 * One re-draft at a time, for the latest value. A change inside the window replaces the pending one; a change while a
 * re-draft runs aborts it (its answer, or its failure, is ignored) and schedules a new one. `onBusy` is true from a
 * change until the last re-draft settles, even when `onDone` or `onFail` throws; that error goes to `onError`
 * (`console.error` when omitted).
 */
export function createRedraftScheduler<T, R>(options: {
  run: (value: T, signal: AbortSignal) => Promise<R>;
  onDone: (value: T, result: R) => void;
  onFail: (value: T, error: unknown) => void;
  onBusy: (busy: boolean) => void;
  onError?: (error: unknown) => void;
  delay?: number;
}): RedraftScheduler<T> {
  const delay = options.delay ?? REDRAFT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: AbortController | null = null;

  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    running?.abort();
    running = null;
  };

  const fire = (value: T) => {
    timer = null;
    const controller = new AbortController();
    running = controller;
    // An aborted run settles nothing: the change that aborted it owns the busy state.
    const settle = (put: () => void) => {
      if (controller.signal.aborted) return;
      running = null;
      try {
        put();
      } finally {
        options.onBusy(false);
      }
    };
    options
      .run(value, controller.signal)
      .then(
        (result) => settle(() => options.onDone(value, result)),
        (error: unknown) => settle(() => options.onFail(value, error)),
      )
      .catch(options.onError ?? ((error: unknown) => console.error(error)));
  };

  return {
    schedule(value) {
      stop();
      options.onBusy(true);
      timer = setTimeout(() => fire(value), delay);
    },
    cancel() {
      stop();
      options.onBusy(false);
    },
  };
}

/** Asks the server to re-draft; resolves with the new plan, or fails with the learner's message (and a key or credits code). */
export async function requestRedraft(
  body: PlanRedraftRequest,
  options: { signal: AbortSignal; fetch?: typeof fetch; onCall?: (call: ModelCall) => void },
): Promise<RedraftResult> {
  const response = await (options.fetch ?? fetch)("/api/plan/redraft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  let result: RedraftResult | null = null;
  await readNdjson<PlanRedraftEvent>(response, (event) => {
    if (event.type === "call") options.onCall?.(event.call);
    else if (event.type === "redrafted") result = { tree: event.tree, problems: event.problems, costUsd: event.costUsd };
    else if (event.type === "error") throw Object.assign(new Error(event.message), { code: event.code });
  });
  if (!result) throw new Error("The re-draft ended early. Try again.");
  return result;
}

/** The conversation's line for a re-draft. */
export function redraftedText(change: RedraftChange): string {
  return change.kind === "hours" ? `Re-drafted the open weeks for ${change.hours} h a week.` : "Re-drafted the open weeks for the new time split.";
}

/**
 * The workspace after a re-draft, as after a chat revision: the new tree, an undoable change holding the tree before,
 * then the problems the checks found, if any.
 */
export function applyRedraft(
  before: { tree: PlanNode; summaryNote: string },
  change: RedraftChange,
  result: RedraftResult,
): { tree: PlanNode; messages: ChatMessage[]; highlight: string[]; summaryNote: string } {
  const tree = layout(result.tree);
  const changed = diffChangedNodes(before.tree, tree);
  const text = redraftedText(change);
  const messages: ChatMessage[] = [
    {
      id: nextMessageId(),
      kind: "change",
      text,
      level: changed.level,
      nodeIds: changed.ids,
      tags: changed.tags,
      prevTree: before.tree,
      prevNote: before.summaryNote,
      undone: false,
      streaming: false,
    },
  ];
  const found = problemsText(result.problems);
  if (found) messages.push({ id: nextMessageId(), kind: "sys", text: found });
  return { tree, messages, highlight: changed.ids, summaryNote: latestChangeNote(text) };
}
