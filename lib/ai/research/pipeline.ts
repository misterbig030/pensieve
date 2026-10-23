import type { LanguageModel } from "ai";
import { isPracticeOnly } from "@/lib/materials";
import type { Material } from "@/lib/schemas/material";
import type { GenerationLogContext } from "../logged";
import type { AiModelId } from "../models";
import { providerError } from "../providerError";
import { briefHours, createAgentArm, type ArmResult, type ResearchArm, type ResearchBrief } from "./agent";
import { createChapterFinder, type ChapterFinder, type ChapterFinderResult } from "./chapterFinder";
import { isPracticeOpen, type Coverage, type DroppedMaterial, type ResearchEvent, type ResearchNotice } from "./events";
import { SourceFetcher, capsFor, searchProviderFromEnv, type ResearchCaps } from "./tools";
import { createOpenLibraryLookup, runGate, sizedMinutes, type BookLookup } from "./verify";
import { createWorkersArm } from "./workers";

/** Fewer researched materials than this and the plan carries the "thin" notice, whatever they cover. */
export const THIN_BELOW = 3;

/**
 * Research is thin when it verified almost nothing to read (`verifiedReading`), or when it left at least as many of
 * the topic's main areas open as it covered. A short list that covers the topic is not thin: a week-long plan needs
 * only a handful. Open practice kinds are not areas of the topic, so they do not count.
 */
export function isThin(verified: number, coverage: Coverage | null | undefined): boolean {
  if (verified < THIN_BELOW) return true;
  if (!coverage) return false;
  const open = coverage.open.filter((a) => !isPracticeOpen(a)).length;
  return open > 0 && open >= coverage.covered.length;
}

/** The researched materials there is something to read in: what the thin notice counts, since practice-only sources are not reading. */
export function verifiedReading(materials: Pick<Material, "origin" | "minutes" | "practice">[]): number {
  return materials.filter((m) => m.origin === "research" && !isPracticeOnly(m)).length;
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
  /** Finds the backbone's chapters on a web page when the catalogue had none. Omitted, the stage is skipped. */
  chapters?: ChapterFinder;
}

/**
 * The arm the app ships: arm A with Tavily, or arm W (one worker per research direction) when `RESEARCH_ARM=workers`.
 * Null when `TAVILY_API_KEY` is unset.
 */
export function defaultArm(
  env: Record<string, string | undefined> = process.env,
  options: { model?: AiModelId | LanguageModel } = {},
): ResearchArm | null {
  const provider = searchProviderFromEnv(env);
  if (!provider) return null;
  const common = { provider, model: options.model };
  return env.RESEARCH_ARM?.trim().toLowerCase() === "workers" ? createWorkersArm(common) : createAgentArm(common);
}

/** The chapter finder the app ships, on the same search provider as the arm. Null when `TAVILY_API_KEY` is unset. */
export function defaultChapterFinder(
  env: Record<string, string | undefined> = process.env,
  options: { model?: AiModelId | LanguageModel } = {},
): ChapterFinder | null {
  const provider = searchProviderFromEnv(env);
  return provider ? createChapterFinder({ provider, model: options.model }) : null;
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
      // On the user's own key a provider refusal is theirs to hear about: it stops the request (the guard names it).
      // Everything else, a search outage or a model hiccup on the app's key, shortens the list with a notice.
      if (input.log?.keyOwner === "user" && providerError(error)) throw error;
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

  // The backbone's chapters: the gate took them from the catalogue when it could; otherwise one search and a few
  // reads look for a page that lists them. Only the backbone, because only its chapters are reserved across units.
  let materials = gate.materials;
  let costUsd = arm?.costUsd ?? 0;
  const counts = { searches: arm?.counts.searches ?? 0, fetches: arm?.counts.fetches ?? 0 };
  const backbone = materials.find((m) => m.backbone);
  if (backbone && !backbone.toc && input.chapters) {
    const finder = input.chapters;
    let found: ChapterFinderResult | null = null;
    try {
      found = yield* streamWhile<ResearchEvent, ChapterFinderResult>((emit) => finder.find(backbone, { fetcher, emit, signal: input.signal, log: input.log }));
    } catch (error) {
      if (input.log?.keyOwner === "user" && providerError(error)) throw error;
      console.error("[research] chapter finder failed", error);
    }
    if (found) {
      counts.searches += found.counts.searches;
      counts.fetches += found.counts.fetches;
      costUsd += found.costUsd;
    }
    const toc = found?.toc ?? null;
    if (toc) materials = materials.map((m) => (m === backbone ? { ...m, toc } : m));
    yield { type: "research.chapters", id: backbone.id, title: backbone.title, chapters: toc?.chapters.length ?? 0, source: toc?.source ?? null, ...(toc ? { url: toc.url } : {}) };
  }

  const unavailable = !arm || arm.stoppedBy === "cancelled" || arm.stoppedBy === "clock-idle" || (arm.stoppedBy === "search-error" && arm.searchesOk === 0);
  const coverage = arm?.coverage ?? null;
  const notice: ResearchNotice | undefined = unavailable ? "unavailable" : isThin(verifiedReading(materials), coverage) ? "thin" : undefined;
  const sized = sizedMinutes(materials);
  yield { type: "research.done", materials, dropped: gate.dropped, ...(notice ? { notice } : {}), counts, coverage, sizedMinutes: sized };

  const armSummary = arm
    ? { counts: arm.counts, searchesOk: arm.searchesOk, stoppedBy: arm.stoppedBy, costUsd: arm.costUsd, ...(arm.workers ? { workers: arm.workers, duplicateShare: arm.duplicateShare ?? null } : {}) }
    : null;
  return {
    materials,
    dropped: gate.dropped,
    notice,
    costUsd,
    arm: armSummary,
    proposed: gate.proposed,
    verified: gate.verified,
    coverage,
    sizedMinutes: sized,
  };
}
