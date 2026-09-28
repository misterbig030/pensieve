import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ResearchEvent } from "@/lib/ai/research/events";
import { SourceFetcher } from "@/lib/ai/research/tools";
import type { CandidateList } from "@/lib/ai/research/verify";
import { createProviderArm } from "./providerArm";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const LIST: CandidateList = {
  learner: [],
  candidates: [{ url: "https://docs.example.com/a", title: "Guide A", kind: "docs", backbone: false, why: "w", recommendedBy: ["https://lists.example.org/best"] }],
};

describe("arm C", () => {
  it("maps provider-executed search and fetch results into events and notes, then runs the same structured step", async () => {
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
        if (options.responseFormat?.type === "json") {
          return { content: [{ type: "text", text: JSON.stringify(LIST) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        }
        step += 1;
        if (step > 1) return { content: [{ type: "text", text: "Done." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        return {
          content: [
            { type: "tool-call", toolCallId: "s1", toolName: "web_search", input: JSON.stringify({ query: "best guide" }), providerExecuted: true },
            { type: "tool-result", toolCallId: "s1", toolName: "web_search", result: [{ type: "web_search_result", url: "https://lists.example.org/best", title: "Best guides", pageAge: null, encryptedContent: "x" }] },
            { type: "tool-call", toolCallId: "f1", toolName: "web_fetch", input: JSON.stringify({ url: "https://docs.example.com/a" }), providerExecuted: true },
            { type: "tool-result", toolCallId: "f1", toolName: "web_fetch", result: { type: "web_fetch_result", url: "https://docs.example.com/a", content: { type: "document", title: "Guide A", source: { type: "text", mediaType: "text/plain", data: "About A" } }, retrievedAt: null } },
            { type: "text", text: "Found guide A." },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const events: ResearchEvent[] = [];
    const arm = createProviderArm({ model });
    const result = await arm({ brief: { topic: "X", days: 7, sources: [] }, fetcher: new SourceFetcher(), emit: (e) => void events.push(e) });
    expect(events).toEqual([
      { type: "research.search", query: "best guide", results: 1 },
      { type: "research.fetch", url: "https://docs.example.com/a", ok: true },
    ]);
    expect(result.counts).toMatchObject({ searches: 1, fetches: 1 });
    expect(result.searchesOk).toBe(1);
    expect(result.seenUrls.has("https://lists.example.org/best")).toBe(true);
    expect(result.candidates).toEqual(LIST.candidates);
  });
});
