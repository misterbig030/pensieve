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
import type { ServiceEvent } from "../serviceEvents";
import type { ResearchEvent } from "./events";
import { extractHtml, type PageInfo } from "./extract";
import type { FullReader } from "./itemFinder";
import {
  ANSWER_NOW,
  APP_SHELL_NOTE,
  MEASURE_BATCH,
  PausableClock,
  STRUCTURE_ALLOCATE_MIN_MS,
  STRUCTURE_RESERVE_MS,
  STRUCTURE_SEARCHES,
  STRUCTURE_STEPS,
  STRUCTURE_WALL_MS,
  answerStepOptions,
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
/** A page as the extractor reads it: a title and one paragraph, no headings, no links. */
const info = (url: string, title: string, text: string): PageInfo => extractHtml(`<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`, url);
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
      modelId: "claude-sonnet-5-5",
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
    // Only the forced step lets Anthropic drop thinking blocks sealed with the full tool list; the others keep the effort alone.
    expect(calls.at(-1)!.providerOptions).toEqual({ anthropic: { effort: "medium", thinking: { type: "adaptive", blockBinding: { prefixMismatchBehavior: "drop_block" } } } });
    for (const c of calls.slice(0, -1)) expect(c.providerOptions).toEqual({ anthropic: { effort: "medium" } });
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

  it("measures the linked pages its answer cites but never fetched, before the check", async () => {
    const hubUrl = "https://github.com/a/b";
    const weeks = Array.from({ length: 10 }, (_, i) => i + 1);
    const folder = (n: number) => `${hubUrl}/tree/main/week${n}`;
    const hub = extractHtml(
      `<html><head><title>a/b</title></head><body><article class="markdown-body"><h2 id="user-content-weeks">Weeks</h2><ul>${weeks
        .map((n) => `<li><a href="/a/b/tree/main/week${n}">Week ${n} notes</a></li>`)
        .join("")}</ul></article></body></html>`,
      hubUrl,
    );
    const week = (n: number) => extractHtml(`<html><head><title>week${n}</title></head><body><article class="markdown-body"><h1>Week ${n} notes</h1><p>${"word ".repeat(900)}</p></article></body></html>`, folder(n));
    const pages: Record<string, PageInfo> = { [hubUrl]: hub, ...Object.fromEntries(weeks.map((n) => [folder(n), week(n)])) };
    // Ten weeks the hub links, and an eleventh it never mentions: that one is not fetched on the answer's word.
    const units = [...weeks, 11].map((n) => ({ title: `Week ${n} notes`, at: folder(n), kind: "read" as const, group: null, minutes: null }));
    const { model } = scripted([[{ tool: "outline", input: { url: hubUrl } }], [{ tool: "answer", input: answerOf({ units }) }]]);
    const { ctx, calls: logged, fetchPage } = context(pages);
    const result = await createStructureFinder({ provider: null, model }).find(material({ url: hubUrl, title: "a/b" }), "read", ctx);

    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([hubUrl, ...weeks.map(folder)]);
    expect(result.counts.fetches).toBe(11);
    expect(result.refused).toBeNull();
    expect(result.toc!.chapters.map((c) => c.title)).toEqual(weeks.map((n) => `Week ${n} notes`));
    expect(result.basis).toBe("measured");
    expect(logged.at(-1)!.facts).toEqual(["answer", "units kept: 10", "measured 10 cited pages after the answer", "1 of 11 units point to no fetched page or heading"]);
  });

  it("measures nothing after an answer whose units all point at fetched pages", async () => {
    const units = THIRTY.map((h) => ({ title: h.title, at: `${PRIMER}#${h.anchor}`, kind: "read" as const, group: null, minutes: null }));
    const { model } = scripted([[{ tool: "outline", input: { url: PRIMER } }], [{ tool: "answer", input: answerOf({ units }) }]]);
    const { ctx, calls: logged, fetchPage } = context();
    await createStructureFinder({ provider: null, model }).find(material(), "read", ctx);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(logged.at(-1)!.facts.some((f) => f.startsWith("measured"))).toBe(false);
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

  it("tells a practice finder that a page drawn by script holds no list, and where to look instead", async () => {
    // neetcode.io/practice in run 11: 8 words, no headings, no links. The finder searched once, then gave up.
    const SHELL = "https://neetcode.io/practice";
    const shell = info(SHELL, "NeetCode | Coding Interview Prep, Courses, Versus Mode", "NeetCode Coding Interview Prep Courses Versus Mode");
    const practice = { format: "problem-set" as const, items: 150, perItemMinutes: null, minutes: null, answers: true };
    const outlineOf = async (role: "practice" | "both" | "read", page: PageInfo = shell) => {
      const { model, calls } = scripted([[{ tool: "outline", input: { url: SHELL } }], [{ tool: "answer", input: answerOf({ whole: true }) }]]);
      await createStructureFinder({ provider: null, model }).find(material({ url: SHELL, kind: "tool", practice, minutes: null }), role, context({ [SHELL]: page }).ctx);
      return JSON.stringify(calls[1].prompt);
    };

    expect(APP_SHELL_NOTE).toMatch(/repository/);
    expect(APP_SHELL_NOTE).toMatch(/`items`/);
    const note = JSON.stringify(APP_SHELL_NOTE).slice(1, 60);
    expect(await outlineOf("practice")).toContain(note);
    expect(await outlineOf("both")).toContain(note);
    // Reading has no list to look for; a page with words is not a shell.
    expect(await outlineOf("read")).not.toContain(note);
    const words = info(SHELL, "NeetCode", Array.from({ length: 120 }, (_, i) => `word${i}`).join(" "));
    expect(await outlineOf("practice", words)).not.toContain(note);
  });

  it("keeps a list read from a GitHub file page under the raw address it was read at, when the answer names either", async () => {
    const BLOB = "https://github.com/acme/problems/blob/main/list.json";
    const RAW = "https://raw.githubusercontent.com/acme/problems/main/list.json";
    const file = JSON.stringify(["Two Sum", "Valid Anagram", "Group Anagrams"].map((problem) => ({ problem })));
    const read = vi.fn<FullReader>(async (url) => ({ finalUrl: url, text: file, file: true, truncated: false }));
    const mapping = { found: true, path: "", title: "problem", number: null, group: null, difficulty: null, minutes: null, url: null, solutionUrl: null, subset: null };
    const practice = { format: "problem-set" as const, items: 3, perItemMinutes: 20, minutes: 60, answers: true };
    for (const listUrl of [BLOB, RAW]) {
      const { model } = scripted([[{ tool: "items", input: { url: BLOB } }], [{ tool: "answer", input: answerOf({ whole: true, listUrl }) }]], [mapping]);
      const result = await createStructureFinder({ provider: null, model, read }).find(material({ practice, minutes: null }), "practice", context().ctx);
      expect(read).toHaveBeenLastCalledWith(RAW, expect.anything());
      expect(result.list?.url).toBe(RAW);
      expect(result.list!.items.map((i) => i.title)).toEqual(["Two Sum", "Valid Anagram", "Group Anagrams"]);
    }
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

  it("reports a structure finder's swallowed provider failure on the app's key", async () => {
    const failure = new APICallError({ message: "overloaded", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 500, responseBody: "", isRetryable: false });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw failure;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: ServiceEvent[] = [];
    const { ctx } = context();
    const result = await createStructureFinder({ provider: null, model }).find(material(), "read", { ...ctx, log: { ...ctx.log, onService: (e) => void events.push(e) } });
    expect(result).toMatchObject({ toc: null, list: null, refused: null, facts: ["no answer"] });
    expect(events).toContainEqual(expect.objectContaining({ type: "service", name: "anthropic", ok: false, final: true, where: "structure", status: 500 }));
    errors.mockRestore();
  });

  it("reports the searches its tool makes", async () => {
    const { model } = scripted([[{ tool: "search", input: { query: "toc" } }], [{ tool: "answer", input: answerOf({}) }]]);
    const events: ServiceEvent[] = [];
    const { ctx } = context();
    await createStructureFinder({ provider: provider(), model }).find(material({ kind: "book", minutes: 600 }), "read", { ...ctx, log: { ...ctx.log, onService: (e) => void events.push(e) } });
    expect(events).toContainEqual(expect.objectContaining({ name: "search", ok: true, final: true }));
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
    // A practice source whose site draws its list by script is pointed at its repository's data file.
    for (const role of ["practice", "both"] as const) expect(buildStructurePrompt(material(), role)).toContain("publishes the list in its open-source repository as a data file");
    expect(buildStructurePrompt(material(), "read")).not.toContain("open-source repository");
    // A page seen only as a link must be measured before a unit may point at it.
    for (const role of ["read", "practice", "both"] as const) expect(buildStructurePrompt(material(), role)).toContain("`measure` it before");
  });

  it("leaves the outline its reserve and the allocation its least time", () => {
    expect(STRUCTURE_RESERVE_MS).toBe(STRUCTURE_ALLOCATE_MIN_MS + OUTLINE_RESERVE_MS);
  });
});

describe("the forced answer on Anthropic", () => {
  it("asks Anthropic to drop thinking blocks the narrowed tool list no longer matches", async () => {
    // Sonnet 5.5 rejects a forced tool, so the provider sends only `answer`; thinking blocks from the earlier steps were
    // sealed with every tool, and without drop_block Anthropic refuses the request (400, "The `tools` list differs").
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const { generateText, tool } = await import("ai");
    const { z } = await import("zod");
    let body: Record<string, unknown> = {};
    let beta = "";
    const fetchStub = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
      return new Response(
        JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "toolu_1", name: "answer", input: { units: [] } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const model = createAnthropic({ apiKey: "test", fetch: fetchStub as typeof fetch })("claude-sonnet-5-5");
    const tools = {
      outline: tool({ description: "Read a page", inputSchema: z.object({ url: z.string() }) }),
      answer: tool({ description: "Answer", inputSchema: z.object({ units: z.array(z.string()) }) }),
    };
    await generateText({ model, tools, toolChoice: { type: "tool", toolName: "answer" }, prompt: "Answer now.", providerOptions: answerStepOptions("medium", "claude-sonnet-5-5") });

    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["answer"]);
    // Anthropic refuses a binding without a thinking type ("thinking.type: Field required"); Sonnet 5.5 thinks adaptively.
    expect(body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(beta).toContain("thinking-binding-controls-2026-08-01");
  });

  it("leaves the thinking alone for a model that keeps every tool when forced, by gateway id or API id", () => {
    // Haiku 4.5 has no adaptive thinking and is sent the whole tool list with the forced choice, so nothing mismatches.
    expect(answerStepOptions("medium", "claude-haiku-4-5")).toEqual({ anthropic: { effort: "medium" } });
    expect(answerStepOptions("medium", "anthropic/claude-sonnet-5")).toEqual({ anthropic: { effort: "medium" } });
    expect(answerStepOptions("medium", "mock-model-id")).toEqual({ anthropic: { effort: "medium" } });
    for (const id of ["anthropic/claude-sonnet-5.5", "claude-opus-5-5", "anthropic/claude-opus-5.5"]) {
      expect(answerStepOptions("medium", id).anthropic).toHaveProperty("thinking", { type: "adaptive", blockBinding: { prefixMismatchBehavior: "drop_block" } });
    }
  });
});
