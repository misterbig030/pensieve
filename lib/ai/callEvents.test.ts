import { describe, expect, it, vi } from "vitest";
import { withCallEvents, type CallEvent } from "./callEvents";
import type { GenerationLogContext, ModelCall } from "./logged";
import type { ServiceEvent } from "./serviceEvents";

function call(label: string): ModelCall {
  return {
    caller: "outline",
    model: "anthropic/claude-haiku-4.5",
    effort: null,
    keyOwner: "app",
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

  it("streams service events in order beside call events when enabled, and none when disabled", async () => {
    const service = (ms: number): ServiceEvent => ({ type: "service", name: "anthropic", ok: false, final: false, ms, status: 529 });
    const onService = vi.fn();
    async function* reporting(log: GenerationLogContext): AsyncGenerator<Ev> {
      yield { type: "node", n: 1 };
      log.onService?.(service(1));
      log.onCall?.(call("first"));
      log.onService?.(service(2));
      yield { type: "finish" };
      log.onService?.(service(3));
    }
    const label = (e: Ev | CallEvent | ServiceEvent) =>
      e.type === "call" ? `call:${e.call.label}` : e.type === "service" ? `service:${e.ms}` : e.type;
    const on = await collect(withCallEvents(true, { onService }, reporting));
    expect(on.map(label)).toEqual(["node", "service:1", "call:first", "service:2", "finish", "service:3"]);
    expect(onService).toHaveBeenCalledTimes(3);
    const off = await collect(withCallEvents(false, {}, reporting));
    expect(off.map(label)).toEqual(["node", "finish"]);
  });
});
