import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import type { Material } from "@/lib/schemas/material";
import { providerError } from "../providerError";
import { FINDER_PAGE_CHARS, createChapterFinder, validateChaptersAnswer } from "./chapterFinder";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import { SearchProviderError, SourceFetcher, type PageFetcher, type SearchProvider } from "./tools";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function info(url: string, title: string | null, extra: Partial<PageInfo> = {}): PageInfo {
  return { finalUrl: url, title, ogTitle: null, h1: null, author: null, published: null, text: "", ...extra };
}

function fetcherFor(pages: Record<string, PageInfo>) {
  const fetchPage = vi.fn<PageFetcher>(async (url) => {
    const p = pages[url];
    if (!p) throw new Error(`404 ${url}`);
    return p;
  });
  return { fetcher: new SourceFetcher(fetchPage), fetchPage };
}

describe("the chapter finder", () => {
  const book: Material = {
    id: "M1",
    origin: "research",
    type: "link",
    kind: "book",
    url: "https://openlibrary.org/works/OL1W",
    title: "AI Engineering: Building Applications",
    author: "Chip Huyen",
    year: 2024,
    why: null,
    backbone: true,
    verifiedAt: null,
    fetchedTitle: null,
    recommendedBy: [],
    sig: null,
    minutes: 1105,
  };
  const results = [
    { title: "OL", url: "https://openlibrary.org/works/OL1W", snippet: "", publishedDate: null },
    { title: "http", url: "http://insecure.example.com/toc", snippet: "", publishedDate: null },
    { title: "Review", url: "https://www.example.org/review", snippet: "", publishedDate: null },
    { title: "Blocked", url: "https://blocked.example.com/", snippet: "", publishedDate: null },
    { title: "Syllabus", url: "https://uni.example.edu/syllabus", snippet: "", publishedDate: null },
  ];
  const pages: Record<string, PageInfo> = {
    "https://www.example.org/review": info("https://www.example.org/review", "Review", { text: "Contents: 1. A 2. B 3. C " + "x".repeat(9000) }),
    "https://uni.example.edu/syllabus": info("https://uni.example.edu/syllabus", "Syllabus", { text: "We read chapters 1-3" }),
  };
  const provider = () => ({ name: "fake", search: vi.fn<SearchProvider["search"]>(async () => results) });
  const answer = (a: unknown) =>
    new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify(a) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
    });
  const good = {
    found: true,
    url: "https://example.org/review/?utm_source=x",
    chapters: [{ n: 1, title: "A", sections: ["A1", "Summary"] }, { n: 2, title: "B", sections: [] }, { n: 3, title: "C", sections: [] }],
  };

  it("searches once, reads the https non-catalogue results that open, and feeds them to the model", async () => {
    const p = provider();
    const model = answer(good);
    const { fetcher, fetchPage } = fetcherFor(pages);
    const events: ResearchEvent[] = [];
    const found = await createChapterFinder({ provider: p, model }).find(book, { fetcher, emit: (e) => void events.push(e) });
    expect(p.search.mock.calls[0][0]).toBe("AI Engineering Chip Huyen table of contents");
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual(["https://www.example.org/review", "https://blocked.example.com/", "https://uni.example.edu/syllabus"]);
    expect(events.filter((e) => e.type === "research.fetch").map((e) => (e as { ok: boolean }).ok)).toEqual([true, false, true]);
    expect(found.counts).toEqual({ searches: 1, fetches: 3 });
    expect(found.toc).toMatchObject({ source: "page", url: "https://www.example.org/review", printPages: false, end: null });
    expect(found.toc!.chapters.map((c) => [c.n, c.title, c.page, c.minutes, c.sections])).toEqual([
      [1, "A", null, null, ["A1"]],
      [2, "B", null, null, []],
      [3, "C", null, null, []],
    ]);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("--- https://www.example.org/review ---");
    expect(prompt).toContain("--- https://uni.example.edu/syllabus ---");
    expect(prompt).not.toContain("x".repeat(FINDER_PAGE_CHARS + 1));
  });
  it("rejects an answer whose url was not read, found: false, too few chapters, and numbers out of order", () => {
    const read = ["https://www.example.org/review"];
    expect(validateChaptersAnswer({ ...good, url: "https://elsewhere.example.com/" }, read)).toBeNull();
    expect(validateChaptersAnswer({ ...good, found: false }, read)).toBeNull();
    expect(validateChaptersAnswer({ ...good, chapters: good.chapters.slice(0, 2) }, read)).toBeNull();
    expect(validateChaptersAnswer({ ...good, chapters: [{ n: 2, title: "B", sections: [] }, { n: 1, title: "A", sections: [] }, { n: 3, title: "C", sections: [] }] }, read)).toBeNull();
    expect(validateChaptersAnswer(good, read)).not.toBeNull(); // trailing slash, www and a tracking query are ignored
  });
  it("is null when the search fails or no page opens, without calling the model", async () => {
    const model = answer(good);
    const down = {
      name: "fake",
      search: vi.fn<SearchProvider["search"]>(async () => {
        throw new SearchProviderError("down");
      }),
    };
    expect((await createChapterFinder({ provider: down, model }).find(book, { fetcher: fetcherFor({}).fetcher, emit: () => {} })).toc).toBeNull();
    expect((await createChapterFinder({ provider: provider(), model }).find(book, { fetcher: fetcherFor({}).fetcher, emit: () => {} })).toc).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(0);
  });
  it("rethrows a provider refusal on the user's key and swallows one on the app's", async () => {
    const refusal = () =>
      new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });
    const refusing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw refusal();
      },
    });
    const ctx = { fetcher: fetcherFor(pages).fetcher, emit: () => {} };
    await expect(createChapterFinder({ provider: provider(), model: refusing }).find(book, { ...ctx, log: { keyOwner: "user" } })).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
    expect((await createChapterFinder({ provider: provider(), model: refusing }).find(book, ctx)).toc).toBeNull();
  });
});
