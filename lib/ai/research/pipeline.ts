import type { LanguageModel } from "ai";
import { isPracticeOnly } from "@/lib/materials";
import { PRACTICE_REGISTRY } from "@/lib/practice";
import { clip, type Material, type MaterialPractice, type PracticeList } from "@/lib/schemas/material";
import type { GenerationLogContext } from "../logged";
import { reportServiceFailure } from "../serviceEvents";
import type { AiModelId } from "../models";
import { providerError } from "../providerError";
import { briefHours, createAgentArm, type ArmResult, type ResearchArm, type ResearchBrief } from "./agent";
import { isPracticeOpen, type Coverage, type DroppedMaterial, type ResearchEvent, type ResearchNotice } from "./events";
import { STRUCTURE_RESERVE_MS, STRUCTURE_WALL_MS, createStructureFinder, type StructureFinder, type StructureResult } from "./structureFinder";
import { SourceFetcher, capsFor, searchProviderFromEnv, type ResearchCaps } from "./tools";
import type { StructureRole } from "./units";
import { createOpenLibraryLookup, recommendingDomains, runGate, sizedMinutes, type BookLookup } from "./verify";
import { createWorkersArm } from "./workers";

/** Reading that is not a book is looked through when it takes at least this long (its page or its estimate). */
export const STRUCTURE_MIN_MINUTES = 90;
/** The most sources the structure finder runs for before the allocation. */
export const MAX_STRUCTURE_FINDERS = 6;

/** Words in a source's title or description that say it is a list of things to do. */
const LIST_LIKE_RE = /\b(lists?|problems|questions|exercises|flashcards|cards|challenges|puzzles|katas?|steps|levels|lessons)\b/i;

/**
 * The role a finder looks for: practice only (no reading time, or a chapter list already, which its reading units would
 * never replace), reading only (no practice), or both.
 */
export function structureRole(m: Material): StructureRole {
  if (isPracticeOnly(m) || (m.toc && m.practice)) return "practice";
  return m.practice ? "both" : "read";
}

/**
 * A practice source worth finding an item list for: verified, of a format counted by item (problems, recall, labs),
 * with no list yet, and with a count research gave or a description that reads like a list.
 */
function needsItemList(m: Material): boolean {
  const p = m.practice;
  if (!p || p.list || !m.verifiedAt || PRACTICE_REGISTRY[p.format].perItemMinutes === null) return false;
  return (p.items ?? 0) > 0 || LIST_LIKE_RE.test(`${m.title} ${m.why ?? ""} ${m.uses ?? ""}`);
}

/** How long a material reads, as far as research can tell: the larger of its own page and its estimate. */
const sizeOf = (m: Material) => Math.max(m.pageMinutes ?? 0, m.minutes ?? 0);

/**
 * The sources a structure finder runs for, in priority order, at most MAX_STRUCTURE_FINDERS. A source qualifies when
 * it has an https address, is not a note or a file, and is a book with no chapter list, a practice source that needs
 * its item list, or other reading that is a hub or at least `STRUCTURE_MIN_MINUTES` long. The learner's own come first,
 * then books by how many sites recommend them, practice by its time, and the rest by size; a tie keeps the list's order.
 */
export function likelyStructures(materials: Material[]): Material[] {
  const ranked: { m: Material; tier: number; weight: number; i: number }[] = [];
  materials.forEach((m, i) => {
    if (!m.url.trim().toLowerCase().startsWith("https://") || m.type === "note" || m.type === "file") return;
    const book = m.kind === "book" && !m.toc;
    const practice = needsItemList(m);
    const reading = m.kind !== "book" && (m.hub === true || sizeOf(m) >= STRUCTURE_MIN_MINUTES);
    if (!book && !practice && !reading) return;
    if (m.origin === "learner") ranked.push({ m, tier: 0, weight: 0, i });
    else if (book) ranked.push({ m, tier: 1, weight: recommendingDomains(m.url, m.recommendedBy).length, i });
    else if (practice) ranked.push({ m, tier: 2, weight: m.practice!.minutes ?? 0, i });
    else ranked.push({ m, tier: 3, weight: sizeOf(m), i });
  });
  return ranked
    .sort((a, b) => a.tier - b.tier || b.weight - a.weight || a.i - b.i)
    .slice(0, MAX_STRUCTURE_FINDERS)
    .map(({ m }) => m);
}

/**
 * A material with what its structure finder found: its chapter list and the size that comes with it, the finder's note
 * (cut to the schema's bound) and a practice source's item list. A chapter list the material already has (the
 * catalogue's, or one the gate gave the learner's book) is never replaced, nor the size that goes with it: a book picked
 * for its item list keeps its chapters. A finder that failed (null) or whose units were refused changes nothing.
 */
function withStructure(m: Material, result: StructureResult | null): Material {
  if (!result || result.refused) return m;
  const note = clip(result.note, 300);
  const units = !m.toc;
  return {
    ...m,
    ...(units && result.toc ? { toc: result.toc } : {}),
    ...(units && result.minutes !== null ? { minutes: result.minutes, minutesBasis: result.basis } : {}),
    ...(note ? { note } : {}),
    ...(result.list && m.practice ? { practice: withItemList(m.practice, result.list) } : {}),
  };
}

/**
 * A signal that aborts after `ms`, on `setTimeout` (unlike `AbortSignal.timeout`, so test clocks drive it); `clear`
 * stops the timer once it is no longer needed.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The structure stage ran out of time", "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Settles with null once `signal` aborts (at once if it already has), so a race against it gives up waiting. */
function abandonedAt(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

/**
 * A practice source with its found list: `totalItems` is the list's length, and the count research gave is kept; when
 * it gave none, it is the list's. Doing time is left as it was: the allocation sets it from the items it keeps.
 */
export function withItemList(practice: MaterialPractice, list: PracticeList): MaterialPractice {
  return { ...practice, list, totalItems: list.items.length, items: practice.items ?? list.items.length };
}

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
  /** Finds a source's units (chapters, sections, linked files) and a practice source's items. Omitted, the stage is skipped. */
  structure?: StructureFinder;
  /** The draft's deadline (epoch ms): the structure stage ends STRUCTURE_RESERVE_MS before it. */
  deadline?: number;
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

/**
 * The structure finder the app ships, on the same search provider as the arm. Never null: without `TAVILY_API_KEY` it
 * has no search tool, and its other tools only fetch.
 */
export function defaultStructureFinder(
  env: Record<string, string | undefined> = process.env,
  options: { model?: AiModelId | LanguageModel } = {},
): StructureFinder {
  return createStructureFinder({ provider: searchProviderFromEnv(env), model: options.model });
}

/**
 * brief → arm → gate → structure → materials list. Nothing here fails the draft: an arm that throws, a search API that
 * is down, or a candidate step that never validates all end in a shorter list with a notice, and a structure finder
 * that fails leaves its source whole; never an error (except a provider refusal on the user's own key).
 */
export async function* researchMaterials(input: ResearchMaterialsInput): AsyncGenerator<ResearchEvent, ResearchOutcome> {
  const caps = input.caps ?? capsFor(briefHours(input.brief));
  const fetcher = input.fetcher ?? new SourceFetcher();
  const books = input.books ?? createOpenLibraryLookup(undefined, { onService: input.log?.onService });
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
      reportServiceFailure(input.log, error, "arm", input.signal);
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

  // Before the allocation, the structure stage: a finder per source that has parts to find (a book's chapters, a long
  // guide's sections, a hub's linked files, a practice source's items) looks through it with tools that fetch and
  // measure, and code checks what it returns. The stage ends STRUCTURE_RESERVE_MS before the draft's deadline, so the
  // allocation and the outline keep their time; with less than a finder's wall clock left before that, it is skipped.
  let materials = gate.materials;
  let costUsd = arm?.costUsd ?? 0;
  const counts = { searches: arm?.counts.searches ?? 0, fetches: arm?.counts.fetches ?? 0 };
  const finder = input.structure;
  const stageMs = input.deadline === undefined ? null : input.deadline - STRUCTURE_RESERVE_MS - Date.now();
  const targets = finder && (stageMs === null || stageMs >= STRUCTURE_WALL_MS) ? likelyStructures(materials) : [];
  if (finder && targets.length > 0) {
    const stage = stageMs === null ? null : timeoutSignal(stageMs);
    const signals = [input.signal, stage?.signal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let results: (StructureResult | null)[];
    try {
      results = yield* streamWhile<ResearchEvent, (StructureResult | null)[]>((emit) =>
        Promise.all(
          targets.map(async (m) => {
            const find = async (): Promise<StructureResult | null> => {
              try {
                return await finder.find(m, structureRole(m), { fetcher, emit, signal, log: input.log });
              } catch (error) {
                // A finder the stage's end cut off did not fail on Anthropic.
                reportServiceFailure(input.log, error, "structure", signal);
                if (input.log?.keyOwner === "user" && providerError(error)) throw error;
                console.error(`[research] structure finder failed for "${m.title}"`, error);
                return null;
              }
            };
            // A finder still running when the stage ends is left behind: its source stays whole.
            const result = await (stage ? Promise.race([find(), abandonedAt(stage.signal)]) : find());
            // What the source keeps (see `withStructure`): nothing when the finder failed or its units were refused, and
            // no new units when it already had a chapter list.
            const kept = result && !result.refused ? result : null;
            const toc = m.toc ? null : kept?.toc;
            const url = toc?.url ?? kept?.list?.url;
            emit({
              type: "research.structure",
              id: m.id,
              title: m.title,
              units: toc ? (kept?.units ?? 0) : 0,
              items: kept?.list?.items.length ?? 0,
              ...(result?.refused ? { refused: result.refused } : {}),
              ...(url ? { url } : {}),
            });
            return result;
          }),
        ),
      );
    } finally {
      stage?.clear();
    }
    const found = new Map<string, StructureResult>();
    results.forEach((result, i) => {
      if (!result) return;
      counts.searches += result.counts.searches;
      counts.fetches += result.counts.fetches;
      costUsd += result.costUsd;
      found.set(targets[i].id, result);
    });
    if (found.size > 0) materials = materials.map((m) => withStructure(m, found.get(m.id) ?? null));
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
