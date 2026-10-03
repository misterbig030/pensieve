import { useSyncExternalStore } from "react";

/**
 * Whether the admin panel is switched on in this browser. Purely a viewer preference: the server decides on every
 * request whether the caller may see model calls at all (see `lib/admin.ts`).
 */
const KEY = "pensieve.admin";
const EVENT = "pensieve:admin";

export function readAdminMode(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAdminMode(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Private mode or blocked storage: the switch still works for this page load through the event below.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeAdminMode(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const getServerSnapshot = () => false;

export function useAdminMode(): boolean {
  return useSyncExternalStore(subscribeAdminMode, readAdminMode, getServerSnapshot);
}
