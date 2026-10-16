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

export function createModelCallStore(
  options: { storage?: StorageLike | null; maxCalls?: number; maxStoredBytes?: number } = {},
): ModelCallStore {
  const storage = options.storage ?? null;
  const maxCalls = options.maxCalls ?? MAX_CALLS;
  const maxStoredBytes = options.maxStoredBytes ?? MAX_STORED_BYTES;
  const listeners = new Set<() => void>();
  let calls: ModelCall[] = [];
  let hydrated = false;

  // Read once, on first use, so the list a previous page left behind comes back. Anything but our own shape is ignored.
  const hydrate = () => {
    if (hydrated) return;
    hydrated = true;
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (isStoredList(parsed)) calls = parsed.calls;
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
