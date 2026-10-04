import type { Material, MaterialKind, MinutesBasis } from "@/lib/schemas/material";

/** Why the list is short: research left much of the topic uncovered (`thin`), or could not run at all (`unavailable`). */
export type ResearchNotice = "thin" | "unavailable";

/** The topic's main areas, as research named them: the ones the list covers and the ones nothing on it covers. */
export interface Coverage {
  covered: string[];
  open: string[];
}

export interface ResearchCounts {
  searches: number;
  fetches: number;
}

/**
 * Streamed ahead of the first drafted unit. `reading` marks a page read that has started; its `fetch` event says how
 * it ended. `verified` and `dropped` come from the gate, `done` carries the list the plan will reference.
 */
export type ResearchEvent =
  | { type: "research.start"; caps: { searches: number; fetches: number; steps: number } }
  | { type: "research.search"; query: string; results: number }
  | { type: "research.reading"; url: string }
  | { type: "research.fetch"; url: string; ok: boolean; reason?: string }
  | { type: "research.verified"; id: string; title: string; kind: MaterialKind; backbone: boolean; minutes?: number | null; basis?: MinutesBasis | null }
  | { type: "research.dropped"; title: string; url?: string; reason: string }
  | {
      type: "research.done";
      materials: Material[];
      dropped: DroppedMaterial[];
      notice?: ResearchNotice;
      counts: ResearchCounts;
      /** Null when research did not run or named no areas. */
      coverage?: Coverage | null;
      /** Minutes of material on the list, summed over the materials that have a size. */
      sizedMinutes?: number;
    };

/** A candidate the gate refused, kept so the learner can see what was considered and why it is not in the plan. */
export interface DroppedMaterial {
  title: string;
  url?: string;
  reason: string;
}
