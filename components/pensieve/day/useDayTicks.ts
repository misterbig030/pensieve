"use client";

import { useEffect, useState } from "react";
import { readTicks, writeTicks } from "@/lib/dayTicks";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A day's ticks, kept in this browser. They load after the first render, so the server's markup and the client's match. */
export function useDayTicks(nodeId: string): { ticks: Set<string>; set(next: Set<string>): void } {
  const [ticks, setTicks] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser storage is only readable after hydration
    setTicks(readTicks(storage(), nodeId));
  }, [nodeId]);
  return {
    ticks,
    set(next) {
      setTicks(next);
      writeTicks(storage(), nodeId, next);
    },
  };
}
