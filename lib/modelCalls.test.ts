import { describe, expect, it, vi } from "vitest";
import type { ModelCall } from "@/lib/ai/logged";
import { STORAGE_KEY, createModelCallStore, type StorageLike } from "./modelCalls";

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
