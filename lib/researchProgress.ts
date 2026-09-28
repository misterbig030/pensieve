import type { DroppedMaterial, ResearchEvent, ResearchNotice } from "@/lib/ai/research/events";
import { hostOf, type Material, type MaterialKind } from "@/lib/schemas/material";

export type ResearchLogKind = "source" | "searched" | "verified" | "dropped" | "failed";

export interface ResearchLogEntry {
  id: number;
  kind: ResearchLogKind;
  text: string;
  detail?: string;
  backbone?: boolean;
}

export interface FoundMaterial {
  id: string;
  title: string;
  kind: MaterialKind;
  backbone: boolean;
  yours: boolean;
}

/** What the research card shows while research runs, folded from the stream's `research.*` events. */
export interface ResearchProgressState {
  running: boolean;
  startedAt: number;
  caps: { searches: number; fetches: number; steps: number };
  searches: number;
  reads: number;
  verified: number;
  dropped: number;
  log: ResearchLogEntry[];
  found: FoundMaterial[];
  /** The page being read right now, if any. */
  reading: string | null;
  notice?: ResearchNotice;
}

export function initialResearch(now = Date.now()): ResearchProgressState {
  return {
    running: true,
    startedAt: now,
    caps: { searches: 6, fetches: 12, steps: 12 },
    searches: 0,
    reads: 0,
    verified: 0,
    dropped: 0,
    log: [],
    found: [],
    reading: null,
  };
}

function push(state: ResearchProgressState, entry: Omit<ResearchLogEntry, "id">): ResearchLogEntry[] {
  return [...state.log, { ...entry, id: state.log.length + 1 }];
}

/** Folds one event into the card's state. `learnerUrls` are the learner's own sources, logged as "Your source". */
export function reduceResearch(state: ResearchProgressState, event: ResearchEvent, learnerUrls: ReadonlySet<string>): ResearchProgressState {
  switch (event.type) {
    case "research.start":
      return { ...initialResearch(state.startedAt), caps: event.caps };
    case "research.search":
      return {
        ...state,
        searches: state.searches + 1,
        log: push(state, { kind: "searched", text: event.query, detail: `${event.results} result${event.results === 1 ? "" : "s"}` }),
      };
    case "research.reading":
      return { ...state, reading: event.url };
    case "research.fetch": {
      const next = { ...state, reads: state.reads + 1, reading: state.reading === event.url ? null : state.reading };
      if (learnerUrls.has(event.url)) {
        return {
          ...next,
          log: push(state, event.ok ? { kind: "source", text: hostOf(event.url) ?? event.url } : { kind: "failed", text: hostOf(event.url) ?? event.url, detail: `your source ${event.reason ?? "could not be opened"}; kept anyway` }),
        };
      }
      return next;
    }
    case "research.verified":
      return {
        ...state,
        verified: state.verified + 1,
        log: push(state, { kind: "verified", text: event.title, detail: event.kind, backbone: event.backbone }),
        found: [...state.found.filter((f) => f.id !== event.id), { id: event.id, title: event.title, kind: event.kind, backbone: event.backbone, yours: false }],
      };
    case "research.dropped":
      return { ...state, dropped: state.dropped + 1, log: push(state, { kind: "dropped", text: event.title, detail: event.reason }) };
    case "research.done":
      return {
        ...state,
        running: false,
        reading: null,
        notice: event.notice,
        found: event.materials.map((m) => ({ id: m.id, title: m.title, kind: m.kind, backbone: m.backbone, yours: m.origin === "learner" })),
      };
  }
}

export interface ResearchResult {
  materials: Material[];
  dropped: DroppedMaterial[];
  notice?: ResearchNotice;
}

/** "1 h 30", "45 min", "2 h". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}
