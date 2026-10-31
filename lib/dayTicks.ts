/**
 * A day's ticks: one key per step (`stepKey`) and one per task without steps. They live in this browser only and are
 * never progress; Mark complete and logged sessions are.
 */

/** A task with steps is done once every step is; a task without steps is done when ticked itself. */
export function taskTicked(taskId: string, stepKeys: string[], ticks: ReadonlySet<string>): boolean {
  return stepKeys.length > 0 ? stepKeys.every((k) => ticks.has(k)) : ticks.has(taskId);
}

/** Ticking a task ticks all its steps; unticking it clears them. */
export function toggleTask(ticks: ReadonlySet<string>, taskId: string, stepKeys: string[]): Set<string> {
  const next = new Set(ticks);
  const keys = [taskId, ...stepKeys];
  if (taskTicked(taskId, stepKeys, ticks)) for (const k of keys) next.delete(k);
  else for (const k of keys) next.add(k);
  return next;
}

export function toggleStep(ticks: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(ticks);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function doneCount(taskIds: string[], stepKeysOf: (id: string) => string[], ticks: ReadonlySet<string>): number {
  return taskIds.filter((id) => taskTicked(id, stepKeysOf(id), ticks)).length;
}

export function ticksKey(nodeId: string): string {
  return `pensieve.dayTicks.${nodeId}`;
}

/** The day's saved ticks; none when storage is missing, refuses, or holds something else. */
export function readTicks(storage: Pick<Storage, "getItem"> | null, nodeId: string): Set<string> {
  try {
    const raw = storage?.getItem(ticksKey(nodeId));
    const value: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeTicks(storage: Pick<Storage, "setItem"> | null, nodeId: string, ticks: ReadonlySet<string>): void {
  try {
    storage?.setItem(ticksKey(nodeId), JSON.stringify([...ticks]));
  } catch {
    // A private window or full storage: the ticks last until the page closes.
  }
}
