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
  /** When it happened (epoch ms): stamped as it is queued, since the stream sends it later, beside the next event. */
  at?: number;
}

export type OnServiceEvent = (event: ServiceEvent) => void;

const REASON_MAX = 200;

export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, REASON_MAX);
}

/**
 * A request ended by its step's own signal: the request going away, a loop that stopped, or one of our own time
 * limits (the structure finder's clock, the end of the structure stage, the draft's deadline). Not the service's
 * failure, whatever the error is called: our own limits abort with a TimeoutError too. A request timeout that is not
 * ours (the provider's, the SDK's) leaves the signal standing, and still counts.
 */
export function cancelledByCaller(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/**
 * Wraps a model so each failed attempt (including ones the SDK goes on to retry) is reported to `onService` before
 * the error is rethrown. Successful attempts report nothing: the eval only needs to see what went wrong.
 */
export function reportingModel(model: AiModelId | LanguageModel, onService: OnServiceEvent): LanguageModel {
  const inner = typeof model === "string" ? gateway(model) : model;
  const failed = (error: unknown, startedAt: number, signal: AbortSignal | undefined): never => {
    // An attempt its own signal ended did not fail, a timeout of ours included.
    if (cancelledByCaller(signal)) throw error;
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
      wrapGenerate: async ({ doGenerate, params }) => {
        const startedAt = performance.now();
        try {
          return await doGenerate();
        } catch (error) {
          return failed(error, startedAt, params.abortSignal);
        }
      },
      wrapStream: async ({ doStream, params }) => {
        const startedAt = performance.now();
        try {
          return await doStream();
        } catch (error) {
          return failed(error, startedAt, params.abortSignal);
        }
      },
    },
  });
}

/** The errors already reported as a final failure: one error reaches several nested catch sites, but is one failure. */
const reported = new WeakSet<object>();

/**
 * Reports that a step gave up on Anthropic: the provider refused it or it timed out. Anything else (a bad output, a
 * bug) is not the service's fault and reports nothing, and neither does a call `signal` ended: the signal the step's
 * call ran under, so one of our own time limits is never taken for Anthropic failing. `ms` is 0 because the failed
 * attempts already carry the timing.
 */
export function reportServiceFailure(log: GenerationLogContext | undefined, error: unknown, where: string, signal?: AbortSignal): void {
  if (!log?.onService || cancelledByCaller(signal)) return;
  const refusal = providerError(error);
  if (!refusal && !isTimeout(error)) return;
  const key = (refusal ?? error) as object;
  if (reported.has(key)) return;
  reported.add(key);
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
