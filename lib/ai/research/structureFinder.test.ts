import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MAX_CHAPTERS, type Material } from "@/lib/schemas/material";
import type { ModelCall } from "../logged";
import { OUTLINE_RESERVE_MS } from "../planDraft";
import { providerError } from "../providerError";
import type { ResearchEvent } from "./events";
import { extractHtml, type PageInfo } from "./extract";
import type { FullReader } from "./itemFinder";
import {
  ANSWER_NOW,
  MEASURE_BATCH,
  PausableClock,
  STRUCTURE_ALLOCATE_MIN_MS,
  STRUCTURE_RESERVE_MS,
  STRUCTURE_SEARCHES,
  STRUCTURE_STEPS,
  STRUCTURE_WALL_MS,
  buildStructurePrompt,
  createStructureFinder,
} from "./structureFinder";
import { SourceFetcher, type PageFetcher, type SearchProvider } from "./tools";
import type { StructureAnswer } from "./units";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function fixture(name: string): string {
  return gunzipSync(readFileSync(join(__dirname, "__fixtures__", "pages", `${name}.html.gz`))).toString("utf8");
}

const PRIMER = "https://github.com/donnemartin/system-design-primer";
const primerInfo = extractHtml(fixture("github-readme"), PRIMER);
const headings = primerInfo.outline!.headings;
/**
 * Thirty sections of the primer: its h2 sections, with "Availability vs consistency" taken as its two h3 sections
 * (the fixture has 29 h2 sections).
 */
const split = headings.findIndex((h) => h.anchor === "availability-vs-consistency");
const splitEnd = headings.findIndex((h, i) => i > split && h.level <= 2);
const THIRTY = headings.filter((h, i) => (h.level === 2 && i !== split) || (h.level === 3 && i > split && i < splitEnd));

type Call = { tool: string; input: unknown };
type Step = Call[] | { text: string };

let callSeq = 0;
function stepResult(step: Step): LanguageModelV4GenerateResult {
  if (!Array.isArray(step)) return { content: [{ type: "text", text: step.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  return {
    content: step.map((c) => ({ type: "tool-call" as const, toolCallId: `call-${++callSeq}`, toolName: c.tool, input: JSON.stringify(c.input) })),
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

/** A model that plays `steps` in the tool loop (repeating the last), and answers structured calls with `objects` in turn. */
function scripted(steps: Step[], objects: unknown[] = []) {
  const loop = [...steps];
  const answers = [...objects];
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      if (options.responseFormat?.type === "json") {
        return { content: [{ type: "text", text: JSON.stringify(answers.shift() ?? {}) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      }
      calls.push(options);
      return stepResult(loop.length > 1 ? loop.shift()! : loop[0]);
    },
  });
  return { model, calls };
}

const toolNames = (options: LanguageModelV4CallOptions) => (options.tools ?? []).map((t) => t.name).sort();

function fetcherFor(pages: Record<string, PageInfo>) {
  const fetchPage = vi.fn<PageFetcher>(async (url) => {
    const p = pages[url];
    if (!p) throw new Error(`404 ${url}`);
    return p;
  });
  return { fetcher: new SourceFetcher(fetchPage), fetchPage };
}

function material(over: Partial<Material> = {}): Material {
  return {
    id: "M2",
    origin: "research",
    type: "link",
    kind: "repo",
    url: PRIMER,
    title: "system-design-primer",
    author: null,
    year: null,
    why: "The standard free guide to system design interviews",
    backbone: false,
    verifiedAt: "2026-10-27T00:00:00.000Z",
    fetchedTitle: null,
    recommendedBy: [],
    sig: null,
    minutes: 50,
    minutesBasis: "measured",
    pageMinutes: 50,
    ...over,
  };
}

const provider = () => ({
  name: "fake",
  search: vi.fn<SearchProvider["search"]>(async (query) => [{ title: `Result for ${query}`, url: "https://example.com/r", snippet: "a result", publishedDate: null }]),
});

function context(pages: Record<string, PageInfo> = { [PRIMER]: primerInfo }, log: { keyOwner?: "user" | "app" } = {}) {
  const { fetcher, fetchPage } = fetcherFor(pages);
  const events: ResearchEvent[] = [];
  const calls: ModelCall[] = [];
  return { fetchPage, events, calls, ctx: { fetcher, emit: (e: ResearchEvent) => void events.push(e), log: { ...log, onCall: (c: ModelCall) => void calls.push(c) } } };
}

const answerOf = (over: Partial<StructureAnswer>): StructureAnswer => ({ note: "", whole: false, units: [], listUrl: null, ...over });

describe("the structure finder", () => {
  it("outlines the primer and keeps the thirty sections it answers with", async () => {
    const units = THIRTY.map((h) => ({ title: h.title, at: `${PRIMER}#${h.anchor}`, kind: "read" as const, group: null, minutes: null }));
    const note = "One long README: building blocks, then worked interview questions; best as a reference for design rounds.";
    const { model, calls } = scripted([[{ tool: "outline", input: { url: PRIMER } }], [{ tool: "answer", input: answerOf({ note, units }) }]]);
    const { ctx, calls: logged, fetchPage } = context();
    const result = await createStructureFinder({ provider: null, model }).find(material(), "read", ctx);

    expect(THIRTY).toHaveLength(30);
    expect(result.refused).toBeNull();
    expect(result.toc!.chapters).toHaveLength(30);
    expect(result.units).toBe(30);
    expect(result.note).toBe(note);
    expect(result.basis).toBe("measured");
    expect(result.counts).toEqual({ searches: 0, fetches: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(logged.map((c) => c.label)).toEqual(["Research · structure · system-design-primer · step 1", "Research · structure · system-design-primer · step 2"]);
    expect(logged.every((c) => c.caller === "research")).toBe(true);
    expect(logged[0].facts).toContain(`outline ${PRIMER}`);
    expect(logged[1].facts).toContain("answer");
    expect(logged[1].facts).toContain("units kept: 30");
  });

  it("returns the verdict of nothing when the model never answers, and logs the forced last step it ignored", async () => {
    // Outlines the same page on every step, and writes text on the step forced to answer.
    const calls: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        calls.push(options);
        return stepResult(options.toolChoice?.type === "tool" ? { text: "The primer is one long README." } : [{ tool: "outline", input: { url: PRIMER } }]);
      },
    });
    const rows: unknown[] = [];
    const { ctx, calls: logged, fetchPage } = context();
    const result = await createStructureFinder({ provider: null, model }).find(material(), "read", { ...ctx, log: { ...ctx.log, onLog: (r) => void rows.push(r) } });

    expect(calls).toHaveLength(STRUCTURE_STEPS);
    expect(calls.at(-1)!.toolChoice).toEqual({ type: "tool", toolName: "answer" });
    for (const c of calls.slice(0, -1)) expect(c.toolChoice).not.toEqual({ type: "tool", toolName: "answer" });
    // The instruction to answer is in the last step's prompt, not only in its tool choice.
    expect(JSON.stringify(calls.at(-1)!.prompt)).toContain(ANSWER_NOW.slice(0, 40));
    for (const c of calls.slice(0, -1)) expect(JSON.stringify(c.prompt)).not.toContain(ANSWER_NOW.slice(0, 40));
    expect(result).toMatchObject({ toc: null, minutes: null, basis: null, list: null, refused: null, note: null, units: 0, facts: ["no answer"] });
    // Five outlines of one page are one read.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.counts.fetches).toBe(1);
    // Every paid step is logged and costed, the ignored forced step too.
    expect(rows).toHaveLength(STRUCTURE_STEPS);
    expect(logged).toHaveLength(STRUCTURE_STEPS);
    expect(logged.at(-1)!.label).toBe(`Research · structure · system-design-primer · step ${STRUCTURE_STEPS}`);
    expect(logged.at(-1)!.response).toContain("The primer is one long README.");
    expect(logged.at(-1)!.facts).toEqual(["forced answer ignored", "no answer"]);
  });

  it("ends with nothing, without throwing, when the outer signal aborts mid-loop", async () => {
    const outer = new AbortController();
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        if (++n === 1) return stepResult([{ tool: "outline", input: { url: PRIMER } }]);
        outer.abort();
        await new Promise((_, reject) => {
          if (options.abortSignal?.aborted) reject(options.abortSignal.reason);
          options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason));
        });
        throw new Error("unreachable");
      },
    });
    const errors = vi.spyOn(console, "error");
    const { ctx, calls: logged } = context();
    const result = await createStructureFinder({ provider: null, model }).find(material(), "read", { ...ctx, signal: outer.signal });
    expect(result).toMatchObject({ toc: null, list: null, refused: null, units: 0, facts: ["no answer"] });
    expect(logged).toHaveLength(1);
    expect(logged[0].facts).toEqual([`outline ${PRIMER}`, "no answer"]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("offers search only with a provider, and items only to a role with practice", async () => {
    const tools = async (provider: SearchProvider | null, role: "read" | "practice" | "both", over: Partial<Material> = {}) => {
      const { model, calls } = scripted([[{ tool: "answer", input: answerOf({ whole: true }) }]]);
      await createStructureFinder({ provider, model }).find(material(over), role, context().ctx);
      return toolNames(calls[0]);
    };
    const practice = { format: "problem-set" as const, items: 30, perItemMinutes: 20, minutes: 600, answers: true };
    expect(await tools(null, "practice", { practice })).toEqual(["answer", "items", "measure", "outline"]);
    expect(await tools(provider(), "read")).toEqual(["answer", "measure", "outline"]);
    expect(await tools(provider(), "practice", { practice })).toEqual(["answer", "items", "measure", "outline", "search"]);
    expect(await tools(provider(), "both", { practice })).toEqual(["answer", "items", "measure", "outline", "search"]);
    // A practice source whose list is already found has nothing to search for.
    const list = { items: [1, 2, 3].map((n) => ({ title: `P${n}`, number: null, group: null, difficulty: null, url: null, solutionUrl: null, minutes: null })), source: "page" as const, url: PRIMER };
    expect(await tools(provider(), "practice", { practice: { ...practice, list } })).toEqual(["answer", "items", "measure", "outline"]);
    // A book without a contents list may search for one; a book that has one may not.
    expect(await tools(provider(), "read", { kind: "book", minutes: 600 })).toEqual(["answer", "measure", "outline", "search"]);
    const toc = { source: "catalogue" as const, url: "https://openlibrary.org/works/OL1W", printPages: false, end: null, chapters: [] };
    expect(await tools(provider(), "read", { kind: "book", toc })).toEqual(["answer", "measure", "outline"]);
  });

  it("refuses a search past the finder's searches", async () => {
    const p = provider();
    const searches = Array.from({ length: STRUCTURE_SEARCHES + 1 }, (_, i) => [{ tool: "search", input: { query: `contents ${i}` } }]);
    const { model, calls } = scripted([...searches, [{ tool: "answer", input: answerOf({ whole: true }) }]]);
    const { ctx, calls: logged } = context();
    const result = await createStructureFinder({ provider: p, model }).find(material({ kind: "book", minutes: 600 }), "read", ctx);

    expect(p.search).toHaveBeenCalledTimes(STRUCTURE_SEARCHES);
    expect(result.counts.searches).toBe(STRUCTURE_SEARCHES);
    expect(JSON.stringify(calls[STRUCTURE_SEARCHES].prompt)).toContain("a result");
    expect(JSON.stringify(calls[STRUCTURE_SEARCHES + 1].prompt)).toContain("no searches left");
    expect(logged[0].facts).toContain("search contents 0");
  });

  it("measures a batch of linked pages side by side, each a size or an error", async () => {
    const week = (n: number): PageInfo => ({ ...extractHtml(`<html><head><title>Week ${n}</title></head><body><h1>Week ${n}</h1><p>${"word ".repeat(700)}</p></body></html>`, `https://example.com/w${n}`) });
    const pages = { [PRIMER]: primerInfo, "https://example.com/w1": week(1), "https://example.com/w2": week(2) };
    const { model, calls } = scripted([[{ tool: "measure", input: { urls: ["https://example.com/w1", "https://example.com/w2", "https://example.com/gone"] } }], [{ tool: "answer", input: answerOf({ whole: true }) }]]);
    const { ctx } = context(pages);
    const result = await createStructureFinder({ provider: null, model }).find(material(), "read", ctx);

    expect(result.counts.fetches).toBe(3);
    const toolResult = JSON.stringify(calls[1].prompt);
    expect(toolResult).toContain("Week 1");
    expect(toolResult).toContain("https://example.com/gone");
    expect(toolResult).toContain("error");
    expect(MEASURE_BATCH).toBe(12);
  });

  it("reads an item list with the items tool and keeps it, checked against the read", async () => {
    const listUrl = "https://example.com/problems";
    const text = "The list: Two Sum. Valid Anagram. Group Anagrams.";
    const read = vi.fn<FullReader>(async (url) => ({ finalUrl: url, text, file: false, truncated: false }));
    const drafts = ["Two Sum", "Valid Anagram", "Group Anagrams"].map((title) => ({ title, number: null, group: null, difficulty: null, url: null, solutionUrl: null, minutes: null }));
    const { model, calls } = scripted(
      [[{ tool: "items", input: { url: listUrl } }], [{ tool: "answer", input: answerOf({ whole: true, listUrl }) }]],
      [{ found: true, url: listUrl, items: drafts }],
    );
    const practice = { format: "problem-set" as const, items: 3, perItemMinutes: 20, minutes: 60, answers: true };
    const { ctx } = context();
    const resume = vi.spyOn(PausableClock.prototype, "resume");
    const result = await createStructureFinder({ provider: null, model, read }).find(material({ practice, minutes: null }), "practice", ctx);

    // The wall clock stood still while the list was read.
    expect(resume).toHaveBeenCalledTimes(1);
    resume.mockRestore();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.list!.items.map((i) => i.title)).toEqual(["Two Sum", "Valid Anagram", "Group Anagrams"]);
    expect(result.list!.url).toBe(listUrl);
    expect(result.counts.fetches).toBe(1);
    expect(JSON.stringify(calls[1].prompt)).toMatch(/\\?"items\\?":3/);
  });

  it("keeps an item list whose read takes longer than the finder's wall clock: the clock stands still meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const listUrl = "https://example.com/problems";
      const text = "The list: Two Sum. Valid Anagram. Group Anagrams.";
      const read = vi.fn<FullReader>(async (url) => {
        vi.advanceTimersByTime(STRUCTURE_WALL_MS + 5_000);
        return { finalUrl: url, text, file: false, truncated: false };
      });
      const drafts = ["Two Sum", "Valid Anagram", "Group Anagrams"].map((title) => ({ title, number: null, group: null, difficulty: null, url: null, solutionUrl: null, minutes: null }));
      const { model } = scripted(
        [[{ tool: "items", input: { url: listUrl } }], [{ tool: "answer", input: answerOf({ whole: true, listUrl }) }]],
        [{ found: true, url: listUrl, items: drafts }],
      );
      const practice = { format: "problem-set" as const, items: 3, perItemMinutes: 20, minutes: 60, answers: true };
      const result = await createStructureFinder({ provider: null, model, read }).find(material({ practice, minutes: null }), "practice", context().ctx);
      expect(read).toHaveBeenCalledTimes(1);
      expect(result.facts).not.toContain("no answer");
      expect(result.list!.items.map((i) => i.title)).toEqual(["Two Sum", "Valid Anagram", "Group Anagrams"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on without units when the loop's model call fails on the app's key", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await createStructureFinder({ provider: null, model }).find(material(), "read", context().ctx);
    expect(result).toMatchObject({ toc: null, list: null, refused: null, facts: ["no answer"] });
    errors.mockRestore();
  });

  it("rethrows a provider refusal on the user's own key", async () => {
    const refusal = new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "", isRetryable: false });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw refusal;
      },
    });
    await expect(createStructureFinder({ provider: null, model }).find(material(), "read", context({ [PRIMER]: primerInfo }, { keyOwner: "user" }).ctx)).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
  });

  it("rethrows a provider refusal inside the items tool on the user's own key", async () => {
    const refusal = new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "", isRetryable: false });
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        if (options.responseFormat?.type === "json") throw refusal;
        return stepResult([{ tool: "items", input: { url: "https://example.com/problems" } }]);
      },
    });
    const read = vi.fn<FullReader>(async (url) => ({ finalUrl: url, text: "Two Sum", file: false, truncated: false }));
    const practice = { format: "problem-set" as const, items: 3, perItemMinutes: 20, minutes: 60, answers: true };
    await expect(
      createStructureFinder({ provider: null, model, read }).find(material({ practice }), "practice", context({ [PRIMER]: primerInfo }, { keyOwner: "user" }).ctx),
    ).rejects.toSatisfy((e: unknown) => providerError(e)?.statusCode === 400);
  });
});

describe("the pausable clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run while paused", () => {
    vi.useFakeTimers();
    const clock = new PausableClock(40_000);
    clock.pause();
    vi.advanceTimersByTime(60_000);
    clock.resume();
    vi.advanceTimersByTime(39_000);
    expect(clock.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(clock.signal.aborted).toBe(true);
  });

  it("aborts with the outer signal", () => {
    const outer = new AbortController();
    const clock = new PausableClock(40_000, outer.signal);
    expect(clock.signal.aborted).toBe(false);
    outer.abort();
    expect(clock.signal.aborted).toBe(true);
    clock.pause();
  });
});

describe("the structure prompt", () => {
  it("names the source and says page text is data, with no target counts or shares", () => {
    for (const role of ["read", "practice", "both"] as const) {
      const prompt = buildStructurePrompt(material(), role);
      expect(prompt).toContain(PRIMER);
      expect(prompt).toContain("data");
      expect(prompt).toContain(String(MAX_CHAPTERS));
      expect(prompt).toContain("50 min");
      expect(prompt).not.toMatch(/\b\d+%/);
      expect(prompt).not.toMatch(/\bat least \d+ units\b/);
    }
    expect(buildStructurePrompt(material(), "practice")).toContain("items");
    expect(buildStructurePrompt(material(), "read")).not.toContain("`items`");
  });

  it("leaves the outline its reserve and the allocation its least time", () => {
    expect(STRUCTURE_RESERVE_MS).toBe(STRUCTURE_ALLOCATE_MIN_MS + OUTLINE_RESERVE_MS);
  });
});
