import { describe, expect, it } from "vitest";
import { ndjsonResponse, readNdjson } from "./ndjson";

async function* events() {
  yield { type: "a", n: 1 };
  yield { type: "b", text: "line with\nnewline escaped" };
}

describe("ndjson round trip", () => {
  it("streams events and reads them back in order", async () => {
    const response = ndjsonResponse(events());
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const seen: unknown[] = [];
    await readNdjson(response, (e) => seen.push(e));
    expect(seen).toEqual([
      { type: "a", n: 1 },
      { type: "b", text: "line with\nnewline escaped" },
    ]);
  });

  it("turns a generator failure into a trailing error event", async () => {
    async function* failing() {
      yield { type: "a" };
      throw new Error("boom");
    }
    const seen: { type: string; message?: string }[] = [];
    await readNdjson(ndjsonResponse(failing()), (e: { type: string; message?: string }) => seen.push(e));
    expect(seen).toEqual([{ type: "a" }, { type: "error", message: "boom" }]);
  });

  it("handles chunks that split a line", async () => {
    const encoder = new TextEncoder();
    const parts = ['{"type":"a","x":', "1}\n{\"type\":\"b\"}"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(encoder.encode(p));
        c.close();
      },
    });
    const seen: unknown[] = [];
    await readNdjson(new Response(body), (e) => seen.push(e));
    expect(seen).toEqual([{ type: "a", x: 1 }, { type: "b" }]);
  });

  it("rejects on a non-2xx response", async () => {
    await expect(readNdjson(new Response("nope", { status: 401 }), () => {})).rejects.toThrow("nope");
  });
});
