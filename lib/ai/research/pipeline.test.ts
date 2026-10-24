import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { ChapterList, Material, PracticeList } from "@/lib/schemas/material";
import { providerError } from "../providerError";
import type { ResearchArm } from "./agent";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import { aliasMaterials } from "@/lib/materials";
import { defaultChapterFinder, defaultItemFinder, likelyItemLists, researchMaterials } from "./pipeline";
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

const core = (materials: Material[]) => materials.find((m) => m.title === "Core Textbook")!;

describe("the chapters stage", () => {
  it("runs the finder for a catalogued book without chapters that two sites recommend, and merges the list, counts and cost", async () => {
    const finder = { find: vi.fn(async () => ({ toc: TOC, counts: { searches: 1, fetches: 2 }, costUsd: 0.02 })) };
    const { events, outcome } = await collect(researchMaterials({ brief, arm, fetcher, books, chapters: finder }));
    expect(finder.find).toHaveBeenCalledTimes(1);
    // Research leaves the backbone to the allocation; the finder looked because the book could be it.
    expect(outcome.materials.some((m) => m.backbone)).toBe(false);
    expect(core(outcome.materials).toc).toEqual(TOC);
    expect(outcome.costUsd).toBeCloseTo(0.02);
    const done = events.find((e) => e.type === "research.done") as Extract<ResearchEvent, { type: "research.done" }>;
    expect(done.counts).toEqual({ searches: 1, fetches: 2 });
    expect(core(done.materials).toc).toEqual(TOC);
    expect(events.find((e) => e.type === "research.chapters")).toMatchObject({ chapters: 3, source: "page", url: TOC.url });
  });
  it("skips the finder when the catalogue already gave the book its chapters", async () => {
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
    expect(core(outcome.materials).toc ?? null).toBeNull();
    const refusal = {
      find: vi.fn(async () => {
        throw new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });
      }),
    };
    await expect(collect(researchMaterials({ brief, arm, fetcher, books, chapters: refusal, log: { keyOwner: "user" } }))).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
  });
  it("looks for chapters for up to two likely backbones, most recommending sites first, in parallel", async () => {
    const site = (n: number) => `https://reviews${n}.org/books`;
    const seen = [1, 2, 3, 4].map(site);
    const url = (slug: string) => `https://books.example.com/${slug}`;
    const listed = [
      { slug: "one", title: "One Site Book", recs: [site(1)] },
      { slug: "three", title: "Three Sites Book", recs: [site(1), site(2), site(3)] },
      { slug: "two", title: "Two Sites Book", recs: [site(1), site(2)] },
      // Recommended most, but Open Library was down for it: never a backbone, so not looked up.
      { slug: "down", title: "Unmatched Book", recs: seen },
    ];
    const manyArm: ResearchArm = async () => ({
      candidates: listed.map((b) => ({ url: url(b.slug), title: b.title, kind: "book" as const, author: "A. Author", why: "w", recommendedBy: b.recs })),
      learnerNotes: [],
      seenUrls: new Set(seen),
      counts: { steps: 1, searches: 0, fetches: 0 },
      searchesOk: 1,
      stoppedBy: "model",
      costUsd: 0,
      coverage: null,
    });
    const lookup: BookLookup = {
      find: async (title) => {
        if (title === "Unmatched Book") throw new Error("Open Library down");
        return { key: "/works/OL1W", title, authors: ["A. Author"], year: 2023, pages: 400 };
      },
    };
    const { fetcher: many } = fetcherFor(Object.fromEntries(listed.map((b) => [url(b.slug), page(url(b.slug), b.title)])));
    let inFlight = 0;
    let most = 0;
    const finder = {
      find: vi.fn(async (book: Material) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { toc: book.title === "Three Sites Book" ? TOC : null, counts: { searches: 1, fetches: 1 }, costUsd: 0.01 };
      }),
    };
    const { events, outcome } = await collect(researchMaterials({ brief, arm: manyArm, fetcher: many, books: lookup, chapters: finder }));
    expect(finder.find.mock.calls.map(([book]) => book.title)).toEqual(["Three Sites Book", "Two Sites Book"]);
    expect(most).toBe(2);
    const chapters = events.filter((e) => e.type === "research.chapters");
    expect(chapters.map((e) => (e.type === "research.chapters" ? [e.title, e.chapters, e.source] : null)).sort()).toEqual([
      ["Three Sites Book", 3, "page"],
      ["Two Sites Book", 0, null],
    ]);
    expect(outcome.materials.find((m) => m.title === "Three Sites Book")!.toc).toEqual(TOC);
    expect(outcome.materials.some((m) => m.backbone)).toBe(false);
    expect(outcome.costUsd).toBeCloseTo(0.02);
    const done = events.find((e) => e.type === "research.done") as Extract<ResearchEvent, { type: "research.done" }>;
    expect(done.counts).toEqual({ searches: 2, fetches: 2 });
  });
  it("defaultChapterFinder is null without a search key", () => {
    expect(defaultChapterFinder({})).toBeNull();
    expect(defaultChapterFinder({ TAVILY_API_KEY: "k" })).not.toBeNull();
  });
});

describe("the item lists stage", () => {
  const practiceUrl = (slug: string) => `https://practice.example.com/${slug}`;
  const LIST: PracticeList = {
    source: "file",
    url: "https://files.example.com/list.json",
    items: ["A", "B", "C", "D"].map((title) => ({ title, number: null, group: "G", difficulty: "easy" as const, url: null, solutionUrl: null, minutes: null })),
  };
  const practiceArm = (sources: { slug: string; title: string; items: number | null; format?: string; why?: string }[]): ResearchArm => async () => ({
    candidates: sources.map((s) => ({
      url: practiceUrl(s.slug),
      title: s.title,
      kind: "course" as const,
      why: s.why ?? "Problems with solutions",
      recommendedBy: [],
      practice: { format: s.format ?? "problem-set", items: s.items, answers: true },
    })),
    learnerNotes: [],
    seenUrls: new Set(),
    counts: { steps: 1, searches: 0, fetches: 0 },
    searchesOk: 1,
    stoppedBy: "model",
    costUsd: 0,
    coverage: null,
  });
  const fetcherOf = (titles: Record<string, string>) => fetcherFor(Object.fromEntries(Object.entries(titles).map(([slug, title]) => [practiceUrl(slug), page(practiceUrl(slug), title)]))).fetcher;
  const byTitle = (materials: Material[], title: string) => materials.find((m) => m.title === title)!;

  it("keeps working by count when no list is found", async () => {
    const arm = practiceArm([{ slug: "p", title: "Problem Set", items: 150 }]);
    const fetcher = fetcherOf({ p: "Problem Set" });
    const bare = await collect(researchMaterials({ brief, arm, fetcher, books }));
    const finder = { find: vi.fn(async () => ({ list: null, counts: { searches: 2, fetches: 3 }, costUsd: 0.01 })) };
    const { events, outcome } = await collect(researchMaterials({ brief, arm, fetcher, books, items: finder }));
    expect(finder.find).toHaveBeenCalledTimes(1);
    expect(byTitle(outcome.materials, "Problem Set")).toEqual(byTitle(bare.outcome.materials, "Problem Set"));
    expect(events.find((e) => e.type === "research.items")).toMatchObject({ title: "Problem Set", items: 0, groups: 0 });
    expect(outcome.costUsd).toBeCloseTo(0.01);
    const done = events.find((e) => e.type === "research.done") as Extract<ResearchEvent, { type: "research.done" }>;
    expect(done.counts).toEqual({ searches: 2, fetches: 3 });
  });

  it("sets the list and its count on the source, and the count when research gave none", async () => {
    const arm = practiceArm([
      { slug: "a", title: "Counted Set", items: 150 },
      { slug: "b", title: "Uncounted List", items: null, why: "A list of problems with solutions" },
    ]);
    const finder = { find: vi.fn(async () => ({ list: LIST, counts: { searches: 1, fetches: 1 }, costUsd: 0 })) };
    const { events, outcome } = await collect(researchMaterials({ brief, arm, fetcher: fetcherOf({ a: "Counted Set", b: "Uncounted List" }), books, items: finder }));
    const counted = byTitle(outcome.materials, "Counted Set").practice!;
    expect(counted).toMatchObject({ items: 150, totalItems: 4, list: LIST });
    const uncounted = byTitle(outcome.materials, "Uncounted List").practice!;
    // The count comes from the list; doing time is the allocation's to set from the items it keeps.
    expect(uncounted).toMatchObject({ items: 4, totalItems: 4, list: LIST, minutes: null });
    expect(events.find((e) => e.type === "research.items")).toMatchObject({ items: 4, groups: 1, url: LIST.url });
  });

  it("runs for at most three practice sources, in parallel", async () => {
    const arm = practiceArm([
      { slug: "small", title: "Small Set", items: 10 },
      { slug: "big", title: "Big Set", items: 300 },
      { slug: "mid", title: "Mid Set", items: 100 },
      { slug: "large", title: "Large Set", items: 200 },
      // Not counted by item, and not a list: never looked for.
      { slug: "mock", title: "Mock Interview", items: null, format: "mock", why: "A full mock interview" },
    ]);
    const fetcher = fetcherOf({ small: "Small Set", big: "Big Set", mid: "Mid Set", large: "Large Set", mock: "Mock Interview" });
    let inFlight = 0;
    let most = 0;
    const finder = {
      find: vi.fn(async (source: Material) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { list: source.title === "Big Set" ? LIST : null, counts: { searches: 1, fetches: 1 }, costUsd: 0.01 };
      }),
    };
    const { events, outcome } = await collect(researchMaterials({ brief, arm, fetcher, books, items: finder }));
    expect(finder.find.mock.calls.map(([s]) => s.title)).toEqual(["Big Set", "Large Set", "Mid Set"]);
    expect(most).toBe(3);
    expect(events.filter((e) => e.type === "research.items")).toHaveLength(3);
    expect(byTitle(outcome.materials, "Big Set").practice!.list).toEqual(LIST);
    expect(byTitle(outcome.materials, "Small Set").practice!.list ?? null).toBeNull();
    expect(outcome.costUsd).toBeCloseTo(0.03);
  });

  it("runs beside the chapter finder, not after it", async () => {
    const both: ResearchArm = async (input) => {
      const books = await arm(input);
      const practice = await practiceArm([{ slug: "p", title: "Problem Set", items: 150 }])(input);
      return { ...books, candidates: [...books.candidates, ...practice.candidates] };
    };
    const fetcher = fetcherFor({ [bookUrl]: page(bookUrl, "Core Textbook"), [practiceUrl("p")]: page(practiceUrl("p"), "Problem Set") }).fetcher;
    let inFlight = 0;
    let most = 0;
    const slow = async <T,>(value: T) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return value;
    };
    const chapters = { find: vi.fn(() => slow({ toc: null, counts: { searches: 0, fetches: 0 }, costUsd: 0 })) };
    const items = { find: vi.fn(() => slow({ list: null, counts: { searches: 0, fetches: 0 }, costUsd: 0 })) };
    await collect(researchMaterials({ brief, arm: both, fetcher, books, chapters, items }));
    expect(chapters.find).toHaveBeenCalledTimes(1);
    expect(items.find).toHaveBeenCalledTimes(1);
    expect(most).toBe(2);
  });

  it("swallows an item finder error on the app's key and rethrows a provider refusal on the user's", async () => {
    const arm = practiceArm([{ slug: "p", title: "Problem Set", items: 150 }]);
    const fetcher = fetcherOf({ p: "Problem Set" });
    const boom = { find: vi.fn(async () => Promise.reject(new Error("boom"))) };
    const { outcome } = await collect(researchMaterials({ brief, arm, fetcher, books, items: boom }));
    expect(byTitle(outcome.materials, "Problem Set").practice!.list ?? null).toBeNull();
    const refusal = {
      find: vi.fn(async () =>
        Promise.reject(new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false })),
      ),
    };
    await expect(collect(researchMaterials({ brief, arm, fetcher, books, items: refusal, log: { keyOwner: "user" } }))).rejects.toSatisfy(
      (e: unknown) => providerError(e)?.statusCode === 400,
    );
  });

  it("gives no item list to a source with a chapter list, found beside it or already there", async () => {
    // A book that is both a likely backbone and a problem set: its suffixes are chapters, so it stays unlisted.
    const dual: ResearchArm = async (input) => {
      const out = await arm(input);
      return { ...out, candidates: out.candidates.map((c) => ({ ...c, practice: { format: "problem-set" as const, items: 189, answers: true } })) };
    };
    const chapters = { find: vi.fn(async () => ({ toc: TOC, counts: { searches: 0, fetches: 0 }, costUsd: 0 })) };
    const items = { find: vi.fn(async () => ({ list: LIST, counts: { searches: 0, fetches: 0 }, costUsd: 0 })) };
    const { outcome } = await collect(researchMaterials({ brief, arm: dual, fetcher, books, chapters, items }));
    const book = core(outcome.materials);
    expect(book.toc).toEqual(TOC);
    expect(book.practice).toMatchObject({ format: "problem-set", items: 189 });
    expect(book.practice!.list ?? null).toBeNull();
    // Its aliases stay chapters.
    const aliases = aliasMaterials([book]);
    expect(aliases.resolve("M1.3")).toEqual({ id: book.id, chapter: 3 });
    expect(aliases.items(book.id)).toBe(0);
    // A source that already has its chapters is never looked for.
    const withToc = { ...book, toc: TOC, practice: { ...book.practice!, list: undefined } };
    expect(likelyItemLists([withToc])).toEqual([]);
    expect(likelyItemLists([{ ...withToc, toc: undefined }])).toHaveLength(1);
  });

  it("defaultItemFinder is null without a search key", () => {
    expect(defaultItemFinder({})).toBeNull();
    expect(defaultItemFinder({ TAVILY_API_KEY: "k" })).not.toBeNull();
  });
});
