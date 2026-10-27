import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import { clip, type ChapterList, type Material, type MaterialPractice, type PracticeList } from "@/lib/schemas/material";
import { providerError } from "../providerError";
import type { ResearchArm } from "./agent";
import type { ResearchEvent } from "./events";
import type { PageInfo } from "./extract";
import { MAX_STRUCTURE_FINDERS, STRUCTURE_MIN_MINUTES, defaultStructureFinder, likelyStructures, researchMaterials, structureRole } from "./pipeline";
import type { StructureFinder, StructureResult } from "./structureFinder";
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

type Outcome = Awaited<ReturnType<typeof researchMaterials>> extends AsyncGenerator<unknown, infer R> ? R : never;

async function collect(gen: AsyncGenerator<ResearchEvent, unknown>, events: ResearchEvent[] = []) {
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, outcome: next.value as Outcome };
}

const TOC: ChapterList = {
  source: "page",
  url: "https://docs.example.com/guide",
  printPages: false,
  end: null,
  chapters: [
    { n: 1, title: "A", page: null, minutes: 40, sections: [] },
    { n: 2, title: "B", page: null, minutes: 50, sections: [] },
    { n: 3, title: "C", page: null, minutes: 60, sections: [] },
  ],
};

const LIST: PracticeList = {
  source: "file",
  url: "https://files.example.com/list.json",
  items: ["A", "B", "C", "D"].map((title) => ({ title, number: null, group: "G", difficulty: "easy" as const, url: null, solutionUrl: null, minutes: null })),
};

/** A finder's result with nothing found; `over` sets what it found. */
function result(over: Partial<StructureResult> = {}): StructureResult {
  return { toc: null, minutes: null, basis: null, list: null, refused: null, facts: [], note: null, units: 0, counts: { searches: 0, fetches: 0 }, costUsd: 0, ...over };
}

function finderOf(find: StructureFinder["find"]) {
  return { find: vi.fn(find) };
}

function practice(over: Partial<MaterialPractice> = {}): MaterialPractice {
  return { format: "problem-set", items: 150, perItemMinutes: null, minutes: 600, answers: true, ...over };
}

let ids = 0;
function mat(over: Partial<Material> = {}): Material {
  ids += 1;
  return {
    id: `M${ids}`,
    origin: "research",
    type: "link",
    kind: "docs",
    url: `https://site${ids}.example.com/`,
    title: `Material ${ids}`,
    author: null,
    year: null,
    why: null,
    backbone: false,
    verifiedAt: "2026-10-27T00:00:00.000Z",
    fetchedTitle: null,
    recommendedBy: [],
    sig: null,
    ...over,
  };
}

describe("likelyStructures", () => {
  it("puts the learner's own first, then books by recommending sites, practice by time, the rest by size, and stops at the cap", () => {
    const site = (n: number) => `https://reviews${n}.org/books`;
    const learner = mat({ id: "L", origin: "learner", kind: "repo", url: "https://github.com/me/notes", hub: true, verifiedAt: null });
    const book1 = mat({ id: "B1", kind: "book", recommendedBy: [site(1)] });
    const book3 = mat({ id: "B3", kind: "book", recommendedBy: [site(1), site(2), site(3)] });
    const p300 = mat({ id: "P300", kind: "course", practice: practice({ minutes: 300 }) });
    const p600 = mat({ id: "P600", kind: "course", practice: practice({ minutes: 600 }) });
    const d100 = mat({ id: "D100", minutes: 100 });
    const d400 = mat({ id: "D400", minutes: 120, pageMinutes: 400 });
    const d200 = mat({ id: "D200", pageMinutes: 200 });
    const picked = likelyStructures([d100, p300, book1, d400, learner, p600, book3, d200]);
    expect(MAX_STRUCTURE_FINDERS).toBe(6);
    expect(picked.map((m) => m.id)).toEqual(["L", "B3", "B1", "P600", "P300", "D400"]);
  });

  it("never picks a short essay that is not a hub, and picks one at the size bar", () => {
    expect(STRUCTURE_MIN_MINUTES).toBe(90);
    expect(likelyStructures([mat({ kind: "essay", minutes: 40, pageMinutes: 40 })])).toEqual([]);
    expect(likelyStructures([mat({ origin: "learner", kind: "essay", minutes: 40 })])).toEqual([]);
    expect(likelyStructures([mat({ kind: "essay", minutes: 40, pageMinutes: 90 })])).toHaveLength(1);
    expect(likelyStructures([mat({ kind: "essay", minutes: 40, hub: true })])).toHaveLength(1);
  });

  it("picks a practice source that already has chapters, and never one with a list, an unverified one or one not counted by item", () => {
    expect(likelyStructures([mat({ kind: "course", toc: TOC, practice: practice() })])).toHaveLength(1);
    expect(likelyStructures([mat({ kind: "course", practice: practice({ list: LIST }) })])).toEqual([]);
    expect(likelyStructures([mat({ kind: "course", verifiedAt: null, practice: practice() })])).toEqual([]);
    expect(likelyStructures([mat({ kind: "course", practice: practice({ format: "mock", items: null }), why: "A full mock interview" })])).toEqual([]);
    // No count, but its description reads like a list.
    expect(likelyStructures([mat({ kind: "course", practice: practice({ items: null }), why: "A list of problems with solutions" })])).toHaveLength(1);
    expect(likelyStructures([mat({ kind: "course", practice: practice({ items: null }), why: "Hands-on practice" })])).toEqual([]);
  });

  it("needs an https address and a type that is not a note or a file, and skips a book that has its chapters", () => {
    expect(likelyStructures([mat({ kind: "book", url: "http://books.example.com/x" })])).toEqual([]);
    expect(likelyStructures([mat({ kind: "book", type: "note", url: "note:1" })])).toEqual([]);
    expect(likelyStructures([mat({ kind: "docs", type: "file", url: "https://files.example.com/a.pdf", minutes: 300 })])).toEqual([]);
    expect(likelyStructures([mat({ kind: "book", toc: { ...TOC, source: "catalogue" } })])).toEqual([]);
    expect(likelyStructures([mat({ kind: "book" })])).toHaveLength(1);
  });
});

describe("structureRole", () => {
  it("is practice for a practice-only source, both for reading with practice, read otherwise", () => {
    expect(structureRole(mat({ minutes: null, practice: practice() }))).toBe("practice");
    expect(structureRole(mat({ minutes: 120, practice: practice() }))).toBe("both");
    expect(structureRole(mat({ minutes: 120 }))).toBe("read");
    expect(structureRole(mat({ minutes: null }))).toBe("read");
  });
  it("is practice for reading with practice that already has its chapters: the finder's reading units would be dropped", () => {
    expect(structureRole(mat({ kind: "book", minutes: 600, toc: { ...TOC, source: "catalogue" }, practice: practice() }))).toBe("practice");
  });
});

describe("the structure stage", () => {
  // The gate stamps each material with when it was read: a frozen clock lets a run be compared with the gate's alone.
  const NOW = new Date("2026-10-27T12:00:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const site = (n: number) => `https://reviews${n}.org/books`;
  const coreUrl = "https://books.example.com/core";
  const secondUrl = "https://books.example.com/second";
  const docsUrl = "https://docs.example.com/";
  const practiceUrl = "https://practice.example.com/set";
  const CATALOGUE_TOC: ChapterList = {
    source: "catalogue",
    url: "https://openlibrary.org/books/OL1M",
    printPages: true,
    end: 100,
    chapters: TOC.chapters.map((c, i) => ({ ...c, minutes: null, page: (i + 1) * 10 })),
  };
  const arm: ResearchArm = async () => ({
    candidates: [
      { url: coreUrl, title: "Core Textbook", kind: "book", author: "A. Author", why: "The standard text", recommendedBy: [site(1), site(2)] },
      { url: secondUrl, title: "Second Book", kind: "book", author: "B. Author", why: "Another text", recommendedBy: [site(1)] },
      { url: docsUrl, title: "Big Docs", kind: "docs", why: "The official guide", recommendedBy: [], minutes: 300 },
      { url: practiceUrl, title: "Problem Set", kind: "course", why: "Problems with solutions", recommendedBy: [], practice: { format: "problem-set", items: 150, answers: true } },
    ],
    learnerNotes: [],
    seenUrls: new Set([site(1), site(2)]),
    counts: { steps: 1, searches: 3, fetches: 4 },
    searchesOk: 1,
    stoppedBy: "model",
    costUsd: 0.1,
    coverage: null,
  });
  const books: BookLookup = {
    find: async (title) => ({ key: title === "Core Textbook" ? "/works/CORE" : "/works/SECOND", title, authors: ["A. Author"], year: 2023, pages: 400 }),
    chapters: async (match) => (match.key === "/works/CORE" ? CATALOGUE_TOC : null),
  };
  const fetcher = () =>
    fetcherFor({
      [coreUrl]: page(coreUrl, "Core Textbook"),
      [secondUrl]: page(secondUrl, "Second Book"),
      [docsUrl]: page(docsUrl, "Big Docs"),
      [practiceUrl]: page(practiceUrl, "Problem Set"),
    }).fetcher;
  const byTitle = (materials: Material[], title: string) => materials.find((m) => m.title === title)!;
  const structureEvents = (events: ResearchEvent[]) => events.filter((e): e is Extract<ResearchEvent, { type: "research.structure" }> => e.type === "research.structure");
  /** What the gate alone leaves: research with no structure finder. */
  const gateOnly = async () => (await collect(researchMaterials({ brief: { topic: "T", weeks: 4, sources: [] }, arm, fetcher: fetcher(), books }))).outcome.materials;
  const run = (structure: StructureFinder, more: Partial<Parameters<typeof researchMaterials>[0]> = {}, events: ResearchEvent[] = []) =>
    collect(researchMaterials({ brief: { topic: "T", weeks: 4, sources: [] }, arm, fetcher: fetcher(), books, structure, ...more }), events);

  it("merges what a finder found, leaves a source whose finder threw exactly as the gate left it, and keeps a catalogue toc", async () => {
    const gate = await gateOnly();
    const note = "Organised as a guide in three parts. ".repeat(12);
    const finder = finderOf(async (m) => {
      if (m.title === "Big Docs") return result({ toc: TOC, minutes: 150, basis: "measured", note, units: 3, counts: { searches: 0, fetches: 4 }, costUsd: 0.03 });
      if (m.title === "Problem Set") return result({ list: LIST, note: "A problem list.", counts: { searches: 1, fetches: 2 }, costUsd: 0.02 });
      throw new Error("boom");
    });
    const { events, outcome } = await run(finder);

    expect(finder.find.mock.calls.map(([m, role]) => [m.title, role]).sort()).toEqual([
      ["Big Docs", "read"],
      ["Problem Set", "practice"],
      ["Second Book", "read"],
    ]);
    const docs = byTitle(outcome.materials, "Big Docs");
    expect(docs).toEqual({ ...byTitle(gate, "Big Docs"), toc: TOC, minutes: 150, minutesBasis: "measured", note: clip(note, 300) });
    expect(docs.note!.length).toBeLessThanOrEqual(300);
    const set = byTitle(outcome.materials, "Problem Set");
    expect(set.practice).toMatchObject({ items: 150, totalItems: 4, list: LIST });
    expect(set.note).toBe("A problem list.");
    // Review Focus 2: a failed finder erases nothing, and a catalogued book keeps its catalogue chapters.
    expect(byTitle(outcome.materials, "Second Book")).toEqual(byTitle(gate, "Second Book"));
    expect(byTitle(outcome.materials, "Core Textbook").toc).toMatchObject({ source: "catalogue", url: CATALOGUE_TOC.url });
    expect(byTitle(outcome.materials, "Core Textbook")).toEqual(byTitle(gate, "Core Textbook"));

    expect(outcome.costUsd).toBeCloseTo(0.15);
    const done = events.find((e) => e.type === "research.done") as Extract<ResearchEvent, { type: "research.done" }>;
    expect(done.counts).toEqual({ searches: 4, fetches: 10 });
    expect(byTitle(done.materials, "Big Docs").toc).toEqual(TOC);
    const structure = structureEvents(events);
    expect(structure).toHaveLength(3);
    expect(structure.find((e) => e.title === "Big Docs")).toEqual({ type: "research.structure", id: docs.id, title: "Big Docs", units: 3, items: 0, url: TOC.url });
    expect(structure.find((e) => e.title === "Problem Set")).toEqual({ type: "research.structure", id: set.id, title: "Problem Set", units: 0, items: 4, url: LIST.url });
    expect(structure.find((e) => e.title === "Second Book")).toMatchObject({ units: 0, items: 0 });
    expect(structure.find((e) => e.title === "Second Book")).not.toHaveProperty("url");
    // The gate's catalogue list still announces itself.
    expect(events.filter((e) => e.type === "research.chapters")).toHaveLength(1);
  });

  it("leaves a source exactly as it was when its units were refused, and says why", async () => {
    const gate = await gateOnly();
    const refused = "units refused: 4 of 22 titles not on the page";
    const finder = finderOf(async (m) => (m.title === "Big Docs" ? result({ refused, note: "A guide.", counts: { searches: 0, fetches: 3 }, costUsd: 0.01 }) : result()));
    const { events, outcome } = await run(finder);
    expect(byTitle(outcome.materials, "Big Docs")).toEqual(byTitle(gate, "Big Docs"));
    expect(outcome.costUsd).toBeCloseTo(0.11);
    expect(structureEvents(events).find((e) => e.title === "Big Docs")).toMatchObject({ units: 0, items: 0, refused });
  });

  it("runs every finder at once", async () => {
    let inFlight = 0;
    let most = 0;
    const finder = finderOf(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return result();
    });
    await run(finder);
    expect(finder.find).toHaveBeenCalledTimes(3);
    expect(most).toBe(3);
  });

  it("never replaces a chapter list the material already has, and still merges its list and note", async () => {
    // A catalogued book to read that is also a counted problem set: picked for its item list, though it has its chapters.
    const dual: ResearchArm = async (input) => {
      const out = await arm(input);
      return { ...out, candidates: out.candidates.map((c) => (c.title === "Core Textbook" ? { ...c, minutes: 600, practice: { format: "problem-set" as const, items: 189, answers: true } } : c)) };
    };
    const gate = (await collect(researchMaterials({ brief: { topic: "T", weeks: 4, sources: [] }, arm: dual, fetcher: fetcher(), books }))).outcome.materials;
    const finder = finderOf(async (m) => (m.title === "Core Textbook" ? result({ toc: TOC, minutes: 150, basis: "measured", list: LIST, note: "Chapters with exercises.", units: 3 }) : result()));
    const { events, outcome } = await collect(researchMaterials({ brief: { topic: "T", weeks: 4, sources: [] }, arm: dual, fetcher: fetcher(), books, structure: finder }));
    // Its chapters are kept, so its finder looks for practice only.
    expect(finder.find.mock.calls.filter(([m]) => m.title === "Core Textbook").map(([, role]) => role)).toEqual(["practice"]);
    const before = byTitle(gate, "Core Textbook");
    const book = byTitle(outcome.materials, "Core Textbook");
    expect(before.toc).toMatchObject({ source: "catalogue" });
    expect(book).toEqual({ ...before, practice: { ...before.practice!, list: LIST, totalItems: 4 }, note: "Chapters with exercises." });
    // The feed says what it keeps: the list, not the chapters it found.
    expect(structureEvents(events).find((e) => e.title === "Core Textbook")).toEqual({ type: "research.structure", id: book.id, title: "Core Textbook", units: 0, items: 4, url: LIST.url });
  });

  it("rethrows a provider refusal on the user's own key", async () => {
    const refusal = finderOf(async () => {
      throw new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });
    });
    await expect(run(refusal, { log: { keyOwner: "user" } })).rejects.toSatisfy((e: unknown) => providerError(e)?.statusCode === 400);
  });

  it("runs nothing without a finder", async () => {
    const { events } = await collect(researchMaterials({ brief: { topic: "T", weeks: 4, sources: [] }, arm, fetcher: fetcher(), books }));
    expect(structureEvents(events)).toEqual([]);
  });

  it("skips the stage when too little of the draft's time is left, without a word of it", async () => {
    const gate = await gateOnly();
    const finder = finderOf(async () => result({ toc: TOC, units: 3 }));
    const { events, outcome } = await run(finder, { deadline: Date.now() + 150_000 });
    expect(finder.find).not.toHaveBeenCalled();
    expect(structureEvents(events)).toEqual([]);
    expect(outcome.materials).toEqual(gate);
    expect(events.at(-1)?.type).toBe("research.done");
  });

  it("ends the stage when its time is up, keeping the finders that finished", async () => {
    const gate = await gateOnly();
    vi.useFakeTimers({ now: NOW });
    const signals: AbortSignal[] = [];
    const finder = finderOf(async (m, _role, ctx) => {
      signals.push(ctx.signal!);
      if (m.title === "Big Docs") {
        await new Promise((r) => setTimeout(r, 5_000));
        return result({ toc: TOC, units: 3, costUsd: 0.01 });
      }
      // Never settles, whatever its signal says.
      return new Promise<StructureResult>(() => {});
    });
    const events: ResearchEvent[] = [];
    const running = run(finder, { deadline: Date.now() + 170_000 }, events);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(finder.find).toHaveBeenCalledTimes(3);
    expect(structureEvents(events).map((e) => e.title)).toEqual(["Big Docs"]);
    expect(events.some((e) => e.type === "research.done")).toBe(false);
    expect(signals.some((s) => s.aborted)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const { outcome } = await running;
    expect(signals.every((s) => s.aborted)).toBe(true);
    // The finders cut off say they found nothing; the sources stay whole.
    expect(structureEvents(events).map((e) => [e.title, e.units, e.items]).sort()).toEqual([
      ["Big Docs", 3, 0],
      ["Problem Set", 0, 0],
      ["Second Book", 0, 0],
    ]);
    expect(byTitle(outcome.materials, "Big Docs").toc).toEqual(TOC);
    expect(byTitle(outcome.materials, "Second Book")).toEqual(byTitle(gate, "Second Book"));
    expect(byTitle(outcome.materials, "Problem Set")).toEqual(byTitle(gate, "Problem Set"));
    expect(outcome.costUsd).toBeCloseTo(0.11);
    expect(events.at(-1)?.type).toBe("research.done");
  });

  it("defaultStructureFinder is a finder with or without a search key", () => {
    expect(defaultStructureFinder({})).toHaveProperty("find");
    expect(defaultStructureFinder({ TAVILY_API_KEY: "k" })).toHaveProperty("find");
  });
});
