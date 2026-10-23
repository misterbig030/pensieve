import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { ChapterList } from "@/lib/schemas/material";
import { providerError } from "../providerError";
import type { ResearchArm } from "./agent";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import { defaultChapterFinder, researchMaterials } from "./pipeline";
import { SourceFetcher, type PageFetcher } from "./tools";
import type { BookLookup } from "./verify";

function page(url: string, title: string): PageInfo {
  return { finalUrl: url, title, ogTitle: null, h1: null, author: null, published: null, text: `About ${title}` };
}

function fetcherFor(pages: Record<string, PageInfo>) {
  const fetchPage = vi.fn<PageFetcher>(async (url) => {
    const p = pages[url];
    if (!p) throw new Error(`404 ${url}`);
    return p;
  });
  return { fetcher: new SourceFetcher(fetchPage), fetchPage };
}

async function collect(gen: AsyncGenerator<ResearchEvent, unknown>) {
  const events: ResearchEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, outcome: next.value as Awaited<ReturnType<typeof researchMaterials>> extends AsyncGenerator<unknown, infer R> ? R : never };
}

const brief = { topic: "LLM engineering", weeks: 4, sources: [] };
const recs = ["https://lists.bookrecs.com/best", "https://blog.readinglist.org/reading"];
const bookUrl = "https://books.example.com/core";
const arm: ResearchArm = async () => ({
  candidates: [{ url: bookUrl, title: "Core Textbook", kind: "book", author: "A. Author", why: "The standard text", recommendedBy: recs }],
  learnerNotes: [],
  seenUrls: new Set(recs),
  counts: { steps: 1, searches: 0, fetches: 0 },
  searchesOk: 1,
  stoppedBy: "model",
  costUsd: 0,
  coverage: null,
});
const books: BookLookup = { find: async () => ({ key: "/works/OL1W", title: "Core Textbook", authors: ["A. Author"], year: 2023, pages: 400 }) };
const { fetcher } = fetcherFor({ [bookUrl]: page(bookUrl, "Core Textbook") });

const TOC: ChapterList = {
  source: "page",
  url: "https://www.example.org/review",
  printPages: false,
  end: null,
  chapters: [
    { n: 1, title: "A", page: null, minutes: null, sections: [] },
    { n: 2, title: "B", page: null, minutes: null, sections: [] },
    { n: 3, title: "C", page: null, minutes: null, sections: [] },
  ],
};

describe("the chapters stage", () => {
  it("runs the finder for a backbone without chapters and merges the list, counts and cost", async () => {
    const finder = { find: vi.fn(async () => ({ toc: TOC, counts: { searches: 1, fetches: 2 }, costUsd: 0.02 })) };
    const { events, outcome } = await collect(researchMaterials({ brief, arm, fetcher, books, chapters: finder }));
    expect(finder.find).toHaveBeenCalledTimes(1);
    expect(outcome.materials.find((m) => m.backbone)!.toc).toEqual(TOC);
    expect(outcome.costUsd).toBeCloseTo(0.02);
    const done = events.find((e) => e.type === "research.done") as Extract<ResearchEvent, { type: "research.done" }>;
    expect(done.counts).toEqual({ searches: 1, fetches: 2 });
    expect(done.materials.find((m) => m.backbone)!.toc).toEqual(TOC);
    expect(events.find((e) => e.type === "research.chapters")).toMatchObject({ chapters: 3, source: "page", url: TOC.url });
  });
  it("skips the finder when the catalogue already gave the backbone its chapters", async () => {
    const finder = { find: vi.fn() };
    const catalogue: BookLookup = {
      ...books,
      chapters: async () => ({ ...TOC, source: "catalogue", url: "https://openlibrary.org/books/OL1M", printPages: true, end: 100, chapters: TOC.chapters.map((c, i) => ({ ...c, page: (i + 1) * 10 })) }),
    };
    const { events } = await collect(researchMaterials({ brief, arm, fetcher, books: catalogue, chapters: finder }));
    expect(finder.find).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "research.chapters")).toHaveLength(1);
    expect(events.find((e) => e.type === "research.chapters")).toMatchObject({ source: "catalogue" });
  });
  it("announces chapters 0 with no source when the finder finds nothing, and runs nothing without a finder", async () => {
    const finder = { find: vi.fn(async () => ({ toc: null, counts: { searches: 1, fetches: 3 }, costUsd: 0 })) };
    const { events } = await collect(researchMaterials({ brief, arm, fetcher, books, chapters: finder }));
    expect(events.find((e) => e.type === "research.chapters")).toMatchObject({ chapters: 0, source: null });
    const bare = await collect(researchMaterials({ brief, arm, fetcher, books }));
    expect(bare.events.some((e) => e.type === "research.chapters")).toBe(false);
  });
  it("swallows a finder error on the app's key and rethrows a provider refusal on the user's", async () => {
    const boom = {
      find: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const { outcome } = await collect(researchMaterials({ brief, arm, fetcher, books, chapters: boom }));
    expect(outcome.materials.find((m) => m.backbone)!.toc ?? null).toBeNull();
    const refusal = {
      find: vi.fn(async () => {
        throw new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });
      }),
    };
    await expect(collect(researchMaterials({ brief, arm, fetcher, books, chapters: refusal, log: { keyOwner: "user" } }))).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
  });
  it("defaultChapterFinder is null without a search key", () => {
    expect(defaultChapterFinder({})).toBeNull();
    expect(defaultChapterFinder({ TAVILY_API_KEY: "k" })).not.toBeNull();
  });
});
