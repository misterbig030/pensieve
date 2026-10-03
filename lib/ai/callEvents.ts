import type { GenerationLogContext, ModelCall } from "./logged";

/** Streamed to the browser only for admins who asked: one per model call, with the exact prompt and raw response. */
export type CallEvent = { type: "call"; call: ModelCall };

/**
 * Runs a generator with a log context that also captures whole model calls, and interleaves each captured call into
 * the stream as a `call` event just before the next event the generator yields (or at the end). Disabled, the
 * generator runs untouched and nothing extra is sent.
 */
export function withCallEvents<T>(
  enabled: boolean,
  log: GenerationLogContext,
  run: (log: GenerationLogContext) => AsyncIterable<T>,
): AsyncIterable<T | CallEvent> {
  if (!enabled) return run(log);
  const queue: ModelCall[] = [];
  const inner = run({
    ...log,
    onCall: (call) => {
      log.onCall?.(call);
      queue.push(call);
    },
  });
  return (async function* () {
    for await (const event of inner) {
      while (queue.length > 0) yield { type: "call", call: queue.shift()! } as CallEvent;
      yield event;
    }
    while (queue.length > 0) yield { type: "call", call: queue.shift()! } as CallEvent;
  })();
}
