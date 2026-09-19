import { describe, expect, it, vi } from "vitest";
import { withCallEvents } from "./callEvents";
import type { GenerationLogContext, ModelCall } from "./logged";

function call(label: string): ModelCall {
  return {
    caller: "outline",
    model: "anthropic/claude-haiku-4.5",
    effort: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    reasoningTokens: null,
    costUsd: 0.001,
    latencyMs: 12,
    trackId: null,
    userId: null,
    label,
    system: null,
    prompt: "p",
    response: "r",
    finishReason: "stop",
    facts: [],
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

type Ev = { type: "node"; n: number } | { type: "finish" };

/** A generator that reports one call before `finish`, the way the draft generator does. */
async function* fakeGenerator(log: GenerationLogContext): AsyncGenerator<Ev> {
  yield { type: "node", n: 1 };
  yield { type: "node", n: 2 };
  log.onCall?.(call("first"));
  yield { type: "finish" };
}

describe("withCallEvents", () => {
  it("interleaves each captured call right before the next inner event", async () => {
    const events = await collect(withCallEvents(true, {}, fakeGenerator));
    expect(events.map((e) => (e.type === "call" ? `call:${e.call.label}` : e.type))).toEqual([
      "node",
      "node",
      "call:first",
      "finish",
    ]);
  });

  it("flushes a call reported after the last event", async () => {
    async function* tail(log: GenerationLogContext): AsyncGenerator<Ev> {
      yield { type: "finish" };
      log.onCall?.(call("late"));
    }
    const events = await collect(withCallEvents(true, {}, tail));
    expect(events.map((e) => e.type)).toEqual(["finish", "call"]);
  });

  it("passes the generator through untouched when disabled", async () => {
    const events = await collect(withCallEvents(false, {}, fakeGenerator));
    expect(events.map((e) => e.type)).toEqual(["node", "node", "finish"]);
  });

  it("keeps an existing onCall and the rest of the log context", async () => {
    const onCall = vi.fn();
    const onLog = vi.fn();
    let seen: GenerationLogContext | undefined;
    async function* spy(log: GenerationLogContext): AsyncGenerator<Ev> {
      seen = log;
      log.onCall?.(call("x"));
      yield { type: "finish" };
    }
    await collect(withCallEvents(true, { userId: "u1", trackId: "t1", onLog, onCall }, spy));
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(seen?.userId).toBe("u1");
    expect(seen?.trackId).toBe("t1");
    expect(seen?.onLog).toBe(onLog);
  });
});
