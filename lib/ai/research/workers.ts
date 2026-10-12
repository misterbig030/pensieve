import type { LanguageModel } from "ai";
import { hostOf } from "@/lib/schemas/material";
import type { SourceInput } from "@/lib/schemas/source";
import { DEFAULT_RESEARCH_MODEL, type AiModelId } from "../models";
import {
  RESEARCH_RULES,
  briefLines,
  runCandidateStep,
  runResearchLoop,
  type ArmInput,
  type ArmResult,
  type LoopResult,
  type ResearchArm,
  type StopReason,
  type WorkerSummary,
} from "./agent";
import type { ResearchEvent, WorkerDirection } from "./events";
import { RESEARCH_CAPS, ResearchNotes, type ResearchCaps, type SearchProvider, type SourceFetcher } from "./tools";
import { mapLimit, normalizeCoverage } from "./verify";

/**
 * Arm W: the learner's links are read in code, then one bounded worker per research direction runs concurrently
 * under a shared deadline, and their notes merge into the same candidate step and gate as arm A. The directions are
 * fixed in the briefs; no model decides whether a direction runs or when research stops.
 */

/** Share of the band's clock the workers get; the rest is for the candidate step. */
export const DEADLINE_SHARE = 0.75;
const LEARNER_READ_CONCURRENCY = 6;

export interface WorkerPlan {
  direction: WorkerDirection;
  /** This worker's share of the band: its own searches, reads and steps. `wallMs` is the shared deadline. */
  caps: ResearchCaps;
  /** At the smallest band the canonical worker covers currency too. */
  withCurrent: boolean;
}

/**
 * Divides a band's caps between the workers. The shares sum to the band's searches and reads; the band's step cap is
 * not used, each worker has its own. With three searches or fewer there are two workers. Caps that are not a band
 * are clamped so no worker gets an empty share, and may then exceed the caps given.
 */
export function splitCaps(caps: ResearchCaps): WorkerPlan[] {
  const wallMs = Math.round(caps.wallMs * DEADLINE_SHARE);
  if (caps.searches <= 3) {
    const backbone: ResearchCaps = { steps: 3, searches: Math.max(1, caps.searches - 1), fetches: Math.max(1, Math.ceil(caps.fetches / 2)), wallMs };
    const canonical: ResearchCaps = { steps: 2, searches: Math.max(1, caps.searches - backbone.searches), fetches: Math.max(1, caps.fetches - backbone.fetches), wallMs };
    return [
      { direction: "backbone", caps: backbone, withCurrent: false },
      { direction: "canonical", caps: canonical, withCurrent: true },
    ];
  }
  const wide = caps.searches >= 8;
  const current: ResearchCaps = { steps: 2, searches: wide ? 2 : 1, fetches: wide ? 5 : 3, wallMs };
  const canonical: ResearchCaps = { steps: 2, searches: caps.searches >= 6 ? 2 : 1, fetches: wide ? 5 : caps.searches >= 6 ? 4 : 3, wallMs };
  const backbone: ResearchCaps = {
    steps: caps.searches >= 6 ? 4 : 3,
    searches: Math.max(1, caps.searches - canonical.searches - current.searches),
    fetches: Math.max(1, caps.fetches - canonical.fetches - current.fetches),
    wallMs,
  };
  return [
    { direction: "backbone", caps: backbone, withCurrent: false },
    { direction: "canonical", caps: canonical, withCurrent: false },
    { direction: "current", caps: current, withCurrent: false },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Direction briefs: objective, strategy, boundaries, output

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const BACKBONE_BRIEF = [
  `Objective: the one well-recommended textbook the plan follows in order, where the topic has one: its exact title and author, and the pages on at least two different sites that recommend it. A book is checked against a library catalogue by those two, not by a page.`,
  `Strategy: in your first step, search from several angles at once (best book for the topic, university course syllabi, reading lists). Then read the two most independent recommending pages. Then try the leading book's publisher's or author's page once for a link; if it cannot be read, move on. If the learner provided a book, decide first whether it is the backbone and look for pages that recommend it rather than for a rival.`,
  `Boundaries: books only. Do not collect courses, documentation, videos or papers; other researchers do. Never a shop listing (Amazon or another retailer) as a book's page.`,
  `Output: when you have the leading book, its author and two recommending pages, or the budget is spent, stop calling tools and write a few lines of notes: the leading book and its author, the pages that recommend it, its own page if found, and any rival worth a mention.`,
];

const TWO_STEPS = `Do not write notes; the tool results are your notes.`;

const CANONICAL_BRIEF = (withCurrent: boolean) => [
  withCurrent
    ? `Objective: the canonical materials around the topic (the official documentation, the well-known courses and talks, the standard papers and repositories) and, where the field moves fast, one or two things from the last two years that cover what the standard texts predate.`
    : `Objective: the canonical materials around the topic: the official documentation, the well-known courses and talks, the standard papers and repositories.`,
  `Strategy: you have two steps. In the first, make all your searches at once. In the second, read the pages worth reading, all at once, preferring each material's own page. Note how long a material is whenever its page says so (pages, runtime, course hours, words). ${TWO_STEPS}`,
  `Boundaries: no books; another researcher collects them. A material's URL is its own page.`,
];

const CURRENT_BRIEF = [
  `Objective: material from the last two years that covers what the standard texts predate, where the field moves fast.`,
  `Strategy: you have two steps. In the first, make your searches for recent material at once. If nothing in the results is from the last two years, the field does not move fast: stop. Otherwise, in the second step read the recent results worth reading, all at once, preferring each material's own page. ${TWO_STEPS}`,
  `Boundaries: published within the last two years. No books; another researcher collects them.`,
];

/** One worker's system prompt: direction, tools and budget, then objective, strategy, boundaries and output, then the shared rules. */
export function buildWorkerInstructions(plan: WorkerPlan): string {
  const { caps, direction } = plan;
  const body = direction === "backbone" ? BACKBONE_BRIEF : direction === "canonical" ? CANONICAL_BRIEF(plan.withCurrent) : CURRENT_BRIEF;
  return [
    `Direction: ${direction}.`,
    `You research one direction of the materials for a self-study plan; other researchers cover the other directions at the same time, so stay inside yours. The learner's own sources have already been read: what they are is in the brief, so do not read them again.`,
    `You have two tools. webSearch returns titles, URLs and snippets. fetchSource reads one https page and returns its own title, headings and text. Budget: ${count(caps.searches, "search", "searches")}, ${count(caps.fetches, "page read", "page reads")} and ${caps.steps} steps in all; calls past a cap are refused.`,
    ...body,
    RESEARCH_RULES,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Learner links, the merge, and the fold

export const LEARNER_HEADING = `The learner's sources, already read (always kept; do not read them again):`;

/**
 * Reads the learner's links through the shared fetcher, as the model did in arm A's first turn, into a notes object
 * whose rendering is part of the workers' brief and the first section of the merged notes. Failed reads are recorded
 * too: the source is kept whatever happened.
 */
export async function readLearnerLinks(sources: SourceInput[], fetcher: SourceFetcher, emit: (event: ResearchEvent) => void, signal?: AbortSignal): Promise<ResearchNotes> {
  const notes = new ResearchNotes();
  const links = sources.filter((s, i, all) => (s.type === "link" || s.type === "youtube") && all.findIndex((o) => o.url === s.url) === i);
  await mapLimit(links, LEARNER_READ_CONCURRENCY, async (source) => {
    emit({ type: "research.reading", url: source.url });
    const outcome = await fetcher.fetch(source.url, signal);
    if (!outcome.ok) {
      notes.fetches.push({ url: source.url, ok: false, title: source.title ?? hostOf(source.url), finalUrl: null, reason: outcome.reason, excerpt: "" });
      emit({ type: "research.fetch", url: source.url, ok: false, reason: outcome.reason });
      return;
    }
    const { page } = outcome;
    notes.fetches.push({
      url: source.url,
      ok: true,
      title: page.ogTitle ?? page.title ?? page.h1 ?? source.title ?? null,
      finalUrl: page.finalUrl,
      excerpt: page.text.slice(0, 400).replace(/\s+/g, " "),
      words: page.words ?? null,
      durationMinutes: page.durationMinutes ?? null,
    });
    emit({ type: "research.fetch", url: source.url, ok: true });
  });
  return notes;
}

export const DIRECTION_HEADINGS: Record<WorkerDirection, string> = {
  backbone: "Backbone research:",
  canonical: "Canonical materials:",
  current: "Recent material:",
};

const headingFor = (plan: WorkerPlan) => (plan.direction === "canonical" && plan.withCurrent ? "Canonical and recent material:" : DIRECTION_HEADINGS[plan.direction]);

/** The candidate step's notes: the learner's sources, then each worker's notes under its direction's heading; and every URL any of them saw. */
export function mergeNotes(learner: ResearchNotes, workers: { plan: WorkerPlan; notes: ResearchNotes }[]): { text: string; seenUrls: Set<string> } {
  const sections: string[] = [];
  const seenUrls = new Set<string>();
  const add = (heading: string, notes: ResearchNotes) => {
    sections.push(`${heading}\n${notes.render() || "(nothing)"}`);
    for (const url of notes.seenUrls()) seenUrls.add(url);
  };
  if (learner.fetches.length > 0) add("The learner's sources:", learner);
  for (const w of workers) add(headingFor(w.plan), w.notes);
  return { text: sections.join("\n\n"), seenUrls };
}

/** Distinct search-result URLs that more than one worker's searches returned, over all distinct ones. Null when the searches returned nothing. */
export function duplicateShare(workers: { notes: ResearchNotes }[]): number | null {
  const seenBy = new Map<string, number>();
  for (const w of workers) {
    const mine = new Set<string>();
    for (const s of w.notes.searches) for (const r of s.results) mine.add(r.url);
    for (const url of mine) seenBy.set(url, (seenBy.get(url) ?? 0) + 1);
  }
  if (seenBy.size === 0) return null;
  let shared = 0;
  for (const n of seenBy.values()) if (n > 1) shared += 1;
  return shared / seenBy.size;
}

/**
 * One stop reason for the run. Cancellation and an outage come first, then a deadline nobody beat; after that the
 * backbone worker decides, because it carries the loop and the plan's spine.
 */
export function foldStopReason(workers: { direction: WorkerDirection; stoppedBy: StopReason; searchesOk: number; toolResults: number }[], cancelled: boolean): StopReason {
  if (cancelled || workers.some((w) => w.stoppedBy === "cancelled")) return "cancelled";
  const searchesOk = workers.reduce((n, w) => n + w.searchesOk, 0);
  if (searchesOk === 0 && workers.every((w) => w.stoppedBy === "search-error")) return "search-error";
  const results = workers.reduce((n, w) => n + w.toolResults, 0);
  if (results === 0 && workers.every((w) => w.stoppedBy === "clock")) return "clock-idle";
  const backbone = workers.find((w) => w.direction === "backbone");
  if (backbone?.stoppedBy === "clock") return "clock";
  if (backbone?.stoppedBy === "steps") return "steps";
  if (backbone?.stoppedBy === "search-error") return "search-error";
  return "model";
}

// ---------------------------------------------------------------------------------------------------------------
// The arm

export interface WorkersArmOptions {
  provider: SearchProvider;
  model?: AiModelId | LanguageModel;
  caps?: ResearchCaps;
  clock?: () => number;
}

const sum = <T>(items: T[], pick: (item: T) => number) => items.reduce((n, item) => n + pick(item), 0);

export function createWorkersArm(options: WorkersArmOptions): ResearchArm {
  const model = options.model ?? DEFAULT_RESEARCH_MODEL;

  return async function researchWorkers({ brief, signal, fetcher, emit, log, caps: runCaps }: ArmInput): Promise<ArmResult> {
    const caps = options.caps ?? runCaps ?? RESEARCH_CAPS;
    const learner = await readLearnerLinks(brief.sources, fetcher, emit, signal);
    const plans = splitCaps(caps);
    const prompt = [...briefLines(brief), ...(learner.fetches.length > 0 ? [LEARNER_HEADING, learner.render()] : [])].join("\n");

    // One deadline for every worker, armed once the learner's links are in.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), plans[0].caps.wallMs);
    const tagged = (direction: WorkerDirection) => (event: ResearchEvent) =>
      emit(event.type === "research.search" || event.type === "research.reading" || event.type === "research.fetch" ? { ...event, worker: direction } : event);

    const runs = await Promise.all(
      plans.map(async (plan) => {
        const notes = new ResearchNotes();
        const started = performance.now();
        let loop: LoopResult;
        try {
          loop = await runResearchLoop({
            model,
            instructions: buildWorkerInstructions(plan),
            prompt,
            caps: plan.caps,
            deadline: deadline.signal,
            provider: options.provider,
            fetcher,
            notes,
            emit: tagged(plan.direction),
            log,
            label: `Research · ${plan.direction}`,
            signal,
            clock: options.clock,
          });
        } catch (error) {
          // A failed model call ends this worker like a search outage; its notes so far stay and the others go on.
          console.error(`[research] ${plan.direction} worker failed`, error);
          loop = { steps: 0, searches: notes.searches.length, fetches: notes.fetches.length, searchesOk: notes.searches.length, stoppedBy: "search-error", costUsd: 0 };
        }
        return { plan, notes, loop, durationMs: Math.round(performance.now() - started) };
      }),
    );
    clearTimeout(timer);

    const workers: WorkerSummary[] = runs.map((r) => ({ direction: r.plan.direction, steps: r.loop.steps, searches: r.loop.searches, fetches: r.loop.fetches, stoppedBy: r.loop.stoppedBy, durationMs: r.durationMs, costUsd: r.loop.costUsd }));
    const stoppedBy = foldStopReason(
      runs.map((r) => ({ direction: r.plan.direction, stoppedBy: r.loop.stoppedBy, searchesOk: r.loop.searchesOk, toolResults: r.notes.searches.length + r.notes.fetches.length })),
      signal?.aborted ?? false,
    );
    const merged = mergeNotes(learner, runs);
    const loopCost = sum(runs, (r) => r.loop.costUsd);
    const base = {
      seenUrls: merged.seenUrls,
      counts: { steps: sum(runs, (r) => r.loop.steps), searches: sum(runs, (r) => r.loop.searches), fetches: learner.fetches.length + sum(runs, (r) => r.loop.fetches) },
      searchesOk: sum(runs, (r) => r.loop.searchesOk),
      workers,
      duplicateShare: duplicateShare(runs),
    };
    if (stoppedBy === "cancelled") return { ...base, candidates: [], learnerNotes: [], stoppedBy, costUsd: loopCost };

    const { list, costUsd } = await runCandidateStep({
      model,
      brief,
      notes: merged.text,
      grouped: true,
      signal,
      log,
      facts: [`stopped by ${stoppedBy}`, ...workers.map((w) => `${w.direction}: ${w.steps} steps, ${w.stoppedBy}`)],
    });
    return { ...base, candidates: list.candidates, learnerNotes: list.learner, stoppedBy, costUsd: loopCost + costUsd, coverage: normalizeCoverage(list.coverage) };
  };
}
