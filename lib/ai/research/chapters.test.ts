import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS } from "@/lib/schemas/material";
import { parseOpenLibraryToc, withChapterSizes, type OpenLibraryTocEntry } from "./chapters";
import { createOpenLibraryLookup } from "./verify";

const ed = { url: "https://openlibrary.org/books/OL54058212M", numberOfPages: 350 };
const labelShape: OpenLibraryTocEntry[] = [
  { level: 1, label: "Preface", title: "10" },
  { level: 2, label: "What This Book Is About", title: "12" },
  { level: 1, label: "1. Introduction to Building AI Applications with Foundation Models", title: "34" },
  { level: 2, label: "The Rise of AI Engineering", title: "36" },
  { level: 3, label: "From Language Models to Large Language Models", title: "36" },
  { level: 1, label: "2. Understanding Foundation Models", title: "130" },
  { level: 2, label: "Training Data", title: "132" },
  { level: 2, label: "Modeling", title: "148" },
  { level: 2, label: "Summary", title: "248" },
  { level: 1, label: "3. Evaluation Methodology", title: "256" },
  { level: 1, label: "Epilogue", title: "1027" },
  { level: 1, label: "Index", title: "1029" },
];

describe("parseOpenLibraryToc", () => {
  it("reads the label/title shape: heading in label, position in title, matter dropped and bounding", () => {
    const toc = parseOpenLibraryToc(labelShape, ed)!;
    expect(toc.chapters.map((c) => [c.n, c.title, c.page])).toEqual([
      [1, "Introduction to Building AI Applications with Foundation Models", 34],
      [2, "Understanding Foundation Models", 130],
      [3, "Evaluation Methodology", 256],
    ]);
    expect(toc.chapters[1].sections).toEqual(["Training Data", "Modeling"]);
    expect(toc.chapters[0].sections).toEqual(["The Rise of AI Engineering"]);
    expect(toc).toMatchObject({ source: "catalogue", url: ed.url, end: 1027, printPages: false });
    expect(toc.chapters.every((c) => c.minutes === null)).toBe(true);
  });
  it("reads the pagenum shape and the title-only shape", () => {
    const a = parseOpenLibraryToc(
      [{ level: 1, label: "Chapter 1", title: "Alpha", pagenum: "5" }, { level: 1, label: "2", title: "Beta", pagenum: 20 }, { level: 1, label: "Chapter 3 Gamma", pagenum: "40" }],
      { url: "u", numberOfPages: 60 },
    )!;
    expect(a.chapters.map((c) => [c.n, c.title, c.page])).toEqual([[1, "Alpha", 5], [2, "Beta", 20], [3, "Gamma", 40]]);
    expect(a).toMatchObject({ end: 60, printPages: true });
    const b = parseOpenLibraryToc([{ level: 1, title: "Alpha", pagenum: 1 }, { level: 1, title: "Beta", pagenum: 9 }, { level: 1, title: "Gamma", pagenum: 30 }], { url: "u", numberOfPages: null })!;
    expect(b.chapters.map((c) => [c.n, c.title])).toEqual([[null, "Alpha"], [null, "Beta"], [null, "Gamma"]]);
    expect(b).toMatchObject({ end: null, printPages: false });
  });
  it("reads string entries split on |, with leading asterisks as depth", () => {
    const toc = parseOpenLibraryToc(["1. One | 3", "* Inside one | 4", "2. Two | 10", "3. Three | 20"], { url: "u", numberOfPages: 30 })!;
    expect(toc.chapters.map((c) => [c.n, c.title, c.page, c.sections])).toEqual([[1, "One", 3, ["Inside one"]], [2, "Two", 10, []], [3, "Three", 20, []]]);
  });
  it("shifts levels when the top level is parts", () => {
    const toc = parseOpenLibraryToc(
      [
        { level: 1, label: "Part I. Basics", title: "1" },
        { level: 2, label: "1. One", title: "3" },
        { level: 3, label: "Deep", title: "4" },
        { level: 2, label: "2. Two", title: "10" },
        { level: 1, label: "Part II. More", title: "19" },
        { level: 2, label: "3. Three", title: "20" },
      ],
      { url: "u", numberOfPages: 30 },
    )!;
    expect(toc.chapters.map((c) => [c.n, c.title, c.sections])).toEqual([[1, "One", ["Deep"]], [2, "Two", []], [3, "Three", []]]);
  });
  it("drops positions when a chapter lacks one or they do not increase", () => {
    const missing = parseOpenLibraryToc([{ level: 1, label: "1. A", title: "3" }, { level: 1, label: "2. B" }, { level: 1, label: "3. C", title: "9" }], { url: "u", numberOfPages: 20 })!;
    expect(missing.chapters.map((c) => c.page)).toEqual([null, null, null]);
    expect(missing).toMatchObject({ end: null, printPages: false });
    const backwards = parseOpenLibraryToc([{ level: 1, label: "1. A", title: "30" }, { level: 1, label: "2. B", title: "20" }, { level: 1, label: "3. C", title: "40" }], { url: "u", numberOfPages: 50 })!;
    expect(backwards.chapters.map((c) => c.page)).toEqual([null, null, null]);
  });
  it("is null below three chapters", () => {
    expect(parseOpenLibraryToc([{ level: 1, label: "1. A", title: "1" }, { level: 1, label: "2. B", title: "9" }], ed)).toBeNull();
    expect(parseOpenLibraryToc([], ed)).toBeNull();
  });
  it("applies the caps", () => {
    const entries: OpenLibraryTocEntry[] = [];
    for (let i = 1; i <= MAX_CHAPTERS + 5; i++) {
      entries.push({ level: 1, label: `${i}. ${"T".repeat(MAX_HEADING + 10)}`, title: String(i * 10) });
      for (let s = 0; s < MAX_SECTIONS + 3; s++) entries.push({ level: 2, label: `Section ${s}`, title: String(i * 10 + 1) });
    }
    const toc = parseOpenLibraryToc(entries, { url: "u", numberOfPages: 1000 })!;
    expect(toc.chapters).toHaveLength(MAX_CHAPTERS);
    expect(toc.chapters[0].title).toHaveLength(MAX_HEADING);
    expect(toc.chapters[0].sections).toHaveLength(MAX_SECTIONS);
  });
});

describe("withChapterSizes", () => {
  const base = parseOpenLibraryToc(
    [{ level: 1, label: "1. A", title: "10" }, { level: 1, label: "2. B", title: "30" }, { level: 1, label: "3. C", title: "70" }, { level: 1, label: "Index", title: "100" }],
    { url: "u", numberOfPages: 100 },
  )!;
  it("shares the book's minutes by span, the last chapter bounded by end", () => {
    expect(withChapterSizes(base, 900).chapters.map((c) => c.minutes)).toEqual([200, 400, 300]);
  });
  it("gives an unbounded last chapter the mean span of the others", () => {
    expect(withChapterSizes({ ...base, end: null }, 900).chapters.map((c) => c.minutes)).toEqual([200, 400, 300]);
  });
  it("leaves minutes null without a book size or positions", () => {
    expect(withChapterSizes(base, null).chapters.map((c) => c.minutes)).toEqual([null, null, null]);
    const noPos = { ...base, end: null, chapters: base.chapters.map((c) => ({ ...c, page: null })) };
    expect(withChapterSizes(noPos, 900).chapters.map((c) => c.minutes)).toEqual([null, null, null]);
  });
});

interface Edition {
  key: string;
  title: string;
  number_of_pages?: number;
  languages: { key: string }[];
  table_of_contents: OpenLibraryTocEntry[];
}
function edition(key: string): Edition {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/openlibrary/${key}.json`, import.meta.url), "utf8")) as Edition;
}
function parseEdition(key: string) {
  const e = edition(key);
  return parseOpenLibraryToc(e.table_of_contents, { url: `https://openlibrary.org/books/${key}`, numberOfPages: e.number_of_pages ?? null });
}

describe("real Open Library records", () => {
  it("Clean Code: 'Chapter N' labels, headings in title, 0-based levels; front matter and appendices set aside", () => {
    const toc = parseEdition("OL26222911M")!;
    expect(toc.chapters.map((c) => c.n)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(toc.chapters[0]).toMatchObject({
      title: "Clean Code",
      page: 1,
      sections: ["There Will Be Code", "Bad Code", "The Total Cost of Owning a Mess", "Schools of Thought", "We Are Authors", "The Boy Scout Rule", "Prequel and Principles"],
    });
    expect(toc.chapters[16]).toMatchObject({ n: 17, title: "Smells and Heuristics", page: 285 });
    expect(toc).toMatchObject({ end: 317, printPages: true });
  });
  it("The Pragmatic Programmer: bare-number labels, numbered sections, roman-numbered front matter", () => {
    const toc = parseEdition("OL7408140M")!;
    expect(toc.chapters.map((c) => [c.n, c.title, c.page])).toEqual([
      [1, "A Pragmatic Philosophy", 1],
      [2, "A Pragmatic Approach", 25],
      [3, "The Basic Tools", 71],
      [4, "Pragmatic Paranoia", 107],
      [5, "Bend, or Break", 137],
      [6, "While You Are Coding", 171],
      [7, "Before the Project", 201],
      [8, "Pragmatic Projects", 223],
    ]);
    expect(toc.chapters[0].sections).toEqual(["The Cat Ate My Source Code", "Software Entropy", "Stone Soup and Boiled Frogs", "Good-Enough Software", "Your Knowledge Portfolio", "Communicate!"]);
    expect(toc).toMatchObject({ end: 309, printPages: true });
  });
  it("SICP in English: a flat list whose depth lives in dotted labels, with no positions", () => {
    const toc = parseEdition("OL980232M")!;
    expect(toc.chapters.map((c) => [c.n, c.title])).toEqual([
      [1, "Building Abstractions with Procedures"],
      [2, "Building Abstractions with Data"],
      [3, "Modularity, Objects, and State"],
      [4, "Metalinguistic Abstraction"],
      [5, "Computing with Register Machines"],
    ]);
    expect(toc.chapters[0].sections).toEqual(["The Elements of Programming", "Procedures and the Processes They Create", "Formulating Abstractions with Higher-Order Procedures"]);
    expect(toc.chapters.every((c) => c.page === null)).toBe(true);
    expect(toc).toMatchObject({ end: null, printPages: false });
  });
  it("SICP in Chinese: chapter numbers in 第N章 headings, depth in dotted headings", () => {
    const toc = parseEdition("OL49238817M")!;
    expect(toc.chapters.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
    expect(toc.chapters[1].sections[0]).toBe("数据抽象导引55");
  });
  it("Introduction to Algorithms: parts only, no chapters, so null", () => {
    expect(parseEdition("OL25409352M")).toBeNull();
  });
  it("AI Engineering: the heading-in-label shape still parses", () => {
    const toc = parseEdition("OL54058212M")!;
    expect(toc.chapters).toHaveLength(10);
    expect(toc.chapters[4]).toMatchObject({ n: 5, title: "Prompt Engineering", page: 453 });
    expect(toc.chapters[4].sections).toEqual(["Introduction to Prompting", "Prompt Engineering Best Practices", "Defensive Prompt Engineering"]);
    expect(toc).toMatchObject({ end: 1027, printPages: false });
  });
});

describe("the sanity gate", () => {
  const ed = { url: "u", numberOfPages: 100 };
  it("rejects chapter numbers out of order", () => {
    expect(parseOpenLibraryToc([{ level: 0, label: "2", title: "B", pagenum: "1" }, { level: 0, label: "1", title: "A", pagenum: "9" }, { level: 0, label: "3", title: "C", pagenum: "20" }], ed)).toBeNull();
  });
  it("rejects a list with fewer than three numbered chapters among unnumbered entries", () => {
    expect(
      parseOpenLibraryToc(
        [{ level: 0, title: "Foo", pagenum: "1" }, { level: 0, label: "1", title: "A", pagenum: "5" }, { level: 0, title: "Bar", pagenum: "9" }, { level: 0, label: "2", title: "B", pagenum: "20" }, { level: 0, title: "Baz", pagenum: "30" }],
        ed,
      ),
    ).toBeNull();
  });
  it("drops unnumbered entries from a numbered list and lets the first one after the last chapter bound it", () => {
    const toc = parseOpenLibraryToc(
      [{ level: 0, title: "Intro", pagenum: "1" }, { level: 0, label: "1", title: "A", pagenum: "5" }, { level: 0, label: "2", title: "B", pagenum: "9" }, { level: 0, label: "3", title: "C", pagenum: "20" }, { level: 0, title: "Odds and ends", pagenum: "40" }],
      ed,
    )!;
    expect(toc.chapters.map((c) => c.title)).toEqual(["A", "B", "C"]);
    expect(toc.end).toBe(40);
  });
});

describe("Open Library chapters", () => {
  const match = { key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024, pages: 350 };
  const editions = {
    entries: [
      { key: "/books/OL2M", number_of_pages: 534 },
      {
        key: "/books/OL1M",
        number_of_pages: 350,
        table_of_contents: [
          { level: 1, label: "1. A", title: "10" },
          { level: 1, label: "2. B", title: "30" },
          { level: 1, label: "3. C", title: "70" },
          { level: 1, label: "Index", title: "100" },
        ],
      },
      { key: "/books/OL3M", number_of_pages: 300, table_of_contents: [{ level: 1, label: "1. A", title: "1" }, { level: 1, label: "2. B", title: "9" }] },
    ],
  };
  const fetchJson = (body: unknown, ok = true) => vi.fn<typeof fetch>(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response);

  it("fetches the work's editions and returns the longest usable list", async () => {
    const fetchImpl = fetchJson(editions);
    const toc = await createOpenLibraryLookup(fetchImpl).chapters!(match);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://openlibrary.org/works/OL1W/editions.json?limit=50");
    expect(toc).toMatchObject({ source: "catalogue", url: "https://openlibrary.org/books/OL1M", end: 100, printPages: true });
    expect(toc!.chapters.map((c) => c.title)).toEqual(["A", "B", "C"]);
  });
  it("prefers an edition whose title matches the work over a longer translated one", async () => {
    const chi = edition("OL49238817M");
    const eng = edition("OL980232M");
    const body = { entries: [chi, eng].map((e) => ({ key: e.key, title: e.title, number_of_pages: e.number_of_pages, languages: e.languages, table_of_contents: e.table_of_contents })) };
    const sicp = { key: "/works/OL3267304W", title: "Structure and Interpretation of Computer Programs", authors: ["Harold Abelson"], year: 1985, pages: 657 };
    const toc = await createOpenLibraryLookup(fetchJson(body)).chapters!(sicp);
    expect(toc?.url).toBe("https://openlibrary.org/books/OL980232M");
    expect(toc?.chapters[0].title).toBe("Building Abstractions with Procedures");
  });
  it("is null without a work key, on a failed request, and when no edition has a usable list", async () => {
    expect(await createOpenLibraryLookup(fetchJson(editions)).chapters!({ ...match, key: null })).toBeNull();
    expect(await createOpenLibraryLookup(fetchJson({}, false)).chapters!(match)).toBeNull();
    expect(
      await createOpenLibraryLookup(
        vi.fn<typeof fetch>(async () => {
          throw new Error("down");
        }),
      ).chapters!(match),
    ).toBeNull();
    expect(await createOpenLibraryLookup(fetchJson({ entries: [editions.entries[0]] })).chapters!(match)).toBeNull();
  });
});
