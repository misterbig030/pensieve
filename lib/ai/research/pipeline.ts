import type { Material } from "@/lib/schemas/material";
import type { GenerationLogContext } from "../logged";
import { briefHours, createAgentArm, type ArmResult, type ResearchArm, type ResearchBrief } from "./agent";
import type { Coverage, DroppedMaterial, ResearchEvent, ResearchNotice } from "./events";
import { SourceFetcher, capsFor, searchProviderFromEnv, type ResearchCaps } from "./tools";
import { createOpenLibraryLookup, runGate, sizedMinutes, type BookLookup } from "./verify";

/** Fewer researched materials than this and the plan carries the "thin" notice, whatever they cover. */
export const THIN_BELOW = 3;

/**
 * Research is thin when it verified almost nothing, or when it left at least as many of the topic's main areas
 * open as it covered. A short list that covers the topic is not thin: a week-long plan needs only a handful.
 */
export function isThin(verified: number, coverage: Coverage | null | undefined): boolean {
  if (verified < THIN_BELOW) return true;
  return !!coverage && coverage.open.length > 0 && coverage.open.length >= coverage.covered.length;
}

export interface ResearchOutcome {
  materials: Material[];
  dropped: DroppedMaterial[];
  notice?: ResearchNotice;
  costUsd: number;
  arm: Omit<ArmResult, "seenUrls" | "candidates" | "learnerNotes"> | null;
  /** Candidates proposed and candidates verified, for the eval's verified rate. */
  proposed: number;
  verified: number;
  coverage: Coverage | null;
  /** Minutes of material on the list, over the materials that have a size. */
  sizedMinutes: number;
}

/**
 * Runs `run` while yielding every event it emits, as it emits it, then returns its result. Lets callback-style work
 * (tool executes, the gate) feed an async generator without buffering the whole run.
 */
export async function* streamWhile<T, R>(run: (emit: (event: T) => void) => Promise<R>): AsyncGenerator<T, R> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const work = run((event) => {
    queue.push(event);
    notify();
  });
  work.then(
    () => {
      settled = true;
      notify();
    },
    () => {
      settled = true;
      notify();
    },
  );
  for (;;) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (settled) break;
    await new Promise<void>((resolve) => (wake = resolve));
  }
  return await work;
}

export interface ResearchMaterialsInput {
  brief: ResearchBrief;
  /** Null when no search provider is configured: the learner's sources are still checked, and the notice says so. */
  arm: ResearchArm | null;
  fetcher?: SourceFetcher;
  books?: BookLookup;
  signal?: AbortSignal;
  log?: GenerationLogContext;
  caps?: ResearchCaps;
}

/** The arm the app ships: arm A with Tavily, or null when `TAVILY_API_KEY` is unset. */
export function defaultArm(): ResearchArm | null {
  const provider = searchProviderFromEnv();
  return provider ? createAgentArm({ provider }) : null;
}

/**
 * brief → arm → gate → materials list. Nothing here fails the draft: an arm that throws, a search API that is down,
 * or a candidate step that never validates all end in a shorter list with a notice, never an error.
 */
export async function* researchMaterials(input: ResearchMaterialsInput): AsyncGenerator<ResearchEvent, ResearchOutcome> {
  const caps = input.caps ?? capsFor(briefHours(input.brief));
  const fetcher = input.fetcher ?? new SourceFetcher();
  const books = input.books ?? createOpenLibraryLookup();
  yield { type: "research.start", caps: { searches: caps.searches, fetches: caps.fetches, steps: caps.steps } };

  let arm: ArmResult | null = null;
  if (input.arm) {
    const runArm = input.arm;
    try {
      arm = yield* streamWhile<ResearchEvent, ArmResult>((emit) =>
        runArm({ brief: input.brief, signal: input.signal, fetcher, emit, log: input.log, caps }),
      );
    } catch (error) {
      console.error("[research] arm failed", error);
      arm = null;
    }
  }

  const gate = yield* streamWhile<ResearchEvent, Awaited<ReturnType<typeof runGate>>>((emit) =>
    runGate({
      candidates: arm?.candidates ?? [],
      learner: input.brief.sources,
      learnerNotes: arm?.learnerNotes ?? [],
      fetcher,
      books,
      seenUrls: arm?.seenUrls ?? new Set(),
      emit,
      signal: input.signal,
    }),
  );

  const unavailable = !arm || arm.stoppedBy === "cancelled" || (arm.stoppedBy === "search-error" && arm.searchesOk === 0);
  const coverage = arm?.coverage ?? null;
  const notice: ResearchNotice | undefined = unavailable ? "unavailable" : isThin(gate.verified, coverage) ? "thin" : undefined;
  const counts = { searches: arm?.counts.searches ?? 0, fetches: arm?.counts.fetches ?? 0 };
  const sized = sizedMinutes(gate.materials);
  yield { type: "research.done", materials: gate.materials, dropped: gate.dropped, ...(notice ? { notice } : {}), counts, coverage, sizedMinutes: sized };

  const armSummary = arm ? { counts: arm.counts, searchesOk: arm.searchesOk, stoppedBy: arm.stoppedBy, costUsd: arm.costUsd } : null;
  return {
    materials: gate.materials,
    dropped: gate.dropped,
    notice,
    costUsd: arm?.costUsd ?? 0,
    arm: armSummary,
    proposed: gate.proposed,
    verified: gate.verified,
    coverage,
    sizedMinutes: sized,
  };
}
