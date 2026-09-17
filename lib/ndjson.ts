/**
 * Newline-delimited JSON over a streaming Response. Server side wraps an async iterable of events; client side
 * reads them back one at a time. Kept dependency-free so both routes and the browser share it.
 */

export function ndjsonResponse<T>(events: AsyncIterable<T>, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "stream failed";
        controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message }) + "\n"));
      } finally {
        controller.close();
      }
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
