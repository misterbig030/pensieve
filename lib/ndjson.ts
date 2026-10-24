import { KEY_ERRORS } from "@/lib/ai/models";

/**
 * Newline-delimited JSON over a streaming Response. Server side wraps an async iterable of events; client side
 * reads them back one at a time. Kept dependency-free so both routes and the browser share it.
 */

export function ndjsonResponse<T>(events: AsyncIterable<T>, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  // A reader that goes away cancels the stream: the events stop at their next step instead of running to the end.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { value, done } = await iterator.next();
          if (done || cancelled) break;
          controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "stream failed";
        // A code names a failure the client can act on (a refused user key). System errors carry codes too
        // ("ECONNRESET", a Postgres "42703"); those must not reach the client as something to act on.
        const rawCode = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
        const code = typeof rawCode === "string" && (KEY_ERRORS as readonly string[]).includes(rawCode) ? rawCode : undefined;
        controller.enqueue(encoder.encode(JSON.stringify(code ? { type: "error", message, code } : { type: "error", message }) + "\n"));
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      void iterator.return?.(undefined)?.catch(() => {});
    },
  });
  return new Response(stream, {
    ...init,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });
}

/** Reads an NDJSON body, invoking `onEvent` per line. Resolves when the stream ends; rejects on a non-2xx status. */
export async function readNdjson<T>(response: Response, onEvent: (event: T) => void): Promise<void> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  if (!response.body) throw new Error("Response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as T);
      newline = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail) onEvent(JSON.parse(tail) as T);
}
