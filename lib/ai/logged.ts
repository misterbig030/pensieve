import { generateObject, type FlexibleSchema, type LanguageModel, type LanguageModelUsage, type ProviderMetadata } from "ai";
import type { GenerationCaller } from "@/lib/db/schema";
import type { OnServiceEvent } from "./serviceEvents";
import { estimateCostUsd, type AiModelId, type KeyOwner, type ReasoningEffort } from "./models";

export type { GenerationCaller };

/** Whether a model is Anthropic's: a gateway id ("anthropic/claude-opus-5.5"), or an API id on a user's own key ("claude-sonnet-5-5"). */
export function isAnthropicModel(model: AiModelId | LanguageModel): boolean {
  const id = typeof model === "string" ? model : model.modelId;
  return id.startsWith("anthropic/") || id.startsWith("claude-");
}

/**
 * The call settings that set reasoning effort on one call. Anthropic models get their own provider option, as they
 * always have; every other provider gets the AI SDK's portable `reasoning` setting, which the Anthropic key would ignore
 * and those providers would otherwise never see.
 */
export function effortSettings(
  effort: ReasoningEffort,
  model: AiModelId | LanguageModel,
): { providerOptions: { anthropic: { effort: ReasoningEffort } } } | { reasoning: ReasoningEffort } {
  return isAnthropicModel(model) ? { providerOptions: { anthropic: { effort } } } : { reasoning: effort };
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
  /** What the AI Gateway charged for the call. Null when it didn't go through the gateway (the user's own key). */
  costUsd: number | null;
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
  /** When the call finished (ms since the epoch), stamped as it is handed to the admin; with `latencyMs` it places the call in time. */
  endedAt?: number;
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
  /** Receives a report of each failed request to an outside service (Anthropic, Open Library, search). Omitted means none are reported. */
  onService?: OnServiceEvent;
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
  /** More checks computed from the validated object, appended to `facts`. Runs on every call, logged or not. */
  check?: (object: T) => string[];
  abortSignal?: AbortSignal;
  /** Retries on a failed request; the AI SDK's default (2) when omitted. */
  maxRetries?: number;
  /** Reasoning effort for this call, sent the way the model's provider takes it and recorded on the row. Omitted: the model's default. */
  effort?: ReasoningEffort;
  /** Who pays for this call when it differs from the context (a resolved model carries its own). */
  keyOwner?: KeyOwner;
}

export interface LoggedGenerateObjectResult<T> {
  object: T;
  usage: LanguageModelUsage;
  latencyMs: number;
  /** What Pensieve paid: the gateway's charge, 0 on the user's own key. */
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
  /** The provider metadata of each request the row covers (a chat answer can take two). */
  providerMetadata?: ProviderMetadata | readonly (ProviderMetadata | undefined)[];
  /** The cost to record when no request reports a gateway charge: a failed call's estimate, since its error has no metadata. */
  fallbackCostUsd?: number | null;
}

/** What the AI Gateway charged for these requests, from the `cost` it reports on each; null when none reports one. */
export function gatewayCostUsd(metadata: ProviderMetadata | readonly (ProviderMetadata | undefined)[] | undefined): number | null {
  const each = Array.isArray(metadata) ? metadata : [metadata as ProviderMetadata | undefined];
  const costs = each.map((m) => Number(m?.gateway?.cost ?? NaN)).filter(Number.isFinite);
  return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
}

/** Normalizes the AI SDK usage shape into a flat `generation_log` row. Shared by the object wrapper and the streaming routes. */
export function buildGenerationLogRow(input: BuildGenerationLogRowInput): GenerationLogRow {
  const { usage } = input;
  const keyOwner = input.keyOwner ?? "app";
  const costUsd = gatewayCostUsd(input.providerMetadata) ?? input.fallbackCostUsd ?? null;
  if (costUsd === null && keyOwner === "app") {
    console.warn("[generation_log] the gateway reported no cost for a call on Pensieve's key: it counts as nothing against credits", { caller: input.caller, model: input.model });
  }
  return {
    caller: input.caller,
    model: input.model,
    effort: input.effort ?? null,
    keyOwner,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
    costUsd,
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
 * Records a failed call when the error carries usage, as the AI SDK's `NoObjectGeneratedError` does for an answer that
 * did not fit the schema: the model was paid for, so its row goes to `onLog` like any other spend, and `meta.onCall` sees
 * it with the error as its response. The error carries no gateway metadata, so on Pensieve's key the row's cost is the
 * list-price estimate. A failure with no usage (a timeout, a refused request) is not recorded.
 */
async function reportFailedCall<T>(opts: LoggedGenerateObjectOptions<T>, meta: GenerationLogMeta, error: unknown, latencyMs: number): Promise<void> {
  if (typeof error !== "object" || error === null) return;
  const { usage, finishReason, message } = error as { usage?: LanguageModelUsage; finishReason?: string; message?: unknown };
  if (typeof usage !== "object" || usage === null) return;
  const keyOwner = opts.keyOwner ?? meta.keyOwner ?? "app";
  const row = buildGenerationLogRow({
    caller: meta.caller,
    model: opts.model,
    usage,
    latencyMs,
    effort: opts.effort ?? null,
    keyOwner,
    trackId: meta.trackId,
    userId: meta.userId,
    fallbackCostUsd:
      keyOwner === "app"
        ? estimateCostUsd(opts.model, {
            inputTokens: usage.inputTokens ?? null,
            outputTokens: usage.outputTokens ?? null,
            cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
          })
        : null,
  });
  await emitGenerationLog(meta.onLog, row);
  meta.onCall?.({
    ...row,
    label: opts.label ?? meta.caller,
    system: null,
    prompt: opts.prompt,
    response: typeof message === "string" ? message : String(error),
    finishReason: finishReason ?? null,
    facts: [...(opts.facts ?? []), "the call failed"],
  });
}

/**
 * Wraps `generateObject`: times the call, records what the gateway charged, and hands a normalized row to `meta.onLog`.
 * A failing `onLog` is reported and swallowed so telemetry never breaks a user-facing generation.
 */
export async function loggedGenerateObject<T>(
  opts: LoggedGenerateObjectOptions<T>,
  meta: GenerationLogMeta,
): Promise<LoggedGenerateObjectResult<T>> {
  const startedAt = performance.now();
  let generated: Awaited<ReturnType<typeof generateObject>>;
  try {
    generated = await generateObject({
      model: opts.languageModel ?? opts.model,
      schema: opts.schema,
      prompt: opts.prompt,
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.effort ? effortSettings(opts.effort, opts.model) : {}),
    });
  } catch (error) {
    await reportFailedCall(opts, meta, error, Math.round(performance.now() - startedAt));
    throw error;
  }
  const { object, usage, finishReason, providerMetadata } = generated;
  const latencyMs = Math.round(performance.now() - startedAt);
  const row = buildGenerationLogRow({
    caller: meta.caller,
    model: opts.model,
    usage,
    latencyMs,
    providerMetadata,
    effort: opts.effort ?? null,
    keyOwner: opts.keyOwner ?? meta.keyOwner,
    trackId: meta.trackId,
    userId: meta.userId,
  });
  await emitGenerationLog(meta.onLog, row);
  // Run whether or not anyone collects the call: a caller's check may do the work it reports on (a revision applies its tree there).
  const checked = opts.check?.(object as T) ?? [];
  meta.onCall?.({
    ...row,
    label: opts.label ?? meta.caller,
    system: null,
    prompt: opts.prompt,
    response: JSON.stringify(object, null, 2),
    finishReason: finishReason ?? null,
    facts: [...(opts.facts ?? []), ...checked],
  });
  const costUsd = row.costUsd ?? 0;

  return { object: object as T, usage, latencyMs, costUsd };
}
