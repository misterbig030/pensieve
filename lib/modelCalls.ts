import { useSyncExternalStore } from "react";
import type { ModelCall } from "@/lib/ai/logged";

/**
 * The admin's model calls for this tab. One store for the whole app: pages push the calls they receive (as `call`
 * events on a stream, or in a server action's result), the dock in `PageShell` renders them. The list lives in memory
 * and is mirrored to session storage, so it survives navigation and a reload and dies with the tab. Nothing here is
 * written to the database.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ModelCallStore {
  /** The same array reference until the list changes, as `useSyncExternalStore` requires. */
  getSnapshot(): ModelCall[];
  subscribe(onChange: () => void): () => void;
  /** Appends, drops the oldest beyond the cap, persists what fits, notifies. */
  push(calls: ModelCall[]): void;
  /** Empties memory and storage, notifies. */
  clear(): void;
}

export const STORAGE_KEY = "pensieve.modelCalls";
export const MAX_CALLS = 200;
export const MAX_STORED_BYTES = 2_500_000;
const VERSION = 1;

interface StoredList {
  v: typeof VERSION;
  calls: ModelCall[];
}

function isStoredList(value: unknown): value is StoredList {
  return typeof value === "object" && value !== null && (value as StoredList).v === VERSION && Array.isArray((value as StoredList).calls);
}

const isNumberOrNull = (v: unknown) => typeof v === "number" || v === null;
const isStringOrNull = (v: unknown) => typeof v === "string" || v === null;

/**
 * The fields the panel reads without a guard. A stored element that lacks them (another writer, or a `ModelCall` shape
 * change shipped without bumping `VERSION`) is dropped rather than rendered, so a stale item can never take the page
 * down. Bump `VERSION` whenever `ModelCall` changes shape.
 */
function isModelCall(value: unknown): value is ModelCall {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.label === "string" &&
    typeof c.model === "string" &&
    typeof c.prompt === "string" &&
    typeof c.response === "string" &&
    isStringOrNull(c.system) &&
    isStringOrNull(c.finishReason) &&
    isNumberOrNull(c.costUsd) &&
    (c.endedAt === undefined || typeof c.endedAt === "number") &&
    typeof c.latencyMs === "number" &&
    isNumberOrNull(c.inputTokens) &&
    isNumberOrNull(c.outputTokens) &&
    isNumberOrNull(c.cacheReadTokens) &&
    Array.isArray(c.facts) &&
    c.facts.every((f) => typeof f === "string")
  );
}

export function createModelCallStore(
  options: { storage?: StorageLike | null; maxCalls?: number; maxStoredBytes?: number } = {},
): ModelCallStore {
  const storage = options.storage ?? null;
  const maxCalls = options.maxCalls ?? MAX_CALLS;
  const maxStoredBytes = options.maxStoredBytes ?? MAX_STORED_BYTES;
  const listeners = new Set<() => void>();
  let calls: ModelCall[] = [];
  let hydrated = false;

  // Read once, on first use, so the list a previous page left behind comes back. Anything but our own shape is ignored,
  // element by element.
  const hydrate = () => {
    if (hydrated) return;
    hydrated = true;
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (isStoredList(parsed)) calls = parsed.calls.filter(isModelCall);
    } catch {
      // Unparsable or blocked storage: start empty.
    }
  };

  // Best effort: the newest calls that fit in the byte budget, oldest dropped first. The memory list is the truth.
  const persist = () => {
    if (!storage) return;
    const kept: ModelCall[] = [];
    let used = JSON.stringify({ v: VERSION, calls: [] }).length;
    for (let i = calls.length - 1; i >= 0; i--) {
      const size = JSON.stringify(calls[i]).length + 1;
      if (used + size > maxStoredBytes) break;
      used += size;
      kept.unshift(calls[i]);
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, calls: kept }));
    } catch {
      // Quota or private mode: the in-memory list stands.
    }
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot() {
      hydrate();
      return calls;
    },
    subscribe(onChange) {
      hydrate();
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    push(incoming) {
      hydrate();
      calls = [...calls, ...incoming].slice(-maxCalls);
      persist();
      notify();
    },
    clear() {
      hydrated = true;
      calls = [];
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // Blocked storage: nothing to remove that we could read anyway.
      }
      notify();
    },
  };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The store the app uses: session storage in the browser, memory only anywhere else. */
export const modelCallStore: ModelCallStore = createModelCallStore({ storage: browserStorage() });

export function pushModelCalls(calls: ModelCall[]): void {
  modelCallStore.push(calls);
}

export function clearModelCalls(): void {
  modelCallStore.clear();
}

const EMPTY: ModelCall[] = [];
const getServerSnapshot = () => EMPTY;

/** The tab's calls, for client components. The server snapshot is a constant empty list so hydration agrees. */
export function useModelCalls(): ModelCall[] {
  return useSyncExternalStore(modelCallStore.subscribe, modelCallStore.getSnapshot, getServerSnapshot);
}

/** When a call ran (ms since the epoch); null for a call stored before calls had a finish time. */
export function callSpan(call: ModelCall): { startedAt: number; endedAt: number } | null {
  return call.endedAt === undefined ? null : { startedAt: call.endedAt - call.latencyMs, endedAt: call.endedAt };
}

/**
 * How long the models were at work for these calls: each call runs from `endedAt - latencyMs` to `endedAt`, and time
 * covered by several calls at once (research workers run side by side) counts once, time with none running not at all.
 * A call without `endedAt` (stored before calls had one) adds its own duration.
 */
export function modelTimeMs(calls: ModelCall[]): number {
  const spans = calls
    .map(callSpan)
    .filter((span) => span !== null)
    .map((span) => [span.startedAt, span.endedAt] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = calls.filter((c) => callSpan(c) === null).reduce((t, c) => t + c.latencyMs, 0);
  let open: [number, number] | null = null;
  for (const [start, end] of spans) {
    if (open && start <= open[1]) open[1] = Math.max(open[1], end);
    else {
      if (open) total += open[1] - open[0];
      open = [start, end];
    }
  }
  if (open) total += open[1] - open[0];
  return total;
}
