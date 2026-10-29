import { gateway, wrapLanguageModel, type LanguageModel } from "ai";
import type { GenerationLogContext } from "./logged";
import type { AiModelId } from "./models";
import { providerError } from "./providerError";

export type ServiceName = "anthropic" | "openlibrary" | "search";

/** One request to an outside service: whether it worked, how long it took, and why not when it didn't. */
export interface ServiceEvent {
  type: "service";
  name: ServiceName;
  ok: boolean;
  /** True when the request was given up on (retries spent); false for an attempt that may still be retried. */
  final: boolean;
  ms: number;
  status?: number;
  reason?: string;
  /** The step that gave up, for a final failure ("structure", "outline"). */
  where?: string;
}

export type OnServiceEvent = (event: ServiceEvent) => void;

const REASON_MAX = 200;

export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, REASON_MAX);
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/**
 * Wraps a model so each failed attempt (including ones the SDK goes on to retry) is reported to `onService` before
 * the error is rethrown. Successful attempts report nothing: the eval only needs to see what went wrong.
 */
export function reportingModel(model: AiModelId | LanguageModel, onService: OnServiceEvent): LanguageModel {
  const inner = typeof model === "string" ? gateway(model) : model;
  const failed = (error: unknown, startedAt: number): never => {
    const refusal = providerError(error);
    onService({
      type: "service",
      name: "anthropic",
      ok: false,
      final: false,
      ms: Math.round(performance.now() - startedAt),
      ...(refusal?.statusCode !== undefined ? { status: refusal.statusCode } : {}),
      reason: reasonOf(refusal ?? error),
    });
    throw error;
  };
  return wrapLanguageModel({
    model: inner as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        const startedAt = performance.now();
        try {
          return await doGenerate();
        } catch (error) {
          return failed(error, startedAt);
        }
      },
      wrapStream: async ({ doStream }) => {
        const startedAt = performance.now();
        try {
          return await doStream();
        } catch (error) {
          return failed(error, startedAt);
        }
      },
    },
  });
}

/**
 * Reports that a step gave up on Anthropic: the provider refused it or it timed out. Anything else (a bad output, a
 * bug) is not the service's fault and reports nothing. `ms` is 0 because the failed attempts already carry the timing.
 */
export function reportServiceFailure(log: GenerationLogContext | undefined, error: unknown, where: string): void {
  if (!log?.onService) return;
  const refusal = providerError(error);
  if (!refusal && !isTimeout(error)) return;
  log.onService({
    type: "service",
    name: "anthropic",
    ok: false,
    final: true,
    ms: 0,
    ...(refusal?.statusCode !== undefined ? { status: refusal.statusCode } : {}),
    reason: reasonOf(refusal ?? error),
    where,
  });
}
