import { describe, expect, it, vi } from "vitest";
import { collectCalls } from "./collectCalls";
import type { ModelCall } from "./logged";

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

describe("collectCalls", () => {
  it("returns the context unchanged when disabled", () => {
    const log = { userId: "u1", onCall: vi.fn() };
    const sink: ModelCall[] = [];
    expect(collectCalls(false, log, sink)).toBe(log);
  });

  it("fills the sink and still forwards to the original onCall", () => {
    const onCall = vi.fn();
    const onLog = vi.fn();
    const sink: ModelCall[] = [];
    const log = collectCalls(true, { userId: "u1", trackId: "t1", keyOwner: "user", onLog, onCall }, sink);
    log.onCall?.(call("a"));
    log.onCall?.(call("b"));
    expect(sink.map((c) => c.label)).toEqual(["a", "b"]);
    expect(onCall).toHaveBeenCalledTimes(2);
    expect(log).toMatchObject({ userId: "u1", trackId: "t1", keyOwner: "user", onLog });
  });

  it("stamps each call with when it finished", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(7_000);
    const sink: ModelCall[] = [];
    collectCalls(true, {}, sink).onCall?.(call("a"));
    expect(sink[0].endedAt).toBe(7_000);
    now.mockRestore();
  });

  it("keeps the finish time a call already carries (one handed over late)", () => {
    const sink: ModelCall[] = [];
    collectCalls(true, {}, sink).onCall?.({ ...call("late"), endedAt: 3_000 });
    expect(sink[0].endedAt).toBe(3_000);
  });

  it("keeps calls pushed before the work throws", async () => {
    const sink: ModelCall[] = [];
    const log = collectCalls(true, {}, sink);
    await expect(
      (async () => {
        log.onCall?.(call("first"));
        throw new Error("refused");
      })(),
    ).rejects.toThrow("refused");
    expect(sink.map((c) => c.label)).toEqual(["first"]);
  });
});
