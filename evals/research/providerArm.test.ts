import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelCall } from "@/lib/ai/logged";
import type { ResearchEvent } from "@/lib/ai/research/events";
import { SourceFetcher } from "@/lib/ai/research/tools";
import type { CandidateList } from "@/lib/ai/research/verify";
import { PROVIDER_CLOCK_FACTOR, createProviderArm } from "./providerArm";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};
const finish: LanguageModelV4StreamPart = { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage };

const LIST: CandidateList = {
  learner: [],
  candidates: [{ url: "https://docs.example.com/a", title: "Guide A", kind: "docs", backbone: false, why: "w", recommendedBy: ["https://lists.example.org/best"] }],
};

const SEARCH: LanguageModelV4StreamPart[] = [
  { type: "tool-call", toolCallId: "s1", toolName: "web_search", input: JSON.stringify({ query: "best guide" }), providerExecuted: true },
  { type: "tool-result", toolCallId: "s1", toolName: "web_search", result: [{ type: "web_search_result", url: "https://lists.example.org/best", title: "Best guides", pageAge: null, encryptedContent: "x" }] },
];
const FETCH: LanguageModelV4StreamPart[] = [
  { type: "tool-call", toolCallId: "f1", toolName: "web_fetch", input: JSON.stringify({ url: "https://docs.example.com/a" }), providerExecuted: true },
  { type: "tool-result", toolCallId: "f1", toolName: "web_fetch", result: { type: "web_fetch_result", url: "https://docs.example.com/a", content: { type: "document", title: "Guide A", source: { type: "text", mediaType: "text/plain", data: "About A" } }, retrievedAt: null } },
];
const TEXT = (id: string, text: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
];

const jsonAnswer = (): LanguageModelV4GenerateResult => ({ content: [{ type: "text", text: JSON.stringify(LIST) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] });

/** A model whose research turns stream `turns` in order; the structured step answers with the list. */
function streamingModel(turns: LanguageModelV4StreamPart[][]) {
  const queue = [...turns];
  return new MockLanguageModelV4({
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => jsonAnswer(),
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...(queue.shift() ?? TEXT("t", "Done.")), finish] }) }),
  });
}

/** A model whose first turn streams `parts` and then never ends, until the caller aborts it. */
function hangingModel(parts: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => jsonAnswer(),
    doStream: async (options: LanguageModelV4CallOptions) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          for (const part of parts) controller.enqueue(part);
          options.abortSignal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      }),
    }),
  });
}

const brief = { topic: "X", days: 7, sources: [] };
const smallCaps = { steps: 4, searches: 3, fetches: 6, wallMs: 150 };

describe("arm C", () => {
  it("records provider-executed search and fetch results as they stream, then runs the same structured step", async () => {
    const model = streamingModel([[...SEARCH, ...FETCH, ...TEXT("t1", "Found guide A.")]]);
    const events: ResearchEvent[] = [];
    const calls: ModelCall[] = [];
    const arm = createProviderArm({ model });
    const result = await arm({ brief, fetcher: new SourceFetcher(), emit: (e) => void events.push(e), log: { onCall: (c) => void calls.push(c) } });
    expect(events).toEqual([
      { type: "research.search", query: "best guide", results: 1 },
      { type: "research.fetch", url: "https://docs.example.com/a", ok: true },
    ]);
    expect(result.counts).toMatchObject({ searches: 1, fetches: 1 });
    expect(result.searchesOk).toBe(1);
    expect(result.stoppedBy).toBe("model");
    expect(result.seenUrls.has("https://lists.example.org/best")).toBe(true);
    expect(result.candidates).toEqual(LIST.candidates);
    // The first step's call carries the instructions, which describe arm C's budget, not arm A's.
    expect(calls[0].label).toBe("Research C · step 1");
    expect(calls[0].system).toContain("each tool stops on its own once its budget is used");
    expect(calls[0].system).not.toContain("calls past a cap are refused");
    expect(calls[0].response).toContain("Found guide A.");
    expect(calls[0].facts).toEqual(["1 searches", "1 reads"]);
  });

  it("keeps what streamed in when the clock cuts the turn off, and runs its clock longer than arm A's", async () => {
    const model = hangingModel(SEARCH);
    const events: ResearchEvent[] = [];
    const started = Date.now();
    const arm = createProviderArm({ model, caps: smallCaps });
    const result = await arm({ brief, fetcher: new SourceFetcher(), emit: (e) => void events.push(e) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(smallCaps.wallMs * PROVIDER_CLOCK_FACTOR - 20);
    expect(result.stoppedBy).toBe("clock");
    expect(result.counts.searches).toBe(1);
    expect(events[0]).toEqual({ type: "research.search", query: "best guide", results: 1 });
    // The structured step still runs on the partial notes.
    expect(result.candidates).toEqual(LIST.candidates);
  });

  it("reports a clock that fired before any tool returned as idle", async () => {
    const model = hangingModel([]);
    const arm = createProviderArm({ model, caps: smallCaps });
    const result = await arm({ brief, fetcher: new SourceFetcher(), emit: () => {} });
    expect(result.stoppedBy).toBe("clock-idle");
    expect(result.counts).toMatchObject({ searches: 0, fetches: 0 });
  });
});
