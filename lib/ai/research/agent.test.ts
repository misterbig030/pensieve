import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { PRACTICE_FORMATS, PRACTICE_REGISTRY } from "@/lib/practice";
import { providerError } from "../providerError";
import type { ModelCall } from "../logged";
import { bookPageFromNotes, briefLines, buildFinalPrompt, buildResearchInstructions, createAgentArm, isBookListPage, namedButNotListed, practiceLines, readButNotListed } from "./agent";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import { isThin, researchMaterials, streamWhile, verifiedReading } from "./pipeline";
import { RESEARCH_CAPS, ResearchNotes, SourceFetcher, capsFor, type PageFetcher, type ResearchCaps, type SearchProvider } from "./tools";
import { MAX_CANDIDATES, type BookLookup, type Candidate, type CandidateList } from "./verify";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

type Step = { calls: { tool: "webSearch" | "fetchSource"; input: Record<string, string> }[] } | { text: string };

let callSeq = 0;
function stepResult(step: Step): LanguageModelV4GenerateResult {
  if ("text" in step) {
    return { content: [{ type: "text", text: step.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  }
  return {
    content: step.calls.map((c) => ({ type: "tool-call" as const, toolCallId: `call-${++callSeq}`, toolName: c.tool, input: JSON.stringify(c.input) })),
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

/**
 * A mock model that plays `steps` in the tool loop and answers the structured candidate step with `final`
 * (a list, or an error / invalid JSON to exercise the retry).
 */
function scriptedModel(steps: Step[], finals: (CandidateList | string)[]) {
  const loop = [...steps];
  const answers = [...finals];
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      if (options.responseFormat?.type === "json") {
        const next = answers.length > 1 ? answers.shift()! : answers[0];
        return { content: [{ type: "text", text: typeof next === "string" ? next : JSON.stringify(next) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      }
      const step = loop.shift() ?? { text: "Done." };
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
    { url: "https://books.example.com/core", title: "Core Textbook", kind: "book", author: "A. Author", why: "The standard text", recommendedBy: ["https://lists.bookrecs.com/best", "https://blog.readinglist.org/reading"] },
    { url: "https://docs.example.com/a", title: "Guide A", kind: "docs", why: "Official docs", recommendedBy: [] },
    { url: "https://docs.example.com/b", title: "Guide B", kind: "docs", why: "More docs", recommendedBy: [] },
    { url: "https://gone.example.com/", title: "Gone", kind: "essay", why: "Dead link", recommendedBy: [] },
  ],
};

const brief = { topic: "LLM engineering", weeks: 4, sources: [{ url: "https://learner.example.com/mine", type: "link" as const }] };

async function collect(gen: AsyncGenerator<ResearchEvent, unknown>) {
  const events: ResearchEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, outcome: next.value as Awaited<ReturnType<typeof researchMaterials>> extends AsyncGenerator<unknown, infer R> ? R : never };
}

describe("streamWhile", () => {
  it("yields events as they are emitted and returns the result", async () => {
    const gen = streamWhile<number, string>(async (emit) => {
      emit(1);
      await new Promise((r) => setTimeout(r, 1));
      emit(2);
      return "done";
    });
    const seen: number[] = [];
    let n = await gen.next();
    while (!n.done) {
      seen.push(n.value);
      n = await gen.next();
    }
    expect(seen).toEqual([1, 2]);
    expect(n.value).toBe("done");
  });
});

describe("arm A through the pipeline", () => {
  it("streams search, reads, gate results and done in order", async () => {
    const { model } = scriptedModel(
      [
        { calls: [{ tool: "fetchSource", input: { url: "https://learner.example.com/mine" } }] },
        { calls: [{ tool: "webSearch", input: { query: "best llm engineering book" } }] },
        { calls: [{ tool: "fetchSource", input: { url: "https://books.example.com/core" } }] },
        { text: "Core Textbook is recommended by two lists." },
      ],
      [LIST],
    );
    const { fetcher, fetchPage } = fetcherFor();
    const calls: ModelCall[] = [];
    const arm = createAgentArm({ provider: fakeProvider(), model });
    const { events, outcome } = await collect(
      researchMaterials({ brief, arm, fetcher, books, log: { onCall: (c) => void calls.push(c) } }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "research.start",
      "research.reading",
      "research.fetch",
      "research.search",
      "research.reading",
      "research.fetch",
      // the gate reads what the arm did not
      "research.reading",
      "research.reading",
      "research.reading",
      "research.fetch",
      "research.fetch",
      "research.fetch",
      "research.dropped",
      "research.verified",
      "research.verified",
      "research.verified",
      "research.done",
    ]);
    expect(fetchPage).toHaveBeenCalledTimes(5);
    // Research chooses no backbone (the allocation does): the learner's source first, then the arm's order.
    expect(outcome.materials.map((m) => [m.id, m.title, m.origin, m.backbone])).toEqual([
      ["M1", "My notes page", "learner", false],
      ["M2", "Core Textbook", "research", false],
      ["M3", "Guide A", "research", false],
      ["M4", "Guide B", "research", false],
    ]);
    // Three verified materials and no named gaps: a short list, not a thin one.
    expect(outcome.notice).toBeUndefined();
    expect(outcome.coverage).toBeNull();
    expect(outcome.arm?.stoppedBy).toBe("model");
    // Each loop step and the structured step reach the admin panel.
    expect(calls.map((c) => c.label)).toEqual([
      "Research · step 1",
      "Research · step 2",
      "Research · step 3",
      "Research · step 4",
      "Research · candidates",
    ]);
    expect(calls.every((c) => c.caller === "research")).toBe(true);
  });

  it("runs the loop at the loop effort and the candidate step at its own, and records each on its row", async () => {
    const { model, calls } = scriptedModel(
      [{ calls: [{ tool: "webSearch", input: { query: "best llm engineering book" } }] }, { text: "Core Textbook is recommended by two lists." }],
      [LIST],
    );
    const { fetcher } = fetcherFor();
    const rows: ModelCall[] = [];
    await collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books, log: { onCall: (c) => void rows.push(c) } }));
    const steps = calls.filter((c) => c.responseFormat?.type !== "json");
    const candidates = calls.filter((c) => c.responseFormat?.type === "json");
    expect(steps).toHaveLength(2);
    expect(candidates).toHaveLength(1);
    for (const c of steps) expect(c.providerOptions?.anthropic?.effort).toBe("high");
    expect(candidates[0].providerOptions?.anthropic?.effort).toBe("low");
    expect(rows.length).toBe(calls.length);
    for (const r of rows) expect(r.effort).toBe(r.label === "Research · candidates" ? "low" : "high");
  });

  it("enforces the caps in code whatever the model requests", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ tool: "webSearch" as const, input: { query: `q${i}` } }));
    const reads = Array.from({ length: 5 }, (_, i) => ({ tool: "fetchSource" as const, input: { url: `https://docs.example.com/${i}` } }));
    const { model, calls } = scriptedModel([{ calls: many }, { calls: reads }, { calls: many }, { calls: reads }], [{ learner: [], candidates: [] }]);
    const provider = fakeProvider();
    const { fetcher, fetchPage } = fetcherFor();
    const caps: ResearchCaps = { steps: 3, searches: 4, fetches: 3, wallMs: 60_000 };
    const { outcome } = await collect(researchMaterials({ brief: { ...brief, sources: [] }, arm: createAgentArm({ provider, model, caps }), fetcher, books, caps }));
    expect(provider.search).toHaveBeenCalledTimes(4);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(outcome.arm?.counts).toEqual({ steps: 3, searches: 4, fetches: 3 });
    expect(outcome.arm?.stoppedBy).toBe("steps");
    // The structured step still ran after the step cap.
    expect(calls.filter((c) => c.responseFormat?.type === "json")).toHaveLength(1);
  });

  it("ends research early when the search API fails, and says research was unavailable", async () => {
    const { model } = scriptedModel([{ calls: [{ tool: "webSearch", input: { query: "x" } }] }, { calls: [{ tool: "webSearch", input: { query: "y" } }] }], [{ learner: [], candidates: [] }]);
    const provider = fakeProvider();
    provider.search.mockRejectedValue(new Error("503"));
    const { fetcher } = fetcherFor();
    const { events, outcome } = await collect(researchMaterials({ brief, arm: createAgentArm({ provider, model }), fetcher, books }));
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(outcome.arm?.stoppedBy).toBe("search-error");
    expect(outcome.notice).toBe("unavailable");
    // The learner's source is still kept.
    expect(outcome.materials.map((m) => m.origin)).toEqual(["learner"]);
    expect(events.at(-1)).toMatchObject({ type: "research.done", notice: "unavailable" });
  });

  it("stops the loop on the wall clock and still runs the structured step", async () => {
    const hang = new MockLanguageModelV4({
      doGenerate: async (options) => {
        if (options.responseFormat?.type === "json") {
          return { content: [{ type: "text", text: JSON.stringify(LIST) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        }
        await new Promise((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason)));
        throw new Error("unreachable");
      },
    });
    const { fetcher } = fetcherFor();
    const caps: ResearchCaps = { steps: 12, searches: 6, fetches: 12, wallMs: 30 };
    const { outcome } = await collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model: hang, caps }), fetcher, books, caps }));
    expect(outcome.arm?.stoppedBy).toBe("clock");
    expect(outcome.materials.length).toBeGreaterThan(1);
  });

  it("retries a structured step that fails its schema once, then continues with the learner's sources only", async () => {
    const { model, calls } = scriptedModel([{ text: "Nothing to add." }], ["not json", "{\"still\": \"wrong\"}"]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books }));
    errors.mockRestore();
    expect(calls.filter((c) => c.responseFormat?.type === "json")).toHaveLength(2);
    expect(outcome.materials.map((m) => m.origin)).toEqual(["learner"]);
    expect(outcome.notice).toBe("thin");
  });

  it("recovers after a retry", async () => {
    const { model } = scriptedModel([{ text: "ok" }], ["not json", LIST]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books }));
    errors.mockRestore();
    expect(outcome.materials).toHaveLength(4);
  });

  it("passes a client disconnect through to search and fetch", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const provider: SearchProvider = {
      name: "slow",
      search: (_q, { signal }) =>
        new Promise((_, reject) => {
          seen.push(signal);
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => controller.abort(), 5);
        }),
    };
    const { model } = scriptedModel([{ calls: [{ tool: "webSearch", input: { query: "x" } }] }], [LIST]);
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief, arm: createAgentArm({ provider, model }), fetcher, books, signal: controller.signal }));
    expect(seen[0]?.aborted).toBe(true);
    expect(outcome.notice).toBe("unavailable");
  });

  it("reports research unavailable when no search provider is configured", async () => {
    const { fetcher } = fetcherFor();
    const { events, outcome } = await collect(researchMaterials({ brief, arm: null, fetcher, books }));
    expect(events.map((e) => e.type)).toEqual(["research.start", "research.reading", "research.fetch", "research.done"]);
    expect(outcome.notice).toBe("unavailable");
    expect(outcome.materials).toHaveLength(1);
  });
});

describe("thin research", () => {
  it("is thin with almost nothing verified, or with as much of the topic open as covered", () => {
    expect(isThin(2, null)).toBe(true);
    expect(isThin(3, null)).toBe(false);
    expect(isThin(8, { covered: ["History", "Basic stitches"], open: ["Advanced stitches", "Finishing"] })).toBe(true);
    expect(isThin(8, { covered: ["Foundations", "Agents", "Evals"], open: ["Retrieval"] })).toBe(false);
    expect(isThin(8, { covered: ["Foundations"], open: [] })).toBe(false);
    // Open practice picks are not topic areas.
    expect(isThin(8, { covered: ["Foundations", "Agents", "Evals"], open: ["practice: Problems", "practice: Mock", "practice: Design"] })).toBe(false);
    expect(isThin(8, { covered: ["Foundations"], open: ["Evals", "practice: Problems"] })).toBe(true);
    // The prefix matches in any case.
    expect(isThin(8, { covered: ["Foundations"], open: ["Practice: Problems"] })).toBe(false);
  });

  it("counts only the researched materials there is something to read in", () => {
    const problems = { format: "problem-set" as const, items: 150, perItemMinutes: 10, minutes: 1500, answers: true };
    const list = [
      { origin: "research" as const, minutes: 600 },
      { origin: "research" as const, minutes: 300, practice: problems },
      { origin: "research" as const, minutes: null, practice: problems },
      { origin: "research" as const, minutes: null, practice: { ...problems, format: "lab" as const } },
      { origin: "learner" as const, minutes: 120 },
    ];
    // Two readings and two practice-only lists is two verified to read: thin.
    expect(verifiedReading(list)).toBe(2);
    expect(isThin(verifiedReading(list), null)).toBe(true);
  });

  it("carries the arm's coverage and the list's size to the done event", async () => {
    const withCoverage: CandidateList = {
      ...LIST,
      candidates: LIST.candidates.map((c) => ({ ...c, minutes: 120 })),
      coverage: { covered: ["Foundations"], open: ["Evals", "Agents"] },
    };
    const { model } = scriptedModel([{ text: "Done." }], [withCoverage]);
    const { fetcher } = fetcherFor();
    const { events, outcome } = await collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books }));
    expect(outcome.notice).toBe("thin");
    expect(outcome.coverage).toEqual({ covered: ["Foundations"], open: ["Evals", "Agents"] });
    expect(outcome.sizedMinutes).toBe(360);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "research.done", notice: "thin", coverage: { covered: ["Foundations"], open: ["Evals", "Agents"] }, sizedMinutes: 360 });
  });
});

describe("research prompts", () => {
  it("states the learner's total hours and asks for sizes and coverage, not a count", () => {
    expect(briefLines({ topic: "T", weeks: 12, hoursPerWeek: 6, sources: [] })[1]).toBe("Plan length: 12 weeks at about 6 hours a week: 72 hours of study in all");
    expect(briefLines({ topic: "T", weeks: 1, sources: [] })[1]).toContain("6 hours of study in all");
    const prompt = buildFinalPrompt({ topic: "T", weeks: 12, hoursPerWeek: 30, sources: [] }, "notes");
    expect(prompt).not.toMatch(/12 to 25/);
    expect(prompt).not.toMatch(/must not exceed \d+ hours/);
    expect(prompt).toContain('"coverage"');
    expect(prompt).toContain("- minutes:");
  });

  it("scales the caps to the plan's hours unless the arm was given its own", async () => {
    const { model } = scriptedModel([{ text: "Done." }], [LIST]);
    const { fetcher } = fetcherFor();
    const { events } = await collect(researchMaterials({ brief: { ...brief, weeks: 1, hoursPerWeek: 3 }, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books }));
    expect(events[0]).toEqual({ type: "research.start", caps: { searches: 3, fetches: 6, steps: 8 } });
    expect(capsFor(72)).toEqual(RESEARCH_CAPS);
    expect(capsFor(360).fetches).toBe(16);
  });

  it("says when the notes are grouped by direction, and only then", () => {
    const plain = buildFinalPrompt({ topic: "T", weeks: 1, sources: [] }, "notes");
    const grouped = buildFinalPrompt({ topic: "T", weeks: 1, sources: [] }, "notes", { grouped: true });
    expect(plain).not.toContain("grouped by the research direction");
    expect(grouped).toContain("Notes are grouped by the research direction that found them; a material found by more than one appears once in your list.");
    expect(grouped.indexOf("Research notes")).toBeLessThan(grouped.indexOf("grouped by the research direction"));
  });
});

describe("practice in the research prompts", () => {
  const caps: ResearchCaps = { steps: 8, searches: 3, fetches: 6, wallMs: 60_000 };

  it("lists one line per registry format, with its label, format id and research line", () => {
    const lines = practiceLines();
    expect(lines).toHaveLength(PRACTICE_FORMATS.length);
    for (const f of PRACTICE_FORMATS) expect(lines).toContain(`- ${PRACTICE_REGISTRY[f].label} (${f}): ${PRACTICE_REGISTRY[f].research}`);
  });

  it("always asks arm A for practice, of the kinds the topic calls for", () => {
    const text = buildResearchInstructions(caps);
    expect(text).toContain("\n6. Practice");
    expect(text.indexOf("5. Size")).toBeLessThan(text.indexOf("6. Practice"));
    expect(text).toContain("the kinds of practice this topic calls for");
    expect(text).toContain("skipping kinds it doesn't need");
    for (const line of practiceLines()) expect(text).toContain(line);
    expect(text).toContain("How the learner's time divides between reading and practice is decided after research, from what you find; you also look for the practice sources.");
    expect(text).not.toContain("already decided");
    expect(text).not.toContain("not by you");
    expect(text).toContain("The learner's total study time is in the brief; a list that takes longer than that to get through is too long.");
    expect(text).not.toContain("only the reading part of the study time");
  });

  it("asks for a practice draft on candidates and the learner's sources, naming every registry format", () => {
    const prompt = buildFinalPrompt({ topic: "T", weeks: 4, sources: [] }, "notes");
    expect(prompt).toContain("- practice:");
    for (const f of PRACTICE_FORMATS) expect(prompt).toContain(`${f} (${PRACTICE_REGISTRY[f].label})`);
    expect(prompt).toContain("items: the problems, questions, labs or steps");
    expect(prompt).toContain("perItemMinutes: only when the page states a time per item");
    expect(prompt).toContain("answers: true only when the source gives solutions, an answer key, worked solutions or a rubric");
    expect(prompt).toContain("minutes are null unless the plan would also read it");
    expect(prompt).toContain("A wrong answers: false removes the tag");
    expect(prompt).toContain('a kind of practice the topic needs that nothing serves goes in "open" as "practice: <label>"');
  });

  it("lists materials whole and states the learner's hours without capping the list by them", () => {
    const prompt = buildFinalPrompt({ topic: "T", weeks: 8, hoursPerWeek: 6, sources: [] }, "notes");
    expect(prompt).toContain("48 hours of study in all");
    expect(prompt).not.toMatch(/must not exceed \d+ hours/);
    expect(prompt).not.toContain("the plan's reading time");
    expect(prompt).toContain("list each material at its whole size");
    expect(prompt).toContain("which part the plan uses is decided after research");
    expect(prompt).toContain("List every book the notes recommend, under its title as published and its author");
    expect(prompt).not.toContain("the part this plan would use takes");
  });

  it("gives arm A the practice step whatever the brief", async () => {
    const { model, calls } = scriptedModel([{ text: "Done." }], [LIST]);
    const { fetcher } = fetcherFor();
    await collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books }));
    const system = calls.map((c) => c.prompt.find((m) => m.role === "system")?.content).find((c) => typeof c === "string" && c.includes("You gather"));
    expect(system).toContain("6. Practice");
  });
});

describe("pages that recommend books", () => {
  it("tells the candidates step a page that only recommends books goes in the books' recommendedBy, not the list", () => {
    const prompt = buildFinalPrompt({ topic: "T", weeks: 8, hoursPerWeek: 6, sources: [] }, "notes");
    expect(prompt).toContain(`A page that only recommends books (a "best books" list or a reading list) is not a material: put it in those books' recommendedBy and leave it out of the list.`);
  });

  it("calls a non-book found by the book researcher alone a page of recommendations", () => {
    expect(isBookListPage({ kind: "essay", foundBy: ["backbone"] })).toBe(true);
    expect(isBookListPage({ kind: "docs", foundBy: ["backbone"] })).toBe(true);
    // The book itself, a page another direction found too, and a list with no directions are materials.
    expect(isBookListPage({ kind: "book", foundBy: ["backbone"] })).toBe(false);
    expect(isBookListPage({ kind: "essay", foundBy: ["backbone", "canonical"] })).toBe(false);
    expect(isBookListPage({ kind: "essay", foundBy: ["canonical"] })).toBe(false);
    expect(isBookListPage({ kind: "essay" })).toBe(false);
  });
});

describe("extraction: every credible source, no choosing", () => {
  const cand = (url: string, extra: Partial<Candidate> = {}): Candidate => ({ url, title: "T", kind: "docs", why: "w", recommendedBy: [], ...extra });

  it("asks the candidates step to record every credible source, with no hour cap", () => {
    const prompt = buildFinalPrompt({ topic: "T", weeks: 8, hoursPerWeek: 6, sources: [] }, "notes");
    expect(prompt).not.toMatch(/must not exceed \d+ hours/);
    expect(prompt).toContain("every credible source the notes found");
    expect(prompt).toContain("a search result seen only as a snippet only when the notes recommend it");
    expect(prompt).toContain(`at most ${MAX_CANDIDATES}, keeping the best-evidenced if there are more`);
    expect(prompt).toContain("Choosing what the plan uses happens later, with sizes in hand, so a source left out here is lost.");
    expect(prompt).toContain("title as published");
    expect(prompt).toContain("pageTitle");
    expect(prompt).not.toMatch(/backbone: true/);
    expect(prompt).not.toContain("backbone textbook first");
    expect(prompt).not.toContain("- backbone:");
  });

  it("records pages a researcher read that the list leaves out", () => {
    const reads = [
      { url: "https://github.com/mdmzfzl/NeetCode-Solutions", finalUrl: null, direction: "practice" },
      { url: "https://a.example/x", finalUrl: null, direction: "canonical" },
      { url: "https://b.example/old", finalUrl: "https://b.example/new/", direction: "current" },
      { url: "https://learner.example.com/mine", finalUrl: null, direction: "learner" },
    ];
    const listed = [cand("https://a.example/x"), cand("https://b.example/new")];
    expect(readButNotListed(reads, listed, [])).toEqual(["read but not listed: https://github.com/mdmzfzl/NeetCode-Solutions (practice)"]);
    // A learner source is always kept, so a page read for it is not "left out".
    expect(readButNotListed([{ url: "https://c.example/mine", finalUrl: null, direction: "research" }], [], [{ url: "https://c.example/mine" }])).toEqual([]);
    // A page a candidate lists as a recommender was read for its recommendations, not missed as a source.
    const guide = { url: "https://blog.example/best-books", finalUrl: "https://blog.example/best-books/", direction: "canonical" };
    const recommending = { ...cand("https://books.example/b"), recommendedBy: ["https://blog.example/best-books"] };
    expect(readButNotListed([guide], [recommending], [])).toEqual([]);
    expect(readButNotListed([{ ...guide, url: "https://blog.example/best-books/", finalUrl: null }], [recommending], [])).toEqual([]);
    expect(readButNotListed([guide], [cand("https://books.example/b")], [])).toEqual(["read but not listed: https://blog.example/best-books (canonical)"]);
    // One page read by two directions is one fact.
    const twice = [
      { url: "https://d.example/p", finalUrl: null, direction: "canonical" },
      { url: "https://d.example/p", finalUrl: null, direction: "practice" },
    ];
    expect(readButNotListed(twice, [], [])).toEqual(["read but not listed: https://d.example/p (canonical, practice)"]);
  });

  it("tags arm A's candidates 'research' and returns every page read, and logs what the list left out", async () => {
    const list: CandidateList = { learner: [], candidates: [{ url: "https://docs.example.com/a", title: "Guide A", kind: "docs", why: "Official docs", recommendedBy: [] }] };
    const { model } = scriptedModel(
      [
        { calls: [{ tool: "fetchSource", input: { url: "https://docs.example.com/a" } }, { tool: "fetchSource", input: { url: "https://docs.example.com/b" } }] },
        { text: "Done." },
      ],
      [list],
    );
    const { fetcher } = fetcherFor();
    const rows: ModelCall[] = [];
    const result = await createAgentArm({ provider: fakeProvider(), model })({ brief: { topic: "T", weeks: 4, sources: [] }, fetcher, emit: () => {}, log: { onCall: (c) => void rows.push(c) } });
    expect(result.candidates[0].foundBy).toEqual(["research"]);
    expect(result.reads).toEqual([
      { url: "https://docs.example.com/a", finalUrl: "https://docs.example.com/a", direction: "research" },
      { url: "https://docs.example.com/b", finalUrl: "https://docs.example.com/b", direction: "research" },
    ]);
    const candidates = rows.find((r) => r.label === "Research · candidates");
    expect(candidates?.facts).toContain("read but not listed: https://docs.example.com/b (research)");
    expect(candidates?.facts).not.toContain("read but not listed: https://docs.example.com/a (research)");
  });

  it("fills a book listed without an address from a page the notes tried, and says so", async () => {
    const page = "https://publisher.example.com/books/designing-data-intensive-applications/";
    const list: CandidateList = { learner: [], candidates: [{ url: "", title: "Designing Data-Intensive Applications", kind: "book", author: "Martin Kleppmann", why: "Depth", recommendedBy: [] }] };
    const { model } = scriptedModel([{ calls: [{ tool: "fetchSource", input: { url: page } }] }, { text: "Done." }], [list]);
    const { fetcher } = fetcherFor();
    const rows: ModelCall[] = [];
    const result = await createAgentArm({ provider: fakeProvider(), model })({ brief: { topic: "T", weeks: 4, sources: [] }, fetcher, emit: () => {}, log: { onCall: (c) => void rows.push(c) } });
    expect(result.candidates[0].url).toBe(page);
    expect(rows.find((r) => r.label === "Research · candidates")?.facts).toContain(`book page from the notes: Designing Data-Intensive Applications → ${page}`);
  });

  it("cuts a longer list to the first 25 and says so", async () => {
    const many: CandidateList = {
      learner: [],
      candidates: Array.from({ length: 30 }, (_, i) => ({ url: `https://docs.example.com/p${i}`, title: `P${i}`, kind: "docs" as const, why: "w", recommendedBy: [] })),
    };
    const { model } = scriptedModel([{ text: "Done." }], [many]);
    const { fetcher } = fetcherFor();
    const rows: ModelCall[] = [];
    const result = await createAgentArm({ provider: fakeProvider(), model })({ brief: { topic: "T", weeks: 4, sources: [] }, fetcher, emit: () => {}, log: { onCall: (c) => void rows.push(c) } });
    expect(result.candidates).toHaveLength(MAX_CANDIDATES);
    expect(result.candidates.map((c) => c.title).slice(0, 2)).toEqual(["P0", "P1"]);
    expect(result.candidates.at(-1)?.title).toBe("P24");
    expect(rows.find((r) => r.label === "Research · candidates")?.facts).toContain("list cut to 25 of 30");
  });
});

describe("books the notes name", () => {
  // The book researcher's notes from a live draft: a leading book and four rivals, none of them with a page of its own.
  const NOTES = [
    "**Leading book (backbone):** *Cracking the Coding Interview: 189 Programming Questions and Solutions*, 6th edition, by Gayle Laakmann McDowell.",
    "**Rivals and companions for the senior-level gap:**",
    "- *System Design Interview, Volume 1* (and Volume 2, with Sahn Lam) by Alex Xu. Rockstard says senior candidates *cannot* skip it.",
    "- *Designing Data-Intensive Applications* by Martin Kleppmann (2nd edition exists).",
    "- *Elements of Programming Interviews* by Aziz, Lee and Prakash.",
    "- *Coding Interview Patterns* by Alex Xu and Shaun Gunawardane.",
  ].join("\n");
  const found = (direction: "backbone" | "canonical", remarks: string) => {
    const notes = new ResearchNotes();
    notes.remarks.push(remarks);
    return { direction, notes };
  };
  const book = (title: string, pageTitle: string | null = null): Candidate => ({ url: "", title, pageTitle, kind: "book", why: "w", recommendedBy: [] });

  it("names each book the book notes set in italics that the list leaves out", () => {
    const listed = [book("CRACKING the CODING INTERVIEW"), book("Designing Data-Intensive Applications, 2nd Edition")];
    expect(namedButNotListed([found("backbone", NOTES)], listed)).toEqual([
      "named in the book notes but not listed: System Design Interview, Volume 1",
      "named in the book notes but not listed: Elements of Programming Interviews",
      "named in the book notes but not listed: Coding Interview Patterns",
    ]);
  });

  it("counts a book listed under a longer title, its page's title, or a shorter main title", () => {
    const listed = [book("Cracking the Coding Interview"), book("System Design Interview – An Insider's Guide"), book("DDIA", "Designing Data-Intensive Applications"), book("Elements of Programming Interviews in Python"), book("Coding Interview Patterns: Nail Your Next Coding Interview")];
    expect(namedButNotListed([found("backbone", NOTES)], listed)).toEqual([]);
  });

  it("reads only the book notes, and not a non-book of the same name", () => {
    expect(namedButNotListed([found("canonical", "*The Missing Semester* is a course.")], [])).toEqual([]);
    expect(namedButNotListed([found("backbone", "*Coding Interview Patterns* by Alex Xu.")], [{ ...book("Coding Interview Patterns"), kind: "course" }])).toEqual([
      "named in the book notes but not listed: Coding Interview Patterns",
    ]);
  });

  it("lets a book the notes give no page for be listed with an empty url, and keeps one they give", () => {
    const prompt = buildFinalPrompt({ topic: "T", weeks: 8, hoursPerWeek: 6, sources: [] }, "notes");
    expect(prompt).toContain("never a shop listing (Amazon or another retailer), even when that page could not be read.");
    expect(prompt).toContain("A book the notes name without such a page is still listed, with url empty: the catalogue vouches for it.");
  });

  it("gives a book listed without an address the page the notes carry for it: one tried first, then a result, then the notes", () => {
    const oreilly2 = "https://www.oreilly.com/library/view/designing-data-intensive-applications/9781098119058/";
    const oreilly1 = "https://www.oreilly.com/library/view/designing-data-intensive-applications/9781491903063/";
    const backbone = new ResearchNotes();
    backbone.searches.push({ query: "q", results: [
      { title: "r/x", url: "https://www.reddit.com/r/x/comments/1/designing_data_intensive_applications/", snippet: "", publishedDate: null },
      { title: "Shop", url: "https://www.amazon.com/designing-data-intensive-applications/dp/1449373321", snippet: "", publishedDate: null },
      { title: "Review", url: "https://blog.example.com/designing-data-intensive-applications-review", snippet: "", publishedDate: null },
    ] });
    backbone.fetches.push({ url: oreilly2, ok: false, title: null, finalUrl: null, reason: "returned 403", excerpt: "" });
    backbone.remarks.push(`The 1st-edition page: ${oreilly1}.`);
    const ddia = book("Designing Data-Intensive Applications");
    expect(bookPageFromNotes(ddia, [{ direction: "backbone", notes: backbone }]).url).toBe(oreilly2);
    // Without the read, the address in the notes; without either, nothing a shop, a review or a forum offers.
    const noted = new ResearchNotes();
    noted.searches.push(...backbone.searches);
    noted.remarks.push(...backbone.remarks);
    expect(bookPageFromNotes(ddia, [{ direction: "backbone", notes: noted }]).url).toBe(oreilly1);
    const bare = new ResearchNotes();
    bare.searches.push(...backbone.searches);
    expect(bookPageFromNotes(ddia, [{ direction: "backbone", notes: bare }])).toBe(ddia);
    // A listed address, and anything but a book, stay as they are.
    const listed = { ...ddia, url: "https://dataintensive.net/" };
    expect(bookPageFromNotes(listed, [{ direction: "backbone", notes: backbone }])).toBe(listed);
    const essay = { ...ddia, kind: "essay" as const };
    expect(bookPageFromNotes(essay, [{ direction: "backbone", notes: backbone }])).toBe(essay);
  });
});

describe("a provider refusal on a user's key", () => {
  const refusal = () =>
    new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });

  it("stops research instead of drafting on without it", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw refusal();
      },
    });
    const { fetcher } = fetcherFor();
    await expect(collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books, log: { keyOwner: "user" } }))).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
  });

  it("keeps today's behaviour on the app's key: research is reported unavailable and the draft goes on", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw refusal();
      },
    });
    const { fetcher } = fetcherFor();
    const { outcome } = await collect(researchMaterials({ brief, arm: createAgentArm({ provider: fakeProvider(), model }), fetcher, books }));
    expect(outcome.notice).toBeTruthy();
  });
});

describe("the date in the research instructions", () => {
  it("tells the model today's date, so 'recent' counts from now and not from its training data", () => {
    const caps: ResearchCaps = { steps: 3, searches: 4, fetches: 3, wallMs: 60_000 };
    const text = buildResearchInstructions(caps, undefined, undefined, new Date("2026-10-15T12:00:00Z"));
    expect(text).toContain("Today is 15 October 2026.");
    expect(text.indexOf("Today is")).toBeLessThan(text.indexOf("You have two tools"));
  });
});
