import type { GenerationLogContext, ModelCall } from "./logged";
import type { ServiceEvent } from "./serviceEvents";

/** Streamed to the browser only for admins who asked: one per model call, with the exact prompt and raw response. */
export type CallEvent = { type: "call"; call: ModelCall };

/**
 * Runs a generator with a log context that also captures whole model calls and failed service requests, and
 * interleaves each into the stream, in the order they happened, as a `call` or `service` event just before the next
 * event the generator yields (or at the end, including when the generator throws). Disabled, the generator runs untouched and nothing extra is sent.
 */
export function withCallEvents<T>(
  enabled: boolean,
  log: GenerationLogContext,
  run: (log: GenerationLogContext) => AsyncIterable<T>,
): AsyncIterable<T | CallEvent | ServiceEvent> {
  if (!enabled) return run(log);
  const queue: (CallEvent | ServiceEvent)[] = [];
  const inner = run({
    ...log,
    onCall: (call) => {
      log.onCall?.(call);
      queue.push({ type: "call", call });
    },
    onService: (event) => {
      log.onService?.(event);
      queue.push(event);
    },
  });
  return (async function* () {
    try {
      for await (const event of inner) {
        while (queue.length > 0) yield queue.shift()!;
        yield event;
      }
    } finally {
      // Also when the generator throws: the calls made before the failure are the evidence for it.
      while (queue.length > 0) yield queue.shift()!;
    }
  })();
}
