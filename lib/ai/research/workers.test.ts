import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { PRACTICE_REGISTRY, type PracticePick } from "@/lib/practice";
import { providerError } from "../providerError";
import type { ModelCall } from "../logged";
import { initialResearch, reduceResearch } from "@/lib/researchProgress";
import { RESEARCH_RULES, type StopReason } from "./agent";
import type { ResearchEvent, WorkerDirection } from "./events";
import type { PageInfo } from "./extract";
import { defaultArm, researchMaterials } from "./pipeline";
import { ResearchNotes, SourceFetcher, capsFor, type PageFetcher, type ResearchCaps, type SearchProvider } from "./tools";
import type { BookLookup, CandidateList } from "./verify";
import { DEADLINE_SHARE, buildWorkerInstructions, createWorkersArm, duplicateShare, foldStopReason, mergeNotes, splitCaps } from "./workers";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

type Step = { calls: { tool: "webSearch" | "fetchSource"; input: Record<string, string> }[] } | { text: string } | "throw";
/** A worker's script: its steps in order ("throw" fails that call), or a model that hangs until aborted, or one that fails at once. */
type Script = Step[] | "hang" | "throw";

let callSeq = 0;
function stepResult(step: Exclude<Step, "throw">): LanguageModelV4GenerateResult {
  if ("text" in step) return { content: [{ type: "text", text: step.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  return {
    content: step.calls.map((c) => ({ type: "tool-call" as const, toolCallId: `call-${++callSeq}`, toolName: c.tool, input: JSON.stringify(c.input) })),
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

function directionOf(options: LanguageModelV4CallOptions): WorkerDirection | null {
  const system = options.prompt.find((m) => m.role === "system");
  const match = typeof system?.content === "string" ? /^Direction: (backbone|canonical|current|practice)\./m.exec(system.content) : null;
  return (match?.[1] as WorkerDirection | undefined) ?? null;
}

/** The user-side text of a call, to check what a worker was told. */
function userText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((m) => m.role === "user")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n");
}

/** One model for every worker: each loop call is routed to its direction's script; the structured step answers `finals`. */
function directedModel(scripts: Partial<Record<WorkerDirection, Script>>, finals: (CandidateList | string)[]) {
  const queues = new Map<WorkerDirection, Step[]>();
  const answers = [...finals];
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      if (options.responseFormat?.type === "json") {
        const next = answers.length > 1 ? answers.shift()! : answers[0];
        return { content: [{ type: "text", text: typeof next === "string" ? next : JSON.stringify(next) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      }
      const direction = directionOf(options);
      if (!direction) throw new Error("loop call without a Direction line");
      const script = scripts[direction] ?? [];
      if (script === "hang") {
        await new Promise((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason)));
        throw new Error("unreachable");
      }
      if (script === "throw") throw new Error(`${direction} model is down`);
      if (!queues.has(direction)) queues.set(direction, [...script]);
      const step = queues.get(direction)!.shift() ?? { text: "Done." };
      if (step === "throw") throw new Error(`${direction} model is down`);
      return stepResult(step);
    },
  });
  return { model, calls };
}

function page(url: string, title: string): PageInfo {
  return { finalUrl: url, title, ogTitle: null, h1: null, author: null, published: null, text: `About ${title}` };
}

function fakeProvider(): SearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    name: "fake",
    search: vi.fn(async (query: string) => [
      { title: `Result for ${query}`, url: "https://lists.bookrecs.com/best", snippet: "best", publishedDate: null },
      { title: "Another list", url: "https://blog.readinglist.org/reading", snippet: "reading", publishedDate: null },
    ]),
  };
}

const PAGES: Record<string, PageInfo> = {
  "https://docs.example.com/a": page("https://docs.example.com/a", "Guide A"),
  "https://docs.example.com/b": page("https://docs.example.com/b", "Guide B"),
  "https://learner.example.com/mine": page("https://learner.example.com/mine", "My notes page"),
  "https://books.example.com/core": page("https://books.example.com/core", "Core Textbook"),
};

function fetcherFor(pages: Record<string, PageInfo> = PAGES) {
  const fetchPage = vi.fn<PageFetcher>(async (url) => {
    const p = pages[url];
    if (!p) throw new Error(`404 ${url}`);
    return p;
  });
  return { fetcher: new SourceFetcher(fetchPage), fetchPage };
}

const books: BookLookup = { find: async () => ({ key: "/works/OL1W", title: "Core Textbook", authors: ["A. Author"], year: 2023 }) };

const LIST: CandidateList = {
  learner: [{ url: "https://learner.example.com/mine", kind: "essay", why: "Where the learner started" }],
  candidates: [
    { url: "https://books.example.com/core", title: "Core Textbook", kind: "book", backbone: true, author: "A. Author", why: "The standard text", recommendedBy: ["https://lists.bookrecs.com/best", "https://blog.readinglist.org/reading"] },
    { url: "https://docs.example.com/a", title: "Guide A", kind: "docs", backbone: false, why: "Official docs", recommendedBy: [] },
    { url: "https://docs.example.com/b", title: "Guide B", kind: "docs", backbone: false, why: "More docs", recommendedBy: [] },
  ],
};

/** 12 weeks at six hours a week: the 100-hour band (6 searches, 12 reads), where the backbone worker has four steps. */
const brief = { topic: "LLM engineering", weeks: 12, sources: [{ url: "https://learner.example.com/mine", type: "link" as const }] };

const SCRIPTS: Record<"backbone" | "canonical" | "current", Step[]> = {
  backbone: [
    { calls: [{ tool: "webSearch", input: { query: "best llm engineering book" } }] },
    { calls: [{ tool: "fetchSource", input: { url: "https://books.example.com/core" } }] },
    { text: "Core Textbook is recommended by two lists." },
  ],
  canonical: [
    { calls: [{ tool: "webSearch", input: { query: "llm engineering official docs" } }] },
    { calls: [{ tool: "fetchSource", input: { url: "https://docs.example.com/a" } }, { tool: "fetchSource", input: { url: "https://docs.example.com/b" } }] },
  ],
  current: [{ calls: [{ tool: "webSearch", input: { query: "llm engineering 2026" } }] }, { text: "Nothing recent." }],
};

async function collect(gen: AsyncGenerator<ResearchEvent, unknown>) {
  const events: ResearchEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, outcome: next.value as Awaited<ReturnType<typeof researchMaterials>> extends AsyncGenerator<unknown, infer R> ? R : never };
}

const candidatePrompt = (calls: LanguageModelV4CallOptions[]) => userText(calls.find((c) => c.responseFormat?.type === "json")!);

describe("splitCaps", () => {
  it("divides each band between the workers so the shares sum to the band", () => {
    for (const hours of [6, 30, 72, 360]) {
      const caps = capsFor(hours);
      const plans = splitCaps(caps, false);
      expect(plans.reduce((n, p) => n + p.caps.searches, 0)).toBe(caps.searches);
      expect(plans.reduce((n, p) => n + p.caps.fetches, 0)).toBe(caps.fetches);
      expect(plans.every((p) => p.caps.wallMs === Math.round(caps.wallMs * DEADLINE_SHARE))).toBe(true);
      expect(plans.filter((p) => p.direction !== "backbone").every((p) => p.caps.steps === 2)).toBe(true);
    }
    expect(splitCaps(capsFor(6), false).map((p) => [p.direction, p.caps.searches, p.caps.fetches, p.caps.steps, p.withCurrent])).toEqual([["backbone", 2, 3, 3, false], ["canonical", 1, 3, 2, true]]);
    expect(splitCaps(capsFor(30), false).map((p) => [p.direction, p.caps.searches, p.caps.fetches, p.caps.steps])).toEqual([["backbone", 3, 4, 3], ["canonical", 1, 3, 2], ["current", 1, 3, 2]]);
    expect(splitCaps(capsFor(72), false).map((p) => [p.direction, p.caps.searches, p.caps.fetches, p.caps.steps])).toEqual([["backbone", 3, 5, 4], ["canonical", 2, 4, 2], ["current", 1, 3, 2]]);
    expect(splitCaps(capsFor(360), false).map((p) => [p.direction, p.caps.searches, p.caps.fetches, p.caps.steps])).toEqual([["backbone", 4, 6, 4], ["canonical", 2, 5, 2], ["current", 2, 5, 2]]);
    // Caps that are not a band never produce an empty share; they may then exceed the caps given.
    expect(splitCaps({ steps: 3, searches: 4, fetches: 3, wallMs: 60_000 }, false).every((p) => p.caps.searches >= 1 && p.caps.fetches >= 1)).toBe(true);
  });
});

describe("splitCaps with practice", () => {
  const shape = (hours: number) => splitCaps(capsFor(hours), true).map((p) => [p.direction, p.caps.searches, p.caps.fetches, p.caps.steps]);

  it("adds a two-step practice worker and keeps the band's searches and reads", () => {
    for (const hours of [6, 30, 72, 360]) {
      const caps = capsFor(hours);
      const plans = splitCaps(caps, true);
      expect(plans.at(-1)?.direction).toBe("practice");
      expect(plans.at(-1)?.caps.steps).toBe(2);
      expect(plans.reduce((n, p) => n + p.caps.searches, 0)).toBe(caps.searches);
      expect(plans.reduce((n, p) => n + p.caps.fetches, 0)).toBe(caps.fetches);
      expect(plans.every((p) => p.caps.searches >= 1 && p.caps.fetches >= 1)).toBe(true);
      expect(plans.every((p) => p.caps.wallMs === Math.round(caps.wallMs * DEADLINE_SHARE))).toBe(true);
      expect(plans.at(-1)?.picks).toBeUndefined();
    }
  });

  it("gives the practice worker a quarter of the band, taken from canonical first and then current", () => {
    expect(shape(72)).toEqual([["backbone", 3, 5, 4], ["canonical", 1, 1, 2], ["current", 1, 3, 2], ["practice", 1, 3, 2]]);
    expect(shape(360)).toEqual([["backbone", 4, 6, 4], ["canonical", 1, 1, 2], ["current", 1, 5, 2], ["practice", 2, 4, 2]]);
  });

  it("takes the practice worker's share from canonical at the smallest band, where only two workers run", () => {
    const plans = splitCaps(capsFor(6), true);
    expect(plans.map((p) => p.direction)).toEqual(["backbone", "canonical", "practice"]);
    expect(plans.find((p) => p.direction === "canonical")).toMatchObject({ withCurrent: true, caps: { fetches: 1 } });
    expect(plans.find((p) => p.direction === "practice")?.caps).toMatchObject({ searches: 1, fetches: 2 });
  });

  it("leaves today's split alone without practice", () => {
    for (const hours of [6, 30, 72, 360]) expect(splitCaps(capsFor(hours), false).map((p) => p.direction)).not.toContain("practice");
    expect(splitCaps(capsFor(72), false).map((p) => [p.direction, p.caps.searches, p.caps.fetches])).toEqual([["backbone", 3, 5], ["canonical", 2, 4], ["current", 1, 3]]);
  });
});

describe("buildWorkerInstructions", () => {
  const [backbone, canonical, current] = splitCaps(capsFor(72), false);
  it("names the direction, its boundary and its own budget, and keeps the rules", () => {
    const b = buildWorkerInstructions(backbone);
    expect(b.startsWith("Direction: backbone.\n")).toBe(true);
    expect(b).toContain("Boundaries: books only.");
    expect(b).toContain("Budget: 3 searches, 5 page reads and 4 steps in all");
    // Four steps: searches, the recommenders, the publisher page, then notes.
    expect(b).toContain("you have 4 steps, and the last must be your notes");
    expect(b).toContain("In your last step the tools are taken away");
    expect(b).toContain("Then try the leading book's publisher's or author's page once");
    const c = buildWorkerInstructions(canonical);
    expect(c.startsWith("Direction: canonical.\n")).toBe(true);
    expect(c).toContain("Boundaries: no books");
    expect(c).toContain("Budget: 2 searches, 4 page reads and 2 steps in all");
    expect(c).not.toContain("last two years");
    // A two-step worker has no turn to write anything after its reads.
    expect(c).not.toContain("Note how long");
    expect(c).toContain("Do not write notes");
    const r = buildWorkerInstructions(current);
    expect(r.startsWith("Direction: current.\n")).toBe(true);
    expect(r).toContain("Boundaries: published within the last two years. No books");
    expect(r).toContain("Budget: 1 search, 3 page reads and 2 steps in all");
    for (const text of [b, c, r]) expect(text).toContain(RESEARCH_RULES);
  });
  it("tells the practice worker what to look for, pick by pick, and to keep to practice sources", () => {
    const picks: PracticePick[] = [
      { format: "problem-set", share: 60, focus: "dynamic programming", reason: "r" },
      { format: "mock", share: 40, focus: "system design rounds", reason: "r" },
    ];
    const practice = splitCaps(capsFor(72), true).find((p) => p.direction === "practice")!;
    const text = buildWorkerInstructions({ ...practice, picks });
    expect(text.startsWith("Direction: practice.\n")).toBe(true);
    for (const pick of picks) expect(text).toContain(`${PRACTICE_REGISTRY[pick.format].research} for: ${pick.focus}`);
    expect(text).toContain("Boundaries: practice sources only");
    expect(text).toContain("Prefer ones that come with answers");
    expect(text).toContain("Budget: 1 search, 3 page reads and 2 steps in all");
    expect(text).toContain("Do not write notes");
    expect(text).toContain(RESEARCH_RULES);
  });
  it("asks the canonical worker for recent material too at the smallest band", () => {
    const [, combined] = splitCaps(capsFor(6), false);
    expect(buildWorkerInstructions(combined)).toContain("last two years");
  });
  it("fits the backbone strategy into three steps where the band gives three", () => {
    const [backbone] = splitCaps(capsFor(30), false);
    const b = buildWorkerInstructions(backbone);
    expect(b).toContain("you have 3 steps, and the last must be your notes");
    expect(b).toContain("the leading book's publisher's or author's page, all at once. Third, write your notes.");
    expect(b).not.toContain("Then try the leading book's publisher's or author's page once");
  });
});

describe("arm W through the pipeline", () => {
  it("reads the learner's links first, runs the three directions at once and merges their notes", async () => {
    const { model, calls } = directedModel(SCRIPTS, [LIST]);
    const { fetcher, fetchPage } = fetcherFor();
    const log: ModelCall[] = [];
    const { events, outcome } = await collect(
      researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books, log: { onCall: (c) => void log.push(c) } }),
    );

    // The learner's link is read by code before any worker searches, and without a worker tag.
    expect(events.slice(0, 3)).toEqual([
      { type: "research.start", caps: { searches: 6, fetches: 12, steps: 12 } },
      { type: "research.reading", url: "https://learner.example.com/mine" },
      { type: "research.fetch", url: "https://learner.example.com/mine", ok: true },
    ]);
    const searches = events.filter((e) => e.type === "research.search");
    expect(new Set(searches.map((e) => e.worker))).toEqual(new Set(["backbone", "canonical", "current"]));
    expect(events.filter((e) => e.type === "research.fetch" && e.worker === "canonical")).toHaveLength(2);
    // Every worker was told what the learner's source is.
    const firstSteps = calls.filter((c) => directionOf(c) && !c.prompt.some((m) => m.role === "assistant"));
    expect(firstSteps.map(directionOf).sort()).toEqual(["backbone", "canonical", "current"]);
    for (const c of firstSteps) expect(userText(c)).toContain('title "My notes page"');
    // The cache: learner page once, the three pages the workers read once each, the gate reads nothing again.
    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(outcome.arm?.counts).toEqual({ steps: 7, searches: 3, fetches: 4 });
    expect(outcome.arm?.stoppedBy).toBe("model");
    expect(outcome.arm?.workers?.map((w) => [w.direction, w.steps, w.searches, w.fetches, w.stoppedBy])).toEqual([
      ["backbone", 3, 1, 1, "model"],
      ["canonical", 2, 1, 2, "steps"],
      ["current", 2, 1, 0, "steps"],
    ]);
    expect(outcome.arm?.duplicateShare).toBe(1); // the fake provider returns the same two URLs to every query
    // The candidate step sees every direction under its heading, and the learner's source.
    const prompt = candidatePrompt(calls);
    for (const heading of ["The learner's sources", "Backbone research:", "Canonical materials:", "Recent material:", "grouped by the research direction"]) expect(prompt).toContain(heading);
    expect(prompt.indexOf("Backbone research:")).toBeLessThan(prompt.indexOf("Canonical materials:"));
    expect(outcome.materials.map((m) => [m.title, m.origin, m.backbone])).toEqual([
      ["Core Textbook", "research", true],
      ["My notes page", "learner", false],
      ["Guide A", "research", false],
      ["Guide B", "research", false],
    ]);
    expect(outcome.notice).toBeUndefined();
    // Admin-panel labels name the worker; the structured step keeps its label.
    const labels = log.map((c) => c.label);
    for (const l of ["Research · backbone · step 1", "Research · backbone · step 3", "Research · canonical · step 2", "Research · current · step 1", "Research · candidates"]) expect(labels).toContain(l);
    expect(log.every((c) => c.caller === "research")).toBe(true);
    // The existing reducer counts across workers.
    const state = events.reduce((s, e) => reduceResearch(s, e, new Set(["https://learner.example.com/mine"])), initialResearch());
    expect(state.searches).toBe(3);
    expect(state.reads).toBe(4);
  });

  it("runs a practice worker when the brief's split has picks, and hands the picks to it alone", async () => {
    const picks: PracticePick[] = [{ format: "problem-set", share: 100, focus: "graph problems", reason: "r" }];
    const split = { readingShare: 60, practice: "problems", formats: picks, reason: "r" };
    const { model, calls } = directedModel({ ...SCRIPTS, practice: [{ calls: [{ tool: "webSearch", input: { query: "graph problems with solutions" } }] }, { text: "Done." }] }, [LIST]);
    const { fetcher } = fetcherFor();
    const { events, outcome } = await collect(researchMaterials({ brief: { ...brief, split }, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books }));
    expect(outcome.arm?.workers?.map((w) => w.direction)).toEqual(["backbone", "canonical", "current", "practice"]);
    expect(events.filter((e) => e.type === "research.search" && e.worker === "practice")).toHaveLength(1);
    const system = (direction: string) => String(calls.find((c) => directionOf(c) === direction)!.prompt.find((m) => m.role === "system")?.content);
    expect(system("practice")).toContain("for: graph problems");
    expect(system("canonical")).not.toContain("graph problems");
    const prompt = candidatePrompt(calls);
    expect(prompt).toContain("Practice sources:");
    expect(prompt).toContain("problem-set");
  });

  it("runs the three directions as before when the split has no picks", async () => {
    const split = { readingShare: 100, practice: "none", formats: [], reason: "r" };
    const { model } = directedModel(SCRIPTS, [LIST]);
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief: { ...brief, split }, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books }));
    expect(outcome.arm?.workers?.map((w) => w.direction)).toEqual(["backbone", "canonical", "current"]);
  });

  it("runs two workers at the smallest band, canonical covering recent material", async () => {
    const { model, calls } = directedModel(SCRIPTS, [LIST]);
    const { fetcher } = fetcherFor();
    const { events, outcome } = await collect(
      researchMaterials({ brief: { ...brief, weeks: 1, hoursPerWeek: 3 }, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books }),
    );
    expect(events[0]).toEqual({ type: "research.start", caps: { searches: 3, fetches: 6, steps: 8 } });
    expect(outcome.arm?.workers?.map((w) => w.direction)).toEqual(["backbone", "canonical"]);
    const canonical = calls.find((c) => directionOf(c) === "canonical")!;
    expect(canonical.prompt.find((m) => m.role === "system")?.content).toContain("last two years");
    expect(candidatePrompt(calls)).toContain("Canonical and recent material:");
  });

  it("holds each worker to its own share, and shares the page cache between them", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ tool: "webSearch" as const, input: { query: `b${i}` } }));
    const { model } = directedModel(
      {
        backbone: [{ calls: many }],
        canonical: [{ calls: [{ tool: "webSearch", input: { query: "c0" } }, { tool: "webSearch", input: { query: "c1" } }] }, { calls: [{ tool: "fetchSource", input: { url: "https://docs.example.com/a" } }] }],
        current: [{ calls: [{ tool: "webSearch", input: { query: "r0" } }] }, { calls: [{ tool: "fetchSource", input: { url: "https://docs.example.com/a" } }] }],
      },
      [{ learner: [], candidates: [] }],
    );
    const provider = fakeProvider();
    const { fetcher, fetchPage } = fetcherFor();
    // No learner links, so the counts are the workers' alone; 4 weeks is the 40-hour band: shares 3, 1 and 1.
    const { outcome } = await collect(researchMaterials({ brief: { ...brief, weeks: 4, sources: [] }, arm: createWorkersArm({ provider, model }), fetcher, books }));
    // backbone 3 of 5 asked, canonical 1 of 2 asked, current 1: the band's five.
    expect(provider.search).toHaveBeenCalledTimes(5);
    expect(provider.search.mock.calls.map((c) => c[0] as string).filter((q) => q.startsWith("b"))).toHaveLength(3);
    expect(outcome.arm?.counts.searches).toBe(5);
    // Two workers read the same page: two budget units, one fetch.
    expect(outcome.arm?.counts.fetches).toBe(2);
    expect(fetchPage.mock.calls.filter((c) => c[0] === "https://docs.example.com/a")).toHaveLength(1);
  });

  it("ends with clock when the deadline cuts the backbone worker, keeping the other workers' notes", async () => {
    const { model, calls } = directedModel({ backbone: "hang", canonical: SCRIPTS.canonical, current: SCRIPTS.current }, [LIST]);
    const { fetcher } = fetcherFor();
    const caps: ResearchCaps = { ...capsFor(30), wallMs: 80 };
    const { outcome } = await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model, caps }), fetcher, books, caps }));
    expect(outcome.arm?.stoppedBy).toBe("clock");
    expect(outcome.arm?.workers?.find((w) => w.direction === "backbone")?.stoppedBy).toBe("clock");
    expect(candidatePrompt(calls)).toContain('Search: "llm engineering official docs"');
    expect(outcome.materials.length).toBeGreaterThan(1);
  });

  it("reports search-error and research unavailable when every worker's search fails", async () => {
    const { model } = directedModel(
      { backbone: [{ calls: [{ tool: "webSearch", input: { query: "b" } }] }], canonical: [{ calls: [{ tool: "webSearch", input: { query: "c" } }] }], current: [{ calls: [{ tool: "webSearch", input: { query: "r" } }] }] },
      [{ learner: [], candidates: [] }],
    );
    const provider = fakeProvider();
    provider.search.mockRejectedValue(new Error("503"));
    const { fetcher } = fetcherFor();
    const { events, outcome } = await collect(researchMaterials({ brief, arm: createWorkersArm({ provider, model }), fetcher, books }));
    expect(provider.search).toHaveBeenCalledTimes(3);
    expect(outcome.arm?.stoppedBy).toBe("search-error");
    expect(outcome.notice).toBe("unavailable");
    expect(outcome.materials.map((m) => m.origin)).toEqual(["learner"]);
    expect(events.at(-1)).toMatchObject({ type: "research.done", notice: "unavailable" });
  });

  it("cancels every worker on a client disconnect", async () => {
    const controller = new AbortController();
    const provider: SearchProvider = {
      name: "slow",
      search: (_q, { signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => controller.abort(), 5);
        }),
    };
    const { model, calls } = directedModel(SCRIPTS, [LIST]);
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief, arm: createWorkersArm({ provider, model }), fetcher, books, signal: controller.signal }));
    expect(outcome.arm?.stoppedBy).toBe("cancelled");
    expect(outcome.notice).toBe("unavailable");
    expect(calls.some((c) => c.responseFormat?.type === "json")).toBe(false);
  });

  it("keeps the other workers' notes, and the failed worker's counts, when one worker's model fails", async () => {
    // The current worker's model fails on its second call, after one search went through.
    const { model, calls } = directedModel({ backbone: SCRIPTS.backbone, canonical: SCRIPTS.canonical, current: [SCRIPTS.current[0], "throw"] }, [LIST]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books }));
    errors.mockRestore();
    expect(outcome.arm?.stoppedBy).toBe("model");
    expect(outcome.arm?.workers?.find((w) => w.direction === "current")).toMatchObject({ stoppedBy: "search-error", steps: 1, searches: 1 });
    expect(outcome.arm?.counts).toEqual({ steps: 6, searches: 3, fetches: 4 });
    expect(outcome.arm?.searchesOk).toBe(3);
    expect(candidatePrompt(calls)).toContain("Core Textbook");
    expect(candidatePrompt(calls)).toContain('Search: "llm engineering 2026"');
    expect(outcome.materials).toHaveLength(4);
  });
});

describe("folding the workers", () => {
  const w = (direction: WorkerDirection, stoppedBy: StopReason, searchesOk = 1, toolResults = 1) => ({ direction, stoppedBy, searchesOk, toolResults });
  it("orders the stop reasons: cancelled, outage, idle, then the backbone's", () => {
    expect(foldStopReason([w("backbone", "model"), w("canonical", "steps")], true)).toBe("cancelled");
    expect(foldStopReason([w("backbone", "model"), w("canonical", "cancelled")], false)).toBe("cancelled");
    expect(foldStopReason([w("backbone", "search-error", 0, 0), w("canonical", "search-error", 0, 0)], false)).toBe("search-error");
    expect(foldStopReason([w("backbone", "search-error", 0, 0), w("canonical", "steps", 1, 2)], false)).toBe("search-error");
    expect(foldStopReason([w("backbone", "clock", 0, 0), w("canonical", "clock", 0, 0)], false)).toBe("clock-idle");
    expect(foldStopReason([w("backbone", "clock", 0, 0), w("canonical", "steps", 1, 2)], false)).toBe("clock");
    expect(foldStopReason([w("backbone", "steps"), w("canonical", "clock")], false)).toBe("steps");
    expect(foldStopReason([w("backbone", "model"), w("canonical", "steps"), w("current", "clock")], false)).toBe("model");
  });

  it("merges the notes under one heading per direction with the union of URLs", () => {
    const [backbone, canonical] = splitCaps(capsFor(6), false);
    const learner = new ResearchNotes();
    learner.fetches.push({ url: "https://learner.example.com/mine", ok: true, title: "My notes page", finalUrl: "https://learner.example.com/mine", excerpt: "mine" });
    const b = new ResearchNotes();
    b.searches.push({ query: "best book", results: [{ title: "List", url: "https://lists.bookrecs.com/best", snippet: "", publishedDate: null }] });
    const c = new ResearchNotes();
    c.fetches.push({ url: "https://docs.example.com/a", ok: true, title: "Guide A", finalUrl: "https://docs.example.com/a", excerpt: "a" });
    const merged = mergeNotes(learner, [{ plan: backbone, notes: b }, { plan: canonical, notes: c }]);
    expect(merged.text).toMatch(/^The learner's sources:\n/);
    expect(merged.text).toContain('\n\nBackbone research:\nSearch: "best book"');
    expect(merged.text).toContain("\n\nCanonical and recent material:\nRead <https://docs.example.com/a>");
    expect(merged.seenUrls).toEqual(new Set(["https://learner.example.com/mine", "https://lists.bookrecs.com/best", "https://docs.example.com/a"]));
    expect(mergeNotes(new ResearchNotes(), [{ plan: backbone, notes: new ResearchNotes() }]).text).toBe("Backbone research:\n(nothing)");
  });

  it("files a practice worker's notes under its own heading", () => {
    const [, , , practice] = splitCaps(capsFor(72), true);
    const notes = new ResearchNotes();
    notes.fetches.push({ url: "https://drills.example.com/a", ok: true, title: "Drills", finalUrl: "https://drills.example.com/a", excerpt: "d" });
    expect(mergeNotes(new ResearchNotes(), [{ plan: practice, notes }]).text).toMatch(/^Practice sources:\nRead <https:\/\/drills.example.com\/a>/);
  });

  it("measures how much of what the searches returned more than one worker saw", () => {
    const hit = (url: string) => ({ title: url, url, snippet: "", publishedDate: null });
    const a = new ResearchNotes();
    a.searches.push({ query: "x", results: [hit("https://one.example"), hit("https://two.example")] });
    const b = new ResearchNotes();
    b.searches.push({ query: "y", results: [hit("https://two.example"), hit("https://three.example")] });
    expect(duplicateShare([{ notes: a }, { notes: b }])).toBeCloseTo(1 / 3);
    expect(duplicateShare([{ notes: new ResearchNotes() }])).toBeNull();
  });
});

describe("defaultArm", () => {
  it("ships arm A, or arm W behind RESEARCH_ARM=workers, and nothing without a search key", () => {
    expect(defaultArm({ TAVILY_API_KEY: "k" })?.name).toBe("research");
    expect(defaultArm({ TAVILY_API_KEY: "k", RESEARCH_ARM: "workers" })?.name).toBe("researchWorkers");
    // A second argument carries the model the request resolved, for a user running on their own key.
    expect(defaultArm({ TAVILY_API_KEY: "k", RESEARCH_ARM: "workers" }, { model: "anthropic/claude-opus-5.5" })?.name).toBe("researchWorkers");
    expect(defaultArm({ TAVILY_API_KEY: "k", RESEARCH_ARM: " Workers " })?.name).toBe("researchWorkers");
    expect(defaultArm({ TAVILY_API_KEY: "k", RESEARCH_ARM: "agent" })?.name).toBe("research");
    expect(defaultArm({ RESEARCH_ARM: "workers" })).toBeNull();
  });
});

describe("the backbone's notes step", () => {
  it("takes the tools away on the backbone's last step and asks for the notes, and never on a two-step worker", async () => {
    const { model, calls } = directedModel(
      {
        backbone: [
          { calls: [{ tool: "webSearch", input: { query: "best llm engineering book" } }] },
          { calls: [{ tool: "fetchSource", input: { url: "https://books.example.com/core" } }] },
          { calls: [{ tool: "fetchSource", input: { url: "https://publisher.example.com/missing" } }] },
          { text: "Core Textbook by A. Author; two lists recommend it; its own page could not be read." },
        ],
        canonical: SCRIPTS.canonical,
        current: SCRIPTS.current,
      },
      [LIST],
    );
    const { fetcher } = fetcherFor();
    await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books }));
    const backbone = calls.filter((c) => directionOf(c) === "backbone");
    expect(backbone).toHaveLength(4);
    expect(backbone.slice(0, 3).map((c) => c.toolChoice?.type ?? "auto")).toEqual(["auto", "auto", "auto"]);
    expect(backbone[3].toolChoice).toEqual({ type: "none" });
    expect(userText(backbone[3])).toContain("Write your notes now");
    for (const c of calls.filter((c) => directionOf(c) !== "backbone")) expect(c.toolChoice?.type ?? "auto").not.toBe("none");
    const prompt = candidatePrompt(calls);
    const section = prompt.slice(prompt.indexOf("Backbone research:"), prompt.indexOf("Canonical materials:"));
    expect(section).toContain("Your notes while researching:\nCore Textbook by A. Author");
  });

  it("moves the notes step forward as soon as both budgets are spent", async () => {
    const extra = ["c", "d", "e", "f"].map((k) => [`https://docs.example.com/${k}`, page(`https://docs.example.com/${k}`, `Guide ${k.toUpperCase()}`)] as const);
    const { model, calls } = directedModel(
      {
        backbone: [
          { calls: ["best llm engineering book", "llm engineering syllabus", "llm engineering reading list"].map((query) => ({ tool: "webSearch" as const, input: { query } })) },
          { calls: ["https://books.example.com/core", ...extra.map(([url]) => url)].map((url) => ({ tool: "fetchSource" as const, input: { url } })) },
          { text: "Core Textbook; budget spent." },
        ],
        canonical: SCRIPTS.canonical,
        current: SCRIPTS.current,
      },
      [LIST],
    );
    const { fetcher } = fetcherFor({ ...PAGES, ...Object.fromEntries(extra) });
    const { outcome } = await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books }));
    const backbone = calls.filter((c) => directionOf(c) === "backbone");
    // Three searches and five reads are the backbone's whole share in this band: step 3 is its notes step, though its cap is four.
    expect(backbone).toHaveLength(3);
    expect(backbone[2].toolChoice).toEqual({ type: "none" });
    expect(outcome.arm?.workers?.find((w) => w.direction === "backbone")?.steps).toBe(3);
  });
});

describe("the research model's effort", () => {
  it("runs the worker steps at the loop effort and the candidate step at its own, and records each on its row", async () => {
    const { model, calls } = directedModel(SCRIPTS, [LIST]);
    const { fetcher } = fetcherFor();
    const log: ModelCall[] = [];
    await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books, log: { onCall: (c) => void log.push(c) } }));
    const steps = calls.filter((c) => c.responseFormat?.type !== "json");
    const candidates = calls.filter((c) => c.responseFormat?.type === "json");
    expect(steps.length).toBeGreaterThan(3);
    expect(candidates).toHaveLength(1);
    for (const c of steps) expect(c.providerOptions?.anthropic?.effort).toBe("high");
    expect(candidates[0].providerOptions?.anthropic?.effort).toBe("low");
    expect(log.length).toBe(calls.length);
    for (const row of log) expect(row.effort).toBe(row.label === "Research · candidates" ? "low" : "high");
  });
});

describe("an effort override on the arm", () => {
  it("runs every worker step and the candidate step at the arm's effort when one is given", async () => {
    const { model, calls } = directedModel(SCRIPTS, [LIST]);
    const { fetcher } = fetcherFor();
    const log: ModelCall[] = [];
    await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model, effort: "high" }), fetcher, books, log: { onCall: (c) => void log.push(c) } }));
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(c.providerOptions?.anthropic?.effort).toBe("high");
    for (const row of log) expect(row.effort).toBe("high");
  });
});

describe("a provider refusal on a user's key (arm W)", () => {
  const refusal = () =>
    new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });

  it("stops research instead of folding the refusal into a search outage", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw refusal();
      },
    });
    const { fetcher } = fetcherFor();
    await expect(collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books, log: { keyOwner: "user" } }))).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
  });

  it("keeps today's behaviour on the app's key: the run ends as a search outage with the learner's sources", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw refusal();
      },
    });
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books }));
    expect(outcome.notice).toBeTruthy();
  });
});

describe("who paid, on the research rows", () => {
  it("records the request's key owner on every worker step row, not only on the candidate step", async () => {
    const { model, calls } = directedModel(SCRIPTS, [LIST]);
    const { fetcher } = fetcherFor();
    const log: ModelCall[] = [];
    await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books, log: { keyOwner: "user", onCall: (c) => void log.push(c) } }));
    expect(log.length).toBe(calls.length);
    expect(log.map((r) => r.keyOwner)).toEqual(log.map(() => "user"));
  });
});

describe("the date in a worker's instructions", () => {
  const plan = { direction: "current" as const, caps: { searches: 2, fetches: 4, steps: 2, wallMs: 60_000 }, withCurrent: false };

  it("tells each worker today's date", () => {
    for (const direction of ["backbone", "canonical", "current"] as const) {
      expect(buildWorkerInstructions({ ...plan, direction }, new Date("2026-10-15T12:00:00Z"))).toContain("Today is 15 October 2026.");
    }
  });

  it("reads the clock at request time, so the date is never stale", async () => {
    const { model } = directedModel(SCRIPTS, [LIST]);
    const { fetcher } = fetcherFor();
    const log: ModelCall[] = [];
    await collect(researchMaterials({ brief, arm: createWorkersArm({ provider: fakeProvider(), model }), fetcher, books, log: { onCall: (c) => void log.push(c) } }));
    const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    const firstSteps = log.filter((c) => c.label?.endsWith("step 1"));
    expect(firstSteps.length).toBe(3);
    for (const c of firstSteps) expect(c.system).toContain(`Today is ${today}.`);
  });
});
