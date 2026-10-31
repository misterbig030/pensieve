import { useEffect, useId, useSyncExternalStore } from "react";

/**
 * Which planners on the page are under way: the outline (one unit, or everything in a run) and the day pane's Plan
 * and Split buttons. Each only waits on the others, so two model calls never plan the same track at once. Nothing is
 * marked on the server, where effects don't run.
 */
const active = new Set<string>();
const listeners = new Set<() => void>();

export function setPlanning(owner: string, on: boolean): void {
  if (active.has(owner) === on) return;
  if (on) active.add(owner);
  else active.delete(owner);
  for (const l of listeners) l();
}

export function othersPlanning(owner: string): boolean {
  return [...active].some((o) => o !== owner);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Marks this planner as under way while `on`, and says whether another one is. */
export function usePlanningLock(on: boolean): boolean {
  const owner = useId();
  useEffect(() => {
    setPlanning(owner, on);
    return () => setPlanning(owner, false);
  }, [owner, on]);
  const snapshot = () => othersPlanning(owner);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
