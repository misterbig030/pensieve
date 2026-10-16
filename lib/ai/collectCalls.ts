import type { GenerationLogContext, ModelCall } from "./logged";

/**
 * The server-action twin of `withCallEvents`: a log context whose model calls land in `sink` when `enabled`, for the
 * action to return to an admin with its result. The action keeps `sink` in scope, so calls made before a refusal are
 * still there to return with the refusal. Disabled, the context is handed back untouched and nothing is collected.
 */
export function collectCalls(enabled: boolean, log: GenerationLogContext, sink: ModelCall[]): GenerationLogContext {
  if (!enabled) return log;
  return {
    ...log,
    onCall: (call) => {
      log.onCall?.(call);
      sink.push(call);
    },
  };
}
