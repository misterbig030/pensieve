import { describe, expect, it, vi } from "vitest";
import type { ModelCall } from "@/lib/ai/logged";
import { STORAGE_KEY, callSpan, createModelCallStore, modelTimeMs, type StorageLike } from "./modelCalls";

function call(label: string, pad = ""): ModelCall {
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
    prompt: pad,
    response: "r",
    finishReason: "stop",
    facts: [],
  };
}

function fakeStorage(): StorageLike & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe("createModelCallStore", () => {
  it("push appends, replaces the snapshot and notifies once per push", () => {
    const store = createModelCallStore({ storage: fakeStorage() });
    const onChange = vi.fn();
    store.subscribe(onChange);
    const before = store.getSnapshot();
    store.push([call("a")]);
    store.push([call("b"), call("c")]);
    expect(store.getSnapshot().map((c) => c.label)).toEqual(["a", "b", "c"]);
    expect(store.getSnapshot()).not.toBe(before);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(before).toEqual([]);
  });

  it("returns the same snapshot reference until something changes", () => {
    const store = createModelCallStore({ storage: fakeStorage() });
    store.push([call("a")]);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("persists under the key as a versioned item and hydrates from it", () => {
    const storage = fakeStorage();
    createModelCallStore({ storage }).push([call("a")]);
    expect(JSON.parse(storage.items.get(STORAGE_KEY)!)).toMatchObject({ v: 1, calls: [{ label: "a" }] });
    expect(createModelCallStore({ storage }).getSnapshot().map((c) => c.label)).toEqual(["a"]);
  });

  it("starts empty on a missing, unparsable or wrong-version item", () => {
    for (const item of [undefined, "{not json", JSON.stringify({ v: 2, calls: [call("x")] }), JSON.stringify({ calls: [] })]) {
      const storage = fakeStorage();
      if (item !== undefined) storage.items.set(STORAGE_KEY, item);
      expect(createModelCallStore({ storage }).getSnapshot()).toEqual([]);
    }
  });

  it("drops stored elements that are not model calls and keeps the rest", () => {
    const storage = fakeStorage();
    storage.items.set(STORAGE_KEY, JSON.stringify({ v: 1, calls: [{}, null, "x", { ...call("ok"), facts: "not a list" }, call("kept")] }));
    expect(createModelCallStore({ storage }).getSnapshot().map((c) => c.label)).toEqual(["kept"]);
  });

  it("keeps a stored call with no cost: one on the user's own key", () => {
    const storage = fakeStorage();
    storage.items.set(STORAGE_KEY, JSON.stringify({ v: 1, calls: [{ ...call("own key"), keyOwner: "user", costUsd: null }] }));
    expect(createModelCallStore({ storage }).getSnapshot().map((c) => c.label)).toEqual(["own key"]);
  });

  it("starts empty when every stored element is malformed", () => {
    const storage = fakeStorage();
    storage.items.set(STORAGE_KEY, JSON.stringify({ v: 1, calls: [{}] }));
    const store = createModelCallStore({ storage });
    expect(store.getSnapshot()).toEqual([]);
    store.push([call("a")]);
    expect(store.getSnapshot().map((c) => c.label)).toEqual(["a"]);
  });

  it("clear empties memory, removes the item and notifies", () => {
    const storage = fakeStorage();
    const store = createModelCallStore({ storage });
    const onChange = vi.fn();
    store.subscribe(onChange);
    store.push([call("a")]);
    store.clear();
    expect(store.getSnapshot()).toEqual([]);
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("drops the oldest beyond maxCalls", () => {
    const store = createModelCallStore({ storage: fakeStorage(), maxCalls: 2 });
    store.push([call("a"), call("b")]);
    store.push([call("c")]);
    expect(store.getSnapshot().map((c) => c.label)).toEqual(["b", "c"]);
  });

  it("writes only the newest calls that fit in maxStoredBytes and keeps the full list in memory", () => {
    const storage = fakeStorage();
    const store = createModelCallStore({ storage, maxStoredBytes: 1200 });
    store.push([call("a", "x".repeat(500)), call("b", "y".repeat(500)), call("c", "z".repeat(500))]);
    expect(store.getSnapshot()).toHaveLength(3);
    const stored = JSON.parse(storage.items.get(STORAGE_KEY)!).calls.map((c: ModelCall) => c.label);
    expect(stored).toEqual(["c"]);
  });

  it("keeps a call too large to store in memory only", () => {
    const storage = fakeStorage();
    const store = createModelCallStore({ storage, maxStoredBytes: 100 });
    store.push([call("huge", "x".repeat(1000))]);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(JSON.parse(storage.items.get(STORAGE_KEY)!).calls).toEqual([]);
  });

  it("a throwing storage leaves the memory list working", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createModelCallStore({ storage });
    store.push([call("a")]);
    store.clear();
    store.push([call("b")]);
    expect(store.getSnapshot().map((c) => c.label)).toEqual(["b"]);
  });

  it("works with no storage at all", () => {
    const store = createModelCallStore({ storage: null });
    store.push([call("a")]);
    expect(store.getSnapshot()).toHaveLength(1);
  });
});

describe("modelTimeMs", () => {
  const timed = (endedAt: number | undefined, latencyMs: number): ModelCall => ({ ...call("t"), endedAt, latencyMs });

  it("counts calls that ran side by side once", () => {
    // Three workers from 0 to 10 s, 2 to 8 s and 5 to 12 s: models were busy from 0 to 12 s.
    expect(modelTimeMs([timed(10_000, 10_000), timed(8_000, 6_000), timed(12_000, 7_000)])).toBe(12_000);
  });

  it("leaves out the time between calls, when nothing was running", () => {
    expect(modelTimeMs([timed(4_000, 4_000), timed(60_000, 3_000)])).toBe(7_000);
  });

  it("adds a call with no finish time (stored before calls had one) on its own", () => {
    expect(modelTimeMs([timed(10_000, 10_000), timed(undefined, 2_500)])).toBe(12_500);
  });

  it("is zero with no calls", () => {
    expect(modelTimeMs([])).toBe(0);
  });
});

describe("callSpan", () => {
  it("runs from the finish time less the duration to the finish time", () => {
    expect(callSpan({ ...call("t"), endedAt: 60_000, latencyMs: 15_500 })).toEqual({ startedAt: 44_500, endedAt: 60_000 });
  });

  it("is unknown for a call stored before calls had a finish time", () => {
    expect(callSpan(call("t"))).toBeNull();
  });
});
