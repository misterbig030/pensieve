import { describe, expect, it, vi } from "vitest";
import { isPracticeOnly } from "@/lib/materials";
import type { PageInfo } from "./extract";
import type { ResearchEvent } from "./events";
import { signMaterial, verifyMaterialSig } from "./signature";
import { SourceFetcher, type PageFetcher } from "./tools";
import {
  BookLookupUnavailable,
  MAX_CANDIDATES,
  candidateListSchema,
  canonicalUrl,
  capCandidates,
  createOpenLibraryLookup,
  kindProblem,
  mainTitle,
  normalizeCoverage,
  normalizePractice,
  pickBookMatch,
  recommendingDomains,
  registrableDomain,
  reverifyMaterial,
  runGate,
  searchTitle,
  sizeMaterial,
  sizedMinutes,
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
    expect(pickBookMatch("AI Engineering: Building Applications", "Chip Huyen", docs)).toEqual({ key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024, pages: null });
    expect(pickBookMatch("AI Engineering", "Chip Huyen", [{ ...docs[1], number_of_pages_median: 532 }])?.pages).toBe(532);
    expect(pickBookMatch("AI Engineering", "Someone Else", docs)).toBeNull();
  });
  it("keeps only a key that is an Open Library work", () => {
    const doc = { title: "AI Engineering", author_name: ["Chip Huyen"] };
    expect(pickBookMatch("AI Engineering", null, [{ ...doc, key: "//evil.example/works/OL1W" }])?.key).toBeNull();
    expect(pickBookMatch("AI Engineering", null, [doc])?.key).toBeNull();
  });
  // Open Library's own order for title "System Design Interview", author "Alex Xu" (2026-10-22).
  const xuDocs = [
    { key: "/works/OL34313663W", title: "Machine Learning System Design Interview", author_name: ["Ali Aminian", "Alex Xu"] },
    { key: "/works/OL21947791W", title: "System Design Interview - an Insider's Guide", author_name: ["Alex Xu", "Sahn Lam"] },
  ];
  it("picks the closest title, not the first that contains the claim", () => {
    expect(pickBookMatch("System Design Interview – An Insider's Guide", "Alex Xu", xuDocs)?.key).toBe("/works/OL21947791W");
    expect(pickBookMatch("System Design Interview", "Alex Xu", xuDocs)?.key).toBe("/works/OL21947791W");
    expect(pickBookMatch("Machine Learning System Design Interview", "Alex Xu", xuDocs)?.key).toBe("/works/OL34313663W");
  });
  it("searches by the title without a subtitle or an aside in brackets", () => {
    expect(searchTitle("Designing Data-Intensive Applications (DDIA) — an O’Reilly book by Martin Kleppmann (The Wild Boar Book)")).toBe("Designing Data-Intensive Applications");
    expect(searchTitle("Introduction to Algorithms [3rd edition]")).toBe("Introduction to Algorithms");
    expect(searchTitle("(Untitled)")).toBe("(Untitled)");
  });
  it("finds a book whose claimed title carries a page's aside", async () => {
    const ddia = { key: "/works/OL19293745W", title: "Designing Data-Intensive Applications", author_name: ["Martin Kleppmann"], first_publish_year: 2015 };
    // Open Library finds nothing for a title that still holds "(DDIA)".
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const title = new URL(String(url)).searchParams.get("title");
      return { ok: true, status: 200, json: async () => ({ docs: title === "Designing Data-Intensive Applications" ? [ddia] : [] }) } as unknown as Response;
    });
    const claimed = "Designing Data-Intensive Applications (DDIA) — an O’Reilly book by Martin Kleppmann (The Wild Boar Book)";
    const match = await createOpenLibraryLookup(fetchImpl).find(claimed, "Martin Kleppmann");
    expect(match).toMatchObject({ key: "/works/OL19293745W", title: "Designing Data-Intensive Applications" });
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get("author")).toBe("Martin Kleppmann");
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
  return { kind: "docs", why: "why", recommendedBy: [], ...overrides };
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

  it("keeps verified candidates, drops mismatches with a reason, and marks the matched book catalogued", async () => {
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
        candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen", recommendedBy: [...recs, "https://never-seen.example/"] }),
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

    expect(result.materials.map((m) => [m.id, m.title, m.backbone, m.catalogued])).toEqual([
      ["M1", "AI Engineering", false, true],
      ["M2", "Evals guide", false, undefined],
    ]);
    const matched = result.materials[0];
    expect(matched.year).toBe(2024);
    expect(matched.recommendedBy).toEqual(recs);
    expect(matched.fetchedTitle).toBe("AI Engineering [Book]");
    expect(verifyMaterialSig(matched, matched.sig, SECRET)).toBe(true);
    expect(result.dropped.map((d) => d.title)).toEqual(["Insecure", "Broken", "Prompt engineering guide"]);
    expect(result.dropped[2].reason).toMatch(/title doesn't match/);
    expect(result.verified).toBe(2);
    const types = f.events.map((e) => e.type);
    expect(types.filter((t) => t === "research.verified")).toHaveLength(2);
    expect(types.filter((t) => t === "research.dropped")).toHaveLength(3);
  });

  it("marks matched books catalogued and chooses no backbone, keeping the arm's order", async () => {
    const other = "https://www.oreilly.com/library/view/other-book/9781098000000";
    const down = "https://www.oreilly.com/library/view/down-book/9781098000001";
    const three = [...recs, "https://www.reddit.com/r/books/comments/1"];
    const lookup: BookLookup = {
      find: async (title) => {
        if (title === "Down Book") throw new BookLookupUnavailable("503");
        return title === "AI Engineering" ? { key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024 } : { key: "/works/OL2W", title: "Other Book", authors: ["O. Author"], year: 2020 };
      },
    };
    const f = gateFixture({ [book]: info(book, "AI Engineering"), [other]: info(other, "Other Book"), [down]: info(down, "Down Book") }, lookup);
    const result = await runGate({
      candidates: [
        candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen", recommendedBy: recs }),
        candidate({ url: other, title: "Other Book", kind: "book", author: "O. Author", recommendedBy: three }),
        candidate({ url: down, title: "Down Book", kind: "book", author: "D. Author", recommendedBy: three }),
      ],
      learner: [],
      learnerNotes: [],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(three),
      emit: f.emit,
      secret: SECRET,
    });
    // The book with the most recommending sites is no longer moved first or flagged: the allocation chooses.
    expect(result.materials.map((m) => [m.id, m.title, m.backbone, m.catalogued])).toEqual([
      ["M1", "AI Engineering", false, true],
      ["M2", "Other Book", false, true],
      ["M3", "Down Book", false, undefined],
    ]);
    const verified = f.events.filter((e) => e.type === "research.verified");
    expect(verified.every((e) => e.type === "research.verified" && !e.backbone)).toBe(true);
  });

  it("falls back to the page title only when the author agrees, taking the catalogue's title", async () => {
    const url = "https://bytebytego.com/courses/coding-patterns";
    const shown = "System Design · Coding · Behavioral | ByteByteGo";
    const run = async (claim: Partial<Candidate>, catalogueAuthor: string) => {
      const find = vi.fn<BookLookup["find"]>(async (title) =>
        title === shown ? { key: "/works/OL9W", title: "Coding Interview Patterns: Nail Your Next Coding Interview", authors: [catalogueAuthor], year: 2024 } : null,
      );
      const f = gateFixture({ [url]: info(url, shown) }, { find });
      const result = await runGate({
        candidates: [candidate({ url, kind: "book", title: "Coding Interview Patterns", pageTitle: shown, author: "Alex Xu", recommendedBy: recs, ...claim })],
        learner: [],
        learnerNotes: [],
        fetcher: f.fetcher,
        books: f.books,
        seenUrls: new Set(recs),
        emit: f.emit,
        secret: SECRET,
        now,
      });
      return { result, find };
    };

    const agrees = await run({}, "Alex Xu");
    expect(agrees.find.mock.calls.map(([title, author]) => [title, author])).toEqual([
      ["Coding Interview Patterns", "Alex Xu"],
      [shown, "Alex Xu"],
    ]);
    expect(agrees.result.dropped).toEqual([]);
    // The page carries neither title, so the catalogue entry is the link, and the matched work names the material.
    expect(agrees.result.materials).toHaveLength(1);
    expect(agrees.result.materials[0]).toMatchObject({
      title: "Coding Interview Patterns: Nail Your Next Coding Interview",
      url: "https://openlibrary.org/works/OL9W",
      catalogued: true,
      backbone: false,
      year: 2024,
    });

    const disagrees = await run({}, "Someone Else");
    expect(disagrees.result.materials).toHaveLength(0);
    expect(disagrees.result.dropped.map((d) => d.reason)).toEqual(["no matching book on Open Library"]);

    // With no author to agree, a page title is not enough.
    const anonymous = await run({ author: null }, "Alex Xu");
    expect(anonymous.result.materials).toHaveLength(0);
    expect(anonymous.result.dropped.map((d) => d.reason)).toEqual(["no matching book on Open Library"]);

    // A page title that is the claimed title is not asked for twice.
    const same = await run({ pageTitle: "Coding Interview Patterns" }, "Alex Xu");
    expect(same.find).toHaveBeenCalledTimes(1);
    expect(same.result.materials).toHaveLength(0);
  });

  it("carries each candidate's foundBy onto its material, and the learner's own are found by the learner", async () => {
    const essay = "https://blog.example.com/evals";
    const guide = "https://docs.example.com/guide";
    const plain = "https://docs.example.com/plain";
    const mine = "https://learner.example.com/post";
    const f = gateFixture({
      [essay]: info(essay, "Evals guide"),
      [guide]: info(guide, "The guide"),
      "https://docs.example.com/g": info(guide, "The guide"),
      [plain]: info(plain, "Plain page"),
      [mine]: info(mine, "My post"),
    });
    const result = await runGate({
      candidates: [
        candidate({ url: essay, title: "Evals guide", kind: "essay", foundBy: ["practice"] }),
        candidate({ url: guide, title: "The guide", foundBy: ["canonical"] }),
        candidate({ url: "https://docs.example.com/g", title: "The guide", foundBy: ["current", "canonical"] }),
        candidate({ url: plain, title: "Plain page" }),
        candidate({ url: mine, title: "My post", foundBy: ["canonical"] }),
      ],
      learner: [{ url: mine, type: "link" }],
      learnerNotes: [],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(),
      emit: f.emit,
      secret: SECRET,
    });
    expect(result.materials.map((m) => [m.title, m.foundBy])).toEqual([
      ["My post", ["learner"]],
      ["Evals guide", ["practice"]],
      // Two candidates for one page: the directions that found either.
      ["The guide", ["canonical", "current"]],
      ["Plain page", undefined],
    ]);
  });

  it("keeps at most 25 candidates", () => {
    const many = Array.from({ length: 30 }, (_, i) => candidate({ url: `https://docs.example.com/p${i}`, title: `P${i}` }));
    expect(MAX_CANDIDATES).toBe(25);
    expect(capCandidates(many).map((c) => c.title)).toEqual(many.slice(0, 25).map((c) => c.title));
    expect(capCandidates(many.slice(0, 3))).toHaveLength(3);
  });

  it("takes a book's published title, its page's title and who found it, and no backbone flag", () => {
    const parsed = candidateListSchema.parse({
      learner: [],
      candidates: [
        { url: book, title: "System Design Interview – An Insider's Guide", pageTitle: "System Design Interview | ByteByteGo", kind: "book", author: "Alex Xu", why: "w", recommendedBy: [], foundBy: ["backbone", "practice"], backbone: true },
        { url: "https://docs.example.com/a", title: "Guide", pageTitle: null, kind: "docs", why: "w", recommendedBy: [] },
      ],
    });
    expect(parsed.candidates[0]).toMatchObject({ pageTitle: "System Design Interview | ByteByteGo", foundBy: ["backbone", "practice"] });
    expect(parsed.candidates[0]).not.toHaveProperty("backbone");
    expect(parsed.candidates[1].pageTitle).toBeNull();
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
    // Unmatched, so never one the allocation may make the backbone.
    expect(b.materials[0].catalogued).toBeUndefined();
  });

  it("keeps a book Open Library matches when its own page cannot be used, and links to the catalogue entry", async () => {
    const author = "https://huyenchip.com/books";
    const f = gateFixture({ [book]: new Error("403"), [author]: info(author, "Books") }, bookLookup);
    const result = await runGate({
      candidates: [
        candidate({ url: book, title: "AI Engineering: Building Applications with Foundation Models", kind: "book", author: "Chip Huyen", recommendedBy: recs }),
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
      backbone: false,
      catalogued: true,
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

describe("sizeMaterial", () => {
  it("measures a video by its runtime, a book by its pages and an essay by its length", () => {
    expect(sizeMaterial({ kind: "video", uses: null, claimedMinutes: 45, durationMinutes: 60 })).toEqual({ minutes: 60, basis: "measured" });
    expect(sizeMaterial({ kind: "book", uses: null, claimedMinutes: 600, bookPages: 532 })).toEqual({ minutes: 1330, basis: "measured" });
    expect(sizeMaterial({ kind: "essay", uses: null, claimedMinutes: 5, words: 4600 })).toEqual({ minutes: 20, basis: "measured" });
  });

  it("keeps the model's estimate where code cannot count", () => {
    expect(sizeMaterial({ kind: "course", uses: null, claimedMinutes: 480, words: 900 })).toEqual({ minutes: 480, basis: "estimated" });
    expect(sizeMaterial({ kind: "docs", uses: null, claimedMinutes: 240.4, words: 5000 })).toEqual({ minutes: 240, basis: "estimated" });
    // A short page is a landing page or an abstract, not the essay.
    expect(sizeMaterial({ kind: "essay", uses: null, claimedMinutes: 30, words: 200 })).toEqual({ minutes: 30, basis: "estimated" });
    expect(sizeMaterial({ kind: "repo", uses: null, claimedMinutes: null })).toEqual({ minutes: null, basis: null });
    expect(sizeMaterial({ kind: "repo", uses: null, claimedMinutes: -5 })).toEqual({ minutes: null, basis: null });
  });

  it("treats part of a measured work as an estimate that never exceeds the whole", () => {
    expect(sizeMaterial({ kind: "book", uses: "ch. 1, 7–9", claimedMinutes: 300, bookPages: 400 })).toEqual({ minutes: 300, basis: "estimated" });
    expect(sizeMaterial({ kind: "book", uses: "ch. 1", claimedMinutes: 5000, bookPages: 400 })).toEqual({ minutes: 1000, basis: "estimated" });
    expect(sizeMaterial({ kind: "book", uses: "ch. 1", claimedMinutes: null, bookPages: 400 })).toEqual({ minutes: 1000, basis: "estimated" });
  });
});

describe("normalizeCoverage", () => {
  it("trims, drops repeats and keeps an area on one side only", () => {
    expect(normalizeCoverage({ covered: [" Agents ", "Agents", "Evals"], open: ["Evals", "Retrieval", ""] })).toEqual({ covered: ["Agents", "Evals"], open: ["Retrieval"] });
    expect(normalizeCoverage({ covered: [], open: [] })).toBeNull();
    expect(normalizeCoverage(undefined)).toBeNull();
  });
});

describe("sizes through the gate", () => {
  it("sizes the learner's source, a matched book, an essay and a part of a work", async () => {
    const book = "https://publisher.example.com/ai-engineering";
    const essay = "https://blog.example.com/evals";
    const course = "https://course.example.com/llm";
    const mine = "https://www.youtube.com/watch?v=abc";
    const f = gateFixture(
      {
        [book]: info(book, "AI Engineering", { words: 300 }),
        [essay]: info(essay, "Evals guide", { words: 2300 }),
        [course]: info(course, "LLM Course", { words: 800 }),
        [mine]: info(mine, "Intro talk", { durationMinutes: 59 }),
      },
      { find: async () => ({ key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024, pages: 500 }) },
    );
    const result = await runGate({
      candidates: [
        candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen", minutes: 900 }),
        candidate({ url: essay, title: "Evals guide", kind: "essay", minutes: 5 }),
        candidate({ url: course, title: "LLM Course", kind: "course", minutes: 480, uses: "units 1–4" }),
      ],
      learner: [{ url: mine, type: "youtube" }],
      learnerNotes: [],
      fetcher: f.fetcher,
      books: f.books,
      seenUrls: new Set(),
      emit: f.emit,
      secret: SECRET,
    });
    expect(result.materials.map((m) => [m.title, m.minutes, m.minutesBasis, m.uses])).toEqual([
      ["Intro talk", 59, "measured", null],
      ["AI Engineering", 1250, "measured", null],
      ["Evals guide", 10, "measured", null],
      ["LLM Course", 480, "estimated", "units 1–4"],
    ]);
    expect(sizedMinutes(result.materials)).toBe(1799);
    const verified = f.events.filter((e) => e.type === "research.verified");
    expect(verified.map((e) => (e.type === "research.verified" ? [e.minutes, e.basis] : null))).toEqual([[1250, "measured"], [10, "measured"], [480, "estimated"]]);
  });
});

describe("chapters through the gate", () => {
  const TOC_IN = {
    source: "catalogue" as const,
    url: "https://openlibrary.org/books/OL1M",
    printPages: true,
    end: 100,
    chapters: [
      { n: 1, title: "A", page: 10, minutes: null, sections: [] },
      { n: 2, title: "B", page: 30, minutes: null, sections: ["B1"] },
      { n: 3, title: "C", page: 70, minutes: null, sections: [] },
    ],
  };
  const withChapters: BookLookup = {
    find: async () => ({ key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024, pages: 500 }),
    chapters: async () => TOC_IN,
  };
  const book = "https://publisher.example.com/ai-engineering";
  const cand = () => candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen" });

  it("a matched book carries its chapter list sized from the book, and the gate announces it", async () => {
    const f = gateFixture({ [book]: info(book, "AI Engineering") }, withChapters);
    const result = await runGate({ candidates: [cand()], learner: [], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(), emit: f.emit, secret: SECRET });
    const m = result.materials[0];
    expect(m.minutes).toBe(1250);
    expect(m.toc!.chapters.map((c) => c.minutes)).toEqual([278, 556, 417]);
    expect(f.events.find((e) => e.type === "research.chapters")).toEqual({ type: "research.chapters", id: m.id, title: "AI Engineering", chapters: 3, source: "catalogue", url: "https://openlibrary.org/books/OL1M" });
  });
  it("chapters() throwing leaves toc null and the book verified", async () => {
    const f = gateFixture({ [book]: info(book, "AI Engineering") }, {
      ...withChapters,
      chapters: async () => {
        throw new Error("boom");
      },
    });
    const result = await runGate({ candidates: [cand()], learner: [], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(), emit: f.emit, secret: SECRET });
    expect(result.materials[0]).toMatchObject({ title: "AI Engineering", toc: null });
    expect(f.events.some((e) => e.type === "research.chapters")).toBe(false);
  });
  it("a learner's own book enriched by a candidate gets the chapters too", async () => {
    const f = gateFixture({ [book]: info(book, "AI Engineering") }, withChapters);
    const result = await runGate({ candidates: [cand()], learner: [{ url: book, type: "link" }], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(), emit: f.emit, secret: SECRET });
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]).toMatchObject({ origin: "learner", toc: { source: "catalogue" } });
    expect(f.events.filter((e) => e.type === "research.chapters")).toHaveLength(1);
  });
});

describe("normalizePractice", () => {
  it("sizes a counted format by items times its minutes per item, the draft's own when it gives one", () => {
    expect(normalizePractice({ format: "problem-set", items: 12, perItemMinutes: null, answers: true })).toEqual({
      format: "problem-set",
      items: 12,
      perItemMinutes: 10,
      minutes: 120,
      answers: true,
    });
    expect(normalizePractice({ format: "problem-set", items: 12, perItemMinutes: 5, answers: true })?.minutes).toBe(60);
  });
  it("uses the registry's fixed minutes for a block format, and none for an unsized one", () => {
    expect(normalizePractice({ format: "mock", items: null, perItemMinutes: null, answers: true })?.minutes).toBe(75);
    expect(normalizePractice({ format: "project", items: null, perItemMinutes: null, answers: false })?.minutes).toBeNull();
  });
  it("rejects an unknown format, and a format that needs answers when the source has none", () => {
    expect(normalizePractice({ format: "quiz", items: 5, perItemMinutes: 2, answers: true })).toBeNull();
    expect(normalizePractice({ format: "problem-set", items: 20, perItemMinutes: null, answers: false })).toBeNull();
    expect(normalizePractice({ format: "lab", items: 4, perItemMinutes: null, answers: false })?.minutes).toBe(20);
  });
  it("bounds items and minutes per item", () => {
    expect(normalizePractice({ format: "recall", items: 99999, perItemMinutes: 9999, answers: true })).toMatchObject({ items: 5000, perItemMinutes: 600, minutes: 60000 });
    expect(normalizePractice({ format: "recall", items: 0, perItemMinutes: null, answers: true })?.items).toBeNull();
  });
});

describe("practice through the gate", () => {
  const gate = (f: ReturnType<typeof gateFixture>, over: Partial<Parameters<typeof runGate>[0]>) =>
    runGate({ candidates: [], learner: [], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(), emit: f.emit, secret: SECRET, ...over });
  const url = "https://example.com/exercises";
  const page = () => gateFixture({ [url]: info(url, "Exercises") });

  it("merges the reading and practice proposals for one URL into one material with both", async () => {
    const f = page();
    const result = await gate(f, {
      candidates: [
        candidate({ url, title: "Exercises", minutes: 90 }),
        candidate({ url, title: "Exercises", practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: true } }),
      ],
    });
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0].minutes).toBe(90);
    expect(result.materials[0].practice).toEqual({ format: "problem-set", items: 6, perItemMinutes: 10, minutes: 60, answers: true });
  });

  it("keeps the reading size when the practice-only candidate is listed first", async () => {
    const f = page();
    const result = await gate(f, {
      candidates: [
        candidate({ url, title: "Exercises", practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: true } }),
        candidate({ url, title: "Exercises", minutes: 90, uses: "ch. 2" }),
      ],
    });
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]).toMatchObject({ minutes: 90, minutesBasis: "estimated", uses: "ch. 2" });
    expect(result.materials[0].practice).toMatchObject({ format: "problem-set", minutes: 60 });
  });

  it("keeps the part a practice-only candidate named when the reading candidate names none", async () => {
    const f = page();
    const result = await gate(f, {
      candidates: [
        candidate({ url, title: "Exercises", uses: "exercises 1-6", practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: true } }),
        candidate({ url, title: "Exercises", minutes: 90 }),
      ],
    });
    expect(result.materials[0]).toMatchObject({ minutes: 90, uses: "exercises 1-6" });
  });

  it("takes the part a later practice-only candidate names for a reading size already kept", async () => {
    const f = page();
    const result = await gate(f, {
      candidates: [
        candidate({ url, title: "Exercises", minutes: 90 }),
        candidate({ url, title: "Exercises", uses: "exercises 1-6", practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: true } }),
      ],
    });
    expect(result.materials[0]).toMatchObject({ minutes: 90, uses: "exercises 1-6" });
  });

  it("does not attach a discarded candidate's part to the reading size already kept", async () => {
    const f = page();
    const result = await gate(f, { candidates: [candidate({ url, title: "Exercises", minutes: 90 }), candidate({ url, title: "Exercises", minutes: 20, uses: "ch. 2" })] });
    expect(result.materials[0].minutes).toBe(90);
    expect(result.materials[0].uses).toBeNull();
  });

  it("does not overwrite a reading size the kept material already has", async () => {
    const f = page();
    const result = await gate(f, { candidates: [candidate({ url, title: "Exercises", minutes: 90 }), candidate({ url, title: "Exercises", minutes: 20 })] });
    expect(result.materials[0].minutes).toBe(90);
  });

  it("does not overwrite a practice the learner's source already has", async () => {
    const f = page();
    const result = await gate(f, {
      learner: [{ url, type: "link" }],
      learnerNotes: [{ url, kind: "docs", why: "Theirs", practice: { format: "recall", items: 10, perItemMinutes: null, answers: true } }],
      candidates: [candidate({ url, title: "Exercises", practice: { format: "problem-set", items: 4, perItemMinutes: null, answers: true } })],
    });
    expect(result.materials[0].practice?.format).toBe("recall");
  });

  it("keeps a learner's source and leaves practice off when the note's draft is unusable", async () => {
    const f = page();
    const result = await gate(f, {
      learner: [{ url, type: "link" }],
      learnerNotes: [{ url, kind: "docs", why: "Theirs", practice: { format: "problem-set", items: 10, perItemMinutes: null, answers: false } }],
    });
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0].practice ?? null).toBeNull();
  });

  it("does not overwrite a practice the kept material already has", async () => {
    const f = page();
    const result = await gate(f, {
      candidates: [
        candidate({ url, title: "Exercises", minutes: 30, practice: { format: "recall", items: 10, perItemMinutes: null, answers: true } }),
        candidate({ url, title: "Exercises", practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: true } }),
      ],
    });
    expect(result.materials[0].practice?.format).toBe("recall");
  });

  it("adds a candidate's practice to the learner's own source it matches", async () => {
    const f = page();
    const result = await gate(f, {
      learner: [{ url, type: "link" }],
      learnerNotes: [{ url, kind: "docs", why: "Theirs" }],
      candidates: [candidate({ url, title: "Exercises", practice: { format: "problem-set", items: 4, perItemMinutes: null, answers: true } })],
    });
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0].origin).toBe("learner");
    expect(result.materials[0].practice).toMatchObject({ format: "problem-set", minutes: 40 });
  });

  it("keeps a practice-only material with no reading minutes", async () => {
    const f = page();
    const result = await gate(f, { candidates: [candidate({ url, title: "Exercises", practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: true } })] });
    expect(result.materials[0].minutes).toBeNull();
    expect(result.materials[0].practice?.minutes).toBe(60);
  });

  it("leaves a practice-only source unsized instead of taking its runtime", async () => {
    // A course video that is the practice source: its 39 hours of runtime are not a reading size.
    const f = gateFixture({ [url]: info(url, "Exercises", { durationMinutes: 2340 }) });
    const result = await gate(f, { candidates: [candidate({ url, title: "Exercises", kind: "video", minutes: null, practice: { format: "problem-set", items: 150, perItemMinutes: null, answers: true } })] });
    expect(result.materials[0].minutes).toBeNull();
    expect(result.materials[0].minutesBasis).toBeNull();
    expect(result.materials[0].practice?.minutes).toBe(1500);
    expect(isPracticeOnly(result.materials[0])).toBe(true);
  });

  it("still sizes a reading candidate from its page", async () => {
    const f = gateFixture({ [url]: info(url, "Exercises", { durationMinutes: 59 }) });
    const result = await gate(f, { candidates: [candidate({ url, title: "Exercises", kind: "video", minutes: 45 })] });
    expect(result.materials[0]).toMatchObject({ minutes: 59, minutesBasis: "measured" });
  });

  it("drops a practice-only candidate whose format needs answers and has none", async () => {
    const f = page();
    const result = await gate(f, { candidates: [candidate({ url, title: "Exercises", practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: false } })] });
    expect(result.materials).toEqual([]);
    expect(result.dropped).toEqual([{ title: "Exercises", url, reason: "practice without answers" }]);
  });

  it("keeps a candidate with reading minutes as reading only when its practice is unusable", async () => {
    const f = page();
    const result = await gate(f, { candidates: [candidate({ url, title: "Exercises", minutes: 45, practice: { format: "problem-set", items: 6, perItemMinutes: null, answers: false } })] });
    expect(result.materials[0].minutes).toBe(45);
    expect(result.materials[0].practice ?? null).toBeNull();
    expect(result.dropped).toEqual([]);
  });

  it("keeps the practice tag on a learner's link", async () => {
    const f = page();
    const result = await gate(f, {
      learner: [{ url, type: "link" }],
      learnerNotes: [{ url, kind: "docs", why: "Their problem list", practice: { format: "problem-set", items: 30, perItemMinutes: 8, answers: true } }],
    });
    expect(result.materials[0].practice).toEqual({ format: "problem-set", items: 30, perItemMinutes: 8, minutes: 240, answers: true });
  });
});
