import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { PRACTICE_FORMATS, PRACTICE_REGISTRY } from "@/lib/practice";
import { providerError } from "../providerError";
import type { ModelCall } from "../logged";
import { briefLines, buildFinalPrompt, buildResearchInstructions, createAgentArm, practiceLines } from "./agent";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import { isThin, researchMaterials, streamWhile, verifiedReading } from "./pipeline";
import { RESEARCH_CAPS, SourceFetcher, capsFor, type PageFetcher, type ResearchCaps, type SearchProvider } from "./tools";
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

const books: BookLookup = { find: async () => ({ key: "/works/OL1W", title: "Core Textbook", authors: ["A. Author"], year: 2023 }) };

const LIST: CandidateList = {
  learner: [{ url: "https://learner.example.com/mine", kind: "essay", why: "Where the learner started" }],
  candidates: [
    { url: "https://books.example.com/core", title: "Core Textbook", kind: "book", backbone: true, author: "A. Author", why: "The standard text", recommendedBy: ["https://lists.bookrecs.com/best", "https://blog.readinglist.org/reading"] },
    { url: "https://docs.example.com/a", title: "Guide A", kind: "docs", backbone: false, why: "Official docs", recommendedBy: [] },
    { url: "https://docs.example.com/b", title: "Guide B", kind: "docs", backbone: false, why: "More docs", recommendedBy: [] },
    { url: "https://gone.example.com/", title: "Gone", kind: "essay", backbone: false, why: "Dead link", recommendedBy: [] },
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
    expect(outcome.materials.map((m) => [m.id, m.title, m.origin, m.backbone])).toEqual([
      ["M1", "Core Textbook", "research", true],
      ["M2", "My notes page", "learner", false],
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
    expect(prompt).toContain("must not exceed 360 hours");
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

  it("caps the candidates' minutes at all study hours again and lists materials whole", () => {
    const prompt = buildFinalPrompt({ topic: "T", weeks: 8, hoursPerWeek: 6, sources: [] }, "notes");
    expect(prompt).toContain("48 hours of study in all");
    expect(prompt).toContain("must not exceed 48 hours");
    expect(prompt).not.toContain("the plan's reading time");
    expect(prompt).toContain("list each material at its whole size");
    expect(prompt).toContain("which part the plan uses is decided after research");
    expect(prompt).toContain("When the notes name a leading book, list it first even when the whole book runs past the time");
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
