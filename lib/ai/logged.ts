import { generateObject, type FlexibleSchema, type LanguageModel, type LanguageModelUsage } from "ai";
import type { GenerationCaller } from "@/lib/db/schema";
import { estimateCostUsd, type AiModelId, type KeyOwner, type ReasoningEffort } from "./models";

export type { GenerationCaller };

/** The provider options that set Anthropic's reasoning effort on one call. Other providers ignore the key. */
export function effortOptions(effort: ReasoningEffort): { anthropic: { effort: ReasoningEffort } } {
  return { anthropic: { effort } };
}

/** One normalized `generation_log` row, ready to insert. Kept free of DB types so the eval harness can collect them in memory. */
export interface GenerationLogRow {
  caller: GenerationCaller;
  model: AiModelId;
  effort: string | null;
  /** Who paid for the call: the app's gateway key, or the user's own key. */
  keyOwner: KeyOwner;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number;
  latencyMs: number;
  trackId: string | null;
  userId: string | null;
}

export type OnGenerationLog = (row: GenerationLogRow) => void | Promise<void>;

/** A whole model call as the admin panel shows it: the log row plus what went in and what came back. Never stored. */
export interface ModelCall extends GenerationLogRow {
  /** What the call was for, in the app's words ("Top level · 4 weeks", "Revision", "Answer"). */
  label: string;
  /** The system prompt when the call has one (chat); null for single-prompt calls. */
  system: string | null;
  /** The user-side prompt: the single prompt for object calls, the transcript for chat. */
  prompt: string;
  /** The raw model output before the app reconciled it: JSON for object calls, text plus tool calls for chat. */
  response: string;
  finishReason: string | null;
  /** Short checks the generator can state about the response ("4 of 4 units", "spans kept"). */
  facts: string[];
}

export type OnModelCall = (call: ModelCall) => void;

/** Who is calling and where to send the log row. `onLog` omitted means no side effect (eval harness, tests). */
export interface GenerationLogMeta {
  caller: GenerationCaller;
  trackId?: string;
  userId?: string;
  onLog?: OnGenerationLog;
  /** Receives the full call (prompt and raw response) for the admin panel. Omitted means nothing is captured. */
  onCall?: OnModelCall;
  /** Who pays for the calls in this request; "app" when omitted. The resolver sets it from the user's keys. */
  keyOwner?: KeyOwner;
}

/** The subset of `GenerationLogMeta` that callers of the generators supply; the generator fills in `caller`. */
export type GenerationLogContext = Omit<GenerationLogMeta, "caller">;

export interface LoggedGenerateObjectOptions<T> {
  model: AiModelId;
  /** Runs the call on this model instance instead of `model` through the gateway; `model` still names it in the log. */
  languageModel?: LanguageModel;
  schema: FlexibleSchema<T>;
  prompt: string;
  /** Shown in the admin panel's call list; defaults to the caller name. */
  label?: string;
  /** Short checks shown beside the raw response in the admin panel. */
  facts?: string[];
  /** More checks computed from the validated object, appended to `facts`. */
  check?: (object: T) => string[];
  abortSignal?: AbortSignal;
  /** Retries on a failed request; the AI SDK's default (2) when omitted. */
  maxRetries?: number;
  /** Anthropic reasoning effort for this call, sent as a provider option and recorded on the row. Omitted: the model's default. */
  effort?: ReasoningEffort;
  /** Who pays for this call when it differs from the context (a resolved model carries its own). */
  keyOwner?: KeyOwner;
}

export interface LoggedGenerateObjectResult<T> {
  object: T;
  usage: LanguageModelUsage;
  latencyMs: number;
  costUsd: number;
}

export interface BuildGenerationLogRowInput {
  caller: GenerationCaller;
  model: AiModelId;
  usage: LanguageModelUsage;
  latencyMs: number;
  trackId?: string;
  userId?: string;
  effort?: ReasoningEffort | null;
  keyOwner?: KeyOwner;
}

/** Normalizes the AI SDK usage shape into a flat `generation_log` row. Shared by the object wrapper and the streaming routes. */
export function buildGenerationLogRow(input: BuildGenerationLogRowInput): GenerationLogRow {
  const { usage } = input;
  return {
    caller: input.caller,
    model: input.model,
    effort: input.effort ?? null,
    keyOwner: input.keyOwner ?? "app",
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
    costUsd: estimateCostUsd(input.model, usage),
    latencyMs: input.latencyMs,
    trackId: input.trackId ?? null,
    userId: input.userId ?? null,
  };
}

/** Invokes `onLog` and reports (never throws) so telemetry can't break a user-facing generation. */
export async function emitGenerationLog(onLog: OnGenerationLog | undefined, row: GenerationLogRow): Promise<void> {
  if (!onLog) return;
  try {
    await onLog(row);
  } catch (error) {
    console.error("[generation_log] failed to record row", { caller: row.caller, model: row.model }, error);
  }
}

/**
 * Wraps `generateObject`: times the call, computes list-price cost, and hands a normalized row to `meta.onLog`.
 * A failing `onLog` is reported and swallowed so telemetry never breaks a user-facing generation.
 */
export async function loggedGenerateObject<T>(
  opts: LoggedGenerateObjectOptions<T>,
  meta: GenerationLogMeta,
): Promise<LoggedGenerateObjectResult<T>> {
  const startedAt = performance.now();
  const { object, usage, finishReason } = await generateObject({
    model: opts.languageModel ?? opts.model,
    schema: opts.schema,
    prompt: opts.prompt,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.effort ? { providerOptions: effortOptions(opts.effort) } : {}),
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const row = buildGenerationLogRow({
    caller: meta.caller,
    model: opts.model,
    usage,
    latencyMs,
    effort: opts.effort ?? null,
    keyOwner: opts.keyOwner ?? meta.keyOwner,
    trackId: meta.trackId,
    userId: meta.userId,
  });
  await emitGenerationLog(meta.onLog, row);
  meta.onCall?.({
    ...row,
    label: opts.label ?? meta.caller,
    system: null,
    prompt: opts.prompt,
    response: JSON.stringify(object, null, 2),
    finishReason: finishReason ?? null,
    facts: [...(opts.facts ?? []), ...(opts.check?.(object as T) ?? [])],
  });
  const costUsd = row.costUsd;

  return { object: object as T, usage, latencyMs, costUsd };
}
