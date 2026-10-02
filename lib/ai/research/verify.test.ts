import { describe, expect, it, vi } from "vitest";
import type { PageInfo } from "./extract";
import type { ResearchEvent } from "./events";
import { signMaterial, verifyMaterialSig } from "./signature";
import { SourceFetcher, type PageFetcher } from "./tools";
import {
  BookLookupUnavailable,
  canonicalUrl,
  kindProblem,
  mainTitle,
  pickBookMatch,
  recommendingDomains,
  registrableDomain,
  reverifyMaterial,
  runGate,
  titleMatches,
  titleTokens,
  type BookLookup,
  type Candidate,
} from "./verify";

const SECRET = "test-secret";

function info(url: string, title: string | null, extra: Partial<PageInfo> = {}): PageInfo {
  return { finalUrl: url, title, ogTitle: null, h1: null, author: null, published: null, text: "", ...extra };
}

describe("title matcher", () => {
  it("tokenizes without stopwords or punctuation", () => {
    expect(titleTokens("The Art of Computer Programming, Vol. 1")).toEqual(["art", "computer", "programming", "vol", "1"]);
  });
  it("splits CJK runs into bigrams", () => {
    expect(titleTokens("深入理解")).toEqual(["深入", "入理", "理解"]);
  });
  it("matches a page title that adds a site name", () => {
    expect(titleMatches("AI Engineering", ["AI Engineering [Book] | O'Reilly"]).ok).toBe(true);
  });
  it("matches by main title when the page drops the subtitle", () => {
    expect(mainTitle("AI Engineering: Building Applications with Foundation Models")).toBe("AI Engineering");
    expect(titleMatches("AI Engineering: Building Applications with Foundation Models", [null, "AI Engineering"]).ok).toBe(true);
  });
  it("rejects a different page", () => {
    const r = titleMatches("Designing Data-Intensive Applications", ["Page not found", "Welcome to our store"]);
    expect(r.ok).toBe(false);
    expect(r.matched).toBe("Page not found");
  });
  it("needs two shared tokens for multi-word titles", () => {
    expect(titleMatches("Deep Learning Book", ["Learning to cook"]).ok).toBe(false);
  });
  it("matches unspaced Chinese titles", () => {
    expect(titleMatches("深入理解计算机系统", ["深入理解计算机系统（原书第3版）"]).ok).toBe(true);
  });
});

describe("kind rules", () => {
  it.each([
    ["video", "https://www.youtube.com/watch?v=x", null],
    ["book", "https://youtube.com/watch?v=x", "a book is unlikely on youtube.com"],
    ["repo", "https://github.com/karpathy/nanoGPT", null],
    ["course", "https://github.com/x/y", "a course is unlikely on github.com"],
    ["paper", "https://arxiv.org/abs/1706.03762", null],
    ["book", "https://arxiv.org/abs/1706.03762", "a book is unlikely on arxiv.org"],
    ["repo", "https://example.com/code", "a repo should live on a code host, not example.com"],
    ["docs", "https://docs.python.org/3/", null],
  ] as const)("%s at %s", (kind, url, problem) => {
    expect(kindProblem(kind, url)).toBe(problem);
  });
});

describe("dedupe and domains", () => {
  it("canonicalizes URLs", () => {
    expect(canonicalUrl("https://www.Example.com/a/?utm_source=x&id=2#top")).toBe("https://example.com/a?id=2");
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com");
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
  });
  it("finds registrable domains", () => {
    expect(registrableDomain("blog.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("docs.python.org")).toBe("python.org");
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
  });
  it("counts recommending domains apart from the material's own site", () => {
    expect(
      recommendingDomains("https://www.oreilly.com/library/view/ai-engineering/1", [
        "https://www.oreilly.com/radar/list",
        "https://news.ycombinator.com/item?id=1",
        "https://a.substack.com/p/books",
        "https://b.substack.com/p/more",
      ]),
    ).toEqual(["ycombinator.com", "substack.com"]);
  });
});

describe("Open Library match", () => {
  it("picks a doc whose title and author agree", () => {
    const docs = [
      { title: "Unrelated", author_name: ["X"] },
      { key: "/works/OL1W", title: "AI Engineering", author_name: ["Chip Huyen"], first_publish_year: 2024 },
    ];
    expect(pickBookMatch("AI Engineering: Building Applications", "Chip Huyen", docs)).toEqual({ key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024 });
    expect(pickBookMatch("AI Engineering", "Someone Else", docs)).toBeNull();
  });
  it("keeps only a key that is an Open Library work", () => {
    const doc = { title: "AI Engineering", author_name: ["Chip Huyen"] };
    expect(pickBookMatch("AI Engineering", null, [{ ...doc, key: "//evil.example/works/OL1W" }])?.key).toBeNull();
    expect(pickBookMatch("AI Engineering", null, [doc])?.key).toBeNull();
  });
});

describe("signature", () => {
  const fields = { url: "https://example.com/book", fetchedTitle: "Book", verifiedAt: "2026-09-28T00:00:00.000Z" };
  it("verifies what it signed", () => {
    const sig = signMaterial(fields, SECRET);
    expect(verifyMaterialSig(fields, sig, SECRET)).toBe(true);
  });
  it("rejects a changed field, a missing sig, or another secret", () => {
    const sig = signMaterial(fields, SECRET);
    expect(verifyMaterialSig({ ...fields, url: "https://example.com/other" }, sig, SECRET)).toBe(false);
    expect(verifyMaterialSig({ ...fields, fetchedTitle: "Forged" }, sig, SECRET)).toBe(false);
    expect(verifyMaterialSig(fields, null, SECRET)).toBe(false);
    expect(verifyMaterialSig(fields, sig, "other")).toBe(false);
    expect(verifyMaterialSig({ ...fields, verifiedAt: null }, sig, SECRET)).toBe(false);
  });
});

function candidate(overrides: Partial<Candidate> & { url: string; title: string }): Candidate {
  return { kind: "docs", backbone: false, why: "why", recommendedBy: [], ...overrides };
}

function gateFixture(pages: Record<string, PageInfo | Error>, books: BookLookup = { find: async () => null }) {
  const fetchPage = vi.fn<PageFetcher>(async (url) => {
    const page = pages[url];
    if (!page) throw new Error(`no page for ${url}`);
    if (page instanceof Error) throw page;
    return page;
  });
  const events: ResearchEvent[] = [];
  return { fetcher: new SourceFetcher(fetchPage, () => new Date("2026-09-28T10:00:00Z")), fetchPage, events, books, emit: (e: ResearchEvent) => void events.push(e) };
}

describe("runGate", () => {
  const book = "https://www.oreilly.com/library/view/ai-engineering/9781098166298";
  const recs = ["https://news.ycombinator.com/item?id=1", "https://eugeneyan.com/writing/books"];
  const bookLookup: BookLookup = { find: async () => ({ key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024 }) };
  const catalogue = "https://openlibrary.org/works/OL1W";
  const now = () => new Date("2026-09-28T11:00:00Z");

  it("keeps verified candidates, drops mismatches with a reason, and picks a backbone", async () => {
    const f = gateFixture(
      {
        [book]: info(book, "AI Engineering [Book]"),
        "https://docs.example.com/evals": info("https://docs.example.com/evals", "Evals guide"),
        "https://broken.example.com/": new Error("boom"),
        "https://wrong.example.com/": info("https://wrong.example.com/", "Cookie policy"),
      },
      bookLookup,
    );
    const result = await runGate({
      candidates: [
        candidate({ url: book, title: "AI Engineering", kind: "book", backbone: true, author: "Chip Huyen", recommendedBy: [...recs, "https://never-seen.example/"] }),
        candidate({ url: "https://docs.example.com/evals", title: "Evals guide" }),
        candidate({ url: "https://broken.example.com/", title: "Broken" }),
        candidate({ url: "https://wrong.example.com/", title: "Prompt engineering guide" }),
        candidate({ url: "http://insecure.example.com/", title: "Insecure" }),
      ],
      learner: [],
      learnerNotes: [],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(recs),
      emit: f.emit,
      secret: SECRET,
    });

    expect(result.materials.map((m) => [m.id, m.title, m.backbone])).toEqual([
      ["M1", "AI Engineering", true],
      ["M2", "Evals guide", false],
    ]);
    const backbone = result.materials[0];
    expect(backbone.year).toBe(2024);
    expect(backbone.recommendedBy).toEqual(recs);
    expect(backbone.fetchedTitle).toBe("AI Engineering [Book]");
    expect(verifyMaterialSig(backbone, backbone.sig, SECRET)).toBe(true);
    expect(result.dropped.map((d) => d.title)).toEqual(["Insecure", "Broken", "Prompt engineering guide"]);
    expect(result.dropped[2].reason).toMatch(/title doesn't match/);
    expect(result.verified).toBe(2);
    const types = f.events.map((e) => e.type);
    expect(types.filter((t) => t === "research.verified")).toHaveLength(2);
    expect(types.filter((t) => t === "research.dropped")).toHaveLength(3);
  });

  it("gives no backbone when the book is recommended by only one other site", async () => {
    const f = gateFixture({ [book]: info(book, "AI Engineering") }, bookLookup);
    const result = await runGate({
      candidates: [candidate({ url: book, title: "AI Engineering", kind: "book", backbone: true, recommendedBy: [recs[0]] })],
      learner: [],
      learnerNotes: [],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(recs),
      emit: f.emit,
      secret: SECRET,
    });
    expect(result.materials[0].backbone).toBe(false);
  });

  it("drops a book with no Open Library match, and keeps it unmatched when Open Library is down", async () => {
    const pages = { [book]: info(book, "AI Engineering") };
    const cands = [candidate({ url: book, title: "AI Engineering", kind: "book", year: 2020, recommendedBy: recs })];
    const noMatch = gateFixture(pages);
    const a = await runGate({ candidates: cands, learner: [], learnerNotes: [], fetcher: noMatch.fetcher, books: noMatch.books, seenUrls: new Set(recs), emit: noMatch.emit, secret: SECRET });
    expect(a.materials).toHaveLength(0);
    expect(a.dropped[0].reason).toMatch(/Open Library/);

    const down = gateFixture(pages, { find: async () => { throw new BookLookupUnavailable("503"); } });
    const b = await runGate({ candidates: cands, learner: [], learnerNotes: [], fetcher: down.fetcher, books: down.books, seenUrls: new Set(recs), emit: down.emit, secret: SECRET });
    expect(b.materials).toHaveLength(1);
    expect(b.materials[0]).toMatchObject({ year: null, backbone: false });
  });

  it("keeps a book Open Library matches when its own page cannot be used, and links to the catalogue entry", async () => {
    const author = "https://huyenchip.com/books";
    const f = gateFixture({ [book]: new Error("403"), [author]: info(author, "Books") }, bookLookup);
    const result = await runGate({
      candidates: [
        candidate({ url: book, title: "AI Engineering: Building Applications with Foundation Models", kind: "book", backbone: true, author: "Chip Huyen", recommendedBy: recs }),
        candidate({ url: author, title: "AI Engineering", kind: "book", author: "Chip Huyen", recommendedBy: [recs[0]] }),
        candidate({ url: "none", title: "AI Engineering", kind: "book", author: "Chip Huyen" }),
      ],
      learner: [],
      learnerNotes: [],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(recs),
      emit: f.emit,
      secret: SECRET,
      now,
    });
    // All three are the same book, so they end as one material.
    expect(result.dropped).toEqual([]);
    expect(result.materials).toHaveLength(1);
    const kept = result.materials[0];
    expect(kept).toMatchObject({
      url: catalogue,
      title: "AI Engineering: Building Applications with Foundation Models",
      kind: "book",
      type: "link",
      year: 2024,
      backbone: true,
      fetchedTitle: "AI Engineering",
      verifiedAt: "2026-09-28T11:00:00.000Z",
      recommendedBy: recs,
    });
    expect(verifyMaterialSig(kept, kept.sig, SECRET)).toBe(true);
    // The unusable address is never fetched.
    expect(f.fetchPage.mock.calls.map(([url]) => url)).toEqual([book, author]);
  });

  it("does not let the catalogue stand in for a book with no author, an unknown book, or while Open Library is down", async () => {
    const run = (cand: Candidate, books: BookLookup) => {
      const f = gateFixture({ [book]: new Error("403") }, books);
      return runGate({ candidates: [cand], learner: [], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(recs), emit: f.emit, secret: SECRET, now });
    };
    const withAuthor = candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen" });

    const noAuthor = await run(candidate({ url: book, title: "AI Engineering", kind: "book" }), bookLookup);
    expect(noAuthor.materials).toHaveLength(0);
    expect(noAuthor.dropped[0].reason).toBe("could not be opened");

    const unknown = await run(withAuthor, { find: async () => null });
    expect(unknown.materials).toHaveLength(0);
    expect(unknown.dropped[0].reason).toMatch(/no matching book on Open Library/);

    const down = await run(withAuthor, { find: async () => { throw new BookLookupUnavailable("503"); } });
    expect(down.materials).toHaveLength(0);
    expect(down.dropped[0].reason).toBe("could not be opened; Open Library was unavailable");

    // Only books get this: anything else still needs its page.
    const essay = await run(candidate({ url: book, title: "AI Engineering", kind: "essay", author: "Chip Huyen" }), bookLookup);
    expect(essay.materials).toHaveLength(0);
  });

  it("dedupes by canonical final URL and merges recommendations", async () => {
    const f = gateFixture({
      "https://example.com/a": info("https://example.com/guide", "The guide"),
      "https://example.com/guide": info("https://example.com/guide", "The guide"),
    });
    const result = await runGate({
      candidates: [
        candidate({ url: "https://example.com/a", title: "The guide", recommendedBy: [recs[0]] }),
        candidate({ url: "https://example.com/guide", title: "The guide", recommendedBy: [recs[1]] }),
      ],
      learner: [],
      learnerNotes: [],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(recs),
      emit: f.emit,
      secret: SECRET,
    });
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0].url).toBe("https://example.com/guide");
    expect(result.materials[0].recommendedBy).toEqual(recs);
  });

  it("always keeps the learner's sources, reads their links, and reuses pages the arm already read", async () => {
    const f = gateFixture({ "https://learner.example.com/post": info("https://learner.example.com/post", "My favourite post") });
    await f.fetcher.fetch("https://learner.example.com/post");
    const result = await runGate({
      candidates: [],
      learner: [
        { url: "https://learner.example.com/post", type: "link" },
        { url: "Designing Data-Intensive Applications", type: "note" },
        { url: "https://down.example.com/", type: "link" },
      ],
      learnerNotes: [{ url: "https://learner.example.com/post", kind: "essay", why: "Their starting point" }],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(),
      emit: f.emit,
      secret: SECRET,
    });
    expect(result.materials.map((m) => [m.origin, m.kind, m.title, m.verifiedAt !== null])).toEqual([
      ["learner", "essay", "My favourite post", true],
      ["learner", "note", "Designing Data-Intensive Applications", false],
      ["learner", "docs", "down.example.com", false],
    ]);
    expect(f.fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe("reverifyMaterial", () => {
  it("re-signs a material whose page still matches, and drops one that no longer does", async () => {
    const f = gateFixture({ "https://example.com/guide": info("https://example.com/guide", "The guide"), "https://example.com/gone": new Error("404") });
    const base = {
      id: "M1",
      origin: "research" as const,
      type: "link" as const,
      kind: "docs" as const,
      title: "The guide",
      author: null,
      year: null,
      why: null,
      backbone: false,
      verifiedAt: "2020-01-01T00:00:00.000Z",
      fetchedTitle: "Forged",
      recommendedBy: [],
      sig: "forged",
    };
    const ok = await reverifyMaterial({ ...base, url: "https://example.com/guide" }, f.fetcher, f.books, SECRET);
    expect(ok?.fetchedTitle).toBe("The guide");
    expect(verifyMaterialSig(ok!, ok!.sig, SECRET)).toBe(true);
    expect(await reverifyMaterial({ ...base, url: "https://example.com/gone" }, f.fetcher, f.books, SECRET)).toBeNull();
  });

  it("keeps a researched book Open Library still matches, even when its page is gone", async () => {
    const f = gateFixture({ "https://example.com/gone": new Error("404") });
    const book = {
      id: "M1",
      origin: "research" as const,
      type: "link" as const,
      kind: "book" as const,
      url: "https://example.com/gone",
      title: "AI Engineering",
      author: "Chip Huyen",
      year: null,
      why: null,
      backbone: true,
      verifiedAt: "2020-01-01T00:00:00.000Z",
      fetchedTitle: "Forged",
      recommendedBy: [],
      sig: "forged",
    };
    const found: BookLookup = { find: async () => ({ key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024 }) };
    const ok = await reverifyMaterial(book, f.fetcher, found, SECRET, undefined, () => new Date("2026-09-28T11:00:00Z"));
    expect(ok).toMatchObject({ url: "https://openlibrary.org/works/OL1W", fetchedTitle: "AI Engineering", year: 2024, backbone: true, verifiedAt: "2026-09-28T11:00:00.000Z" });
    expect(verifyMaterialSig(ok!, ok!.sig, SECRET)).toBe(true);
    expect(await reverifyMaterial(book, f.fetcher, { find: async () => null }, SECRET)).toBeNull();
    expect(await reverifyMaterial(book, f.fetcher, { find: async () => { throw new BookLookupUnavailable("503"); } }, SECRET)).toBeNull();
  });
});
