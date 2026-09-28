import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ModelCall } from "../logged";
import { createAgentArm } from "./agent";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import { researchMaterials, streamWhile } from "./pipeline";
import { SourceFetcher, type PageFetcher, type ResearchCaps, type SearchProvider } from "./tools";
import type { BookLookup, CandidateList } from "./verify";

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

const books: BookLookup = { find: async () => ({ title: "Core Textbook", authors: ["A. Author"], year: 2023 }) };

const LIST: CandidateList = {
  learner: [{ url: "https://learner.example.com/mine", kind: "essay", why: "Where the learner started" }],
  candidates: [
    { url: "https://books.example.com/core", title: "Core Textbook", kind: "book", backbone: true, author: "A. Author", why: "The standard text", recommendedBy: ["https://lists.bookrecs.com/best", "https://blog.readinglist.org/reading"] },
    { url: "https://docs.example.com/a", title: "Guide A", kind: "docs", backbone: false, why: "Official docs", recommendedBy: [] },
    { url: "https://docs.example.com/b", title: "Guide B", kind: "docs", backbone: false, why: "More docs", recommendedBy: [] },
    { url: "https://gone.example.com/", title: "Gone", kind: "essay", backbone: false, why: "Dead link", recommendedBy: [] },
  ],
};

const brief = { topic: "LLM engineering", days: 30, sources: [{ url: "https://learner.example.com/mine", type: "link" as const }] };

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
    expect(outcome.materials.map((m) => [m.id, m.title, m.origin, m.backbone])).toEqual([
      ["M1", "Core Textbook", "research", true],
      ["M2", "My notes page", "learner", false],
      ["M3", "Guide A", "research", false],
      ["M4", "Guide B", "research", false],
    ]);
    expect(outcome.notice).toBe("thin");
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
