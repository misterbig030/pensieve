import { generateObject, type FlexibleSchema, type LanguageModelUsage } from "ai";
import type { GenerationCaller } from "@/lib/db/schema";
import { estimateCostUsd, type AiModelId } from "./models";

export type { GenerationCaller };

/** One normalized `generation_log` row, ready to insert. Kept free of DB types so the eval harness can collect them in memory. */
export interface GenerationLogRow {
  caller: GenerationCaller;
  model: AiModelId;
  effort: string | null;
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

/** Who is calling and where to send the log row. `onLog` omitted means no side effect (eval harness, tests). */
export interface GenerationLogMeta {
  caller: GenerationCaller;
  trackId?: string;
  userId?: string;
  onLog?: OnGenerationLog;
}

/** The subset of `GenerationLogMeta` that callers of the generators supply; the generator fills in `caller`. */
export type GenerationLogContext = Omit<GenerationLogMeta, "caller">;

export interface LoggedGenerateObjectOptions<T> {
  model: AiModelId;
  schema: FlexibleSchema<T>;
  prompt: string;
}

export interface LoggedGenerateObjectResult<T> {
  object: T;
  usage: LanguageModelUsage;
  latencyMs: number;
  costUsd: number;
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
  const { object, usage } = await generateObject({
    model: opts.model,
    schema: opts.schema,
    prompt: opts.prompt,
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const costUsd = estimateCostUsd(opts.model, usage);

  if (meta.onLog) {
    const row: GenerationLogRow = {
      caller: meta.caller,
      model: opts.model,
      effort: null,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
      costUsd,
      latencyMs,
      trackId: meta.trackId ?? null,
      userId: meta.userId ?? null,
    };
    try {
      await meta.onLog(row);
    } catch (error) {
      console.error("[generation_log] failed to record row", { caller: meta.caller, model: opts.model }, error);
    }
  }

  return { object: object as T, usage, latencyMs, costUsd };
}
