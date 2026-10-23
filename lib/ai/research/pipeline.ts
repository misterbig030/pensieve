import type { LanguageModel } from "ai";
import { isPracticeOnly } from "@/lib/materials";
import { PRACTICE_REGISTRY } from "@/lib/practice";
import type { Material, MaterialPractice, PracticeList } from "@/lib/schemas/material";
import type { GenerationLogContext } from "../logged";
import type { AiModelId } from "../models";
import { providerError } from "../providerError";
import { briefHours, createAgentArm, type ArmResult, type ResearchArm, type ResearchBrief } from "./agent";
import { createChapterFinder, type ChapterFinder, type ChapterFinderResult } from "./chapterFinder";
import { isPracticeOpen, type Coverage, type DroppedMaterial, type ResearchEvent, type ResearchNotice } from "./events";
import { createItemFinder, listGroups, type ItemFinder, type ItemFinderResult } from "./itemFinder";
import { SourceFetcher, capsFor, searchProviderFromEnv, type ResearchCaps } from "./tools";
import { BACKBONE_MIN_DOMAINS, createOpenLibraryLookup, recommendingDomains, runGate, sizedMinutes, type BookLookup } from "./verify";
import { createWorkersArm } from "./workers";

/** The most books the web chapter finder runs for before the allocation. */
export const MAX_CHAPTER_SEARCHES = 2;

/**
 * The books the allocation could reasonably make the backbone and that have no chapter list yet: catalogued, and
 * recommended by at least `BACKBONE_MIN_DOMAINS` other sites. At most `MAX_CHAPTER_SEARCHES`, most recommended first;
 * a tie keeps the list's order.
 */
export function likelyBackbones(materials: Material[]): Material[] {
  return materials
    .filter((m) => m.kind === "book" && m.catalogued && !m.toc)
    .map((m) => ({ m, domains: recommendingDomains(m.url, m.recommendedBy).length }))
    .filter((x) => x.domains >= BACKBONE_MIN_DOMAINS)
    .sort((a, b) => b.domains - a.domains)
    .slice(0, MAX_CHAPTER_SEARCHES)
    .map((x) => x.m);
}

/** The most practice sources the item-list finder runs for before the allocation. */
export const MAX_ITEM_SEARCHES = 3;

/** Words in a source's title or description that say it is a list of things to do. */
const LIST_LIKE_RE = /\b(lists?|problems|questions|exercises|flashcards|cards|challenges|puzzles|katas?|steps|levels|lessons)\b/i;

/**
 * The practice sources worth finding an item list for: verified, of a format counted by item (problems, recall, labs),
 * with no list yet, and with a count research gave or a description that reads like a list. At most
 * `MAX_ITEM_SEARCHES`, the most practice time first; a tie keeps the list's order.
 */
export function likelyItemLists(materials: Material[]): Material[] {
  return materials
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => {
      const p = m.practice;
      if (!p || p.list || !m.verifiedAt || PRACTICE_REGISTRY[p.format].perItemMinutes === null) return false;
      return (p.items ?? 0) > 0 || LIST_LIKE_RE.test(`${m.title} ${m.why ?? ""} ${m.uses ?? ""}`);
    })
    .sort((a, b) => (b.m.practice!.minutes ?? 0) - (a.m.practice!.minutes ?? 0) || a.i - b.i)
    .slice(0, MAX_ITEM_SEARCHES)
    .map(({ m }) => m);
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
  /** Finds a likely backbone's chapters on a web page when the catalogue had none. Omitted, the stage is skipped. */
  chapters?: ChapterFinder;
  /** Finds a practice source's real items. Omitted, the stage is skipped and sources are worked by count. */
  items?: ItemFinder;
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

/** The item-list finder the app ships, on the same search provider as the arm. Null when `TAVILY_API_KEY` is unset. */
export function defaultItemFinder(
  env: Record<string, string | undefined> = process.env,
  options: { model?: AiModelId | LanguageModel } = {},
): ItemFinder | null {
  const provider = searchProviderFromEnv(env);
  return provider ? createItemFinder({ provider, model: options.model }) : null;
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

  // Before the allocation, two lookups run side by side. The likely backbones' chapters: the gate took them from the
  // catalogue when it could; otherwise one search and a few reads look for a page that lists them, so the allocation can
  // still cut by chapter whichever it chooses. And the practice sources' real items: a few searches and reads look for
  // a readable copy of each list, so the plan can name the problems rather than a count.
  let materials = gate.materials;
  let costUsd = arm?.costUsd ?? 0;
  const counts = { searches: arm?.counts.searches ?? 0, fetches: arm?.counts.fetches ?? 0 };
  const chapterFinder = input.chapters;
  const itemFinder = input.items;
  const likely = chapterFinder ? likelyBackbones(materials) : [];
  const listed = itemFinder ? likelyItemLists(materials) : [];
  if (likely.length > 0 || listed.length > 0) {
    const [tocResults, itemResults] = yield* streamWhile<ResearchEvent, [(ChapterFinderResult | null)[], (ItemFinderResult | null)[]]>((emit) =>
      Promise.all([
        Promise.all(
          likely.map(async (book) => {
            let result: ChapterFinderResult | null = null;
            try {
              result = await chapterFinder!.find(book, { fetcher, emit, signal: input.signal, log: input.log });
            } catch (error) {
              if (input.log?.keyOwner === "user" && providerError(error)) throw error;
              console.error(`[research] chapter finder failed for "${book.title}"`, error);
            }
            const toc = result?.toc ?? null;
            emit({ type: "research.chapters", id: book.id, title: book.title, chapters: toc?.chapters.length ?? 0, source: toc?.source ?? null, ...(toc ? { url: toc.url } : {}) });
            return result;
          }),
        ),
        Promise.all(
          listed.map(async (source) => {
            let result: ItemFinderResult | null = null;
            try {
              result = await itemFinder!.find(source, { fetcher, emit, signal: input.signal, log: input.log });
            } catch (error) {
              if (input.log?.keyOwner === "user" && providerError(error)) throw error;
              console.error(`[research] item finder failed for "${source.title}"`, error);
            }
            const list = result?.list ?? null;
            emit({ type: "research.items", id: source.id, title: source.title, items: list?.items.length ?? 0, groups: list ? listGroups(list).length : 0, ...(list ? { url: list.url } : {}) });
            return result;
          }),
        ),
      ]),
    );
    const merge = (result: { counts: { searches: number; fetches: number }; costUsd: number }) => {
      counts.searches += result.counts.searches;
      counts.fetches += result.counts.fetches;
      costUsd += result.costUsd;
    };
    const tocs = new Map<string, NonNullable<ChapterFinderResult["toc"]>>();
    tocResults.forEach((result, i) => {
      if (!result) return;
      merge(result);
      if (result.toc) tocs.set(likely[i].id, result.toc);
    });
    const lists = new Map<string, PracticeList>();
    itemResults.forEach((result, i) => {
      if (!result) return;
      merge(result);
      if (result.list) lists.set(listed[i].id, result.list);
    });
    if (tocs.size > 0 || lists.size > 0) {
      materials = materials.map((m) => {
        const toc = tocs.get(m.id);
        const list = lists.get(m.id);
        if (!toc && !(list && m.practice)) return m;
        return { ...m, ...(toc ? { toc } : {}), ...(list && m.practice ? { practice: withItemList(m.practice, list) } : {}) };
      });
    }
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
