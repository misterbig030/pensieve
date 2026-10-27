import { describe, expect, it } from "vitest";
import { MAX_CHAPTERS, MAX_PRACTICE_ITEMS, practiceCoverDraftSchema, practiceCoverSchema, practiceRefDraftSchema, practiceRefSchema, materialPracticeSchema, MAX_HEADING, MAX_SECTIONS, chapterAt, chapterListSchema, coverRefDraftSchema, coverRefSchema, materialRefDraftSchema, materialRefSchema, materialSchema, normalizeCoverRef, normalizeMaterialRef, type ChapterList } from "./material";

function chapter(n: number) {
  return { n, title: `Chapter ${n}`, page: n * 10, minutes: 30, sections: ["A", "B"] };
}
const list: ChapterList = { source: "catalogue", url: "https://openlibrary.org/books/OL1M", printPages: true, end: 100, chapters: [chapter(1), chapter(2), chapter(3)] };

describe("chapterListSchema", () => {
  it("accepts a list at the caps", () => {
    const full = {
      ...list,
      chapters: Array.from({ length: MAX_CHAPTERS }, (_, i) => ({ ...chapter(i + 1), title: "x".repeat(MAX_HEADING), sections: Array.from({ length: MAX_SECTIONS }, () => "s") })),
    };
    expect(chapterListSchema.safeParse(full).success).toBe(true);
  });
  it("rejects too few or too many chapters, too many sections and a long heading", () => {
    expect(chapterListSchema.safeParse({ ...list, chapters: list.chapters.slice(0, 2) }).success).toBe(false);
    expect(chapterListSchema.safeParse({ ...list, chapters: Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => chapter(i + 1)) }).success).toBe(false);
    expect(chapterListSchema.safeParse({ ...list, chapters: [{ ...chapter(1), sections: Array.from({ length: MAX_SECTIONS + 1 }, () => "s") }, chapter(2), chapter(3)] }).success).toBe(false);
    expect(chapterListSchema.safeParse({ ...list, chapters: [{ ...chapter(1), title: "x".repeat(MAX_HEADING + 1) }, chapter(2), chapter(3)] }).success).toBe(false);
  });
  it("takes a chapter's own end on a cut list and keeps a chapter without one valid", () => {
    const cut = { ...list, chapters: [{ ...chapter(1), end: 20 }, { ...chapter(3), end: null }, chapter(5)] };
    expect(chapterListSchema.parse(cut).chapters.map((c) => c.end)).toEqual([20, null, undefined]);
    expect(chapterListSchema.safeParse({ ...list, chapters: [{ ...chapter(1), end: -1 }, chapter(2), chapter(3)] }).success).toBe(false);
  });
  it("is optional and nullable on a material", () => {
    const base = { id: "M1", origin: "research", type: "link", kind: "book", url: "https://e.x/", title: "T", author: null, year: null, why: null, backbone: true, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null };
    expect(materialSchema.safeParse(base).success).toBe(true);
    expect(materialSchema.safeParse({ ...base, toc: null }).success).toBe(true);
    expect(materialSchema.parse({ ...base, toc: list }).toc).toEqual(list);
  });
});

describe("a chapter's own address and group", () => {
  it("parses with them and without them", () => {
    const withBoth = { ...chapter(1), url: "https://e.x/ch1", group: "Part I" };
    expect(chapterListSchema.parse({ ...list, chapters: [withBoth, chapter(2), chapter(3)] }).chapters[0]).toMatchObject({ url: "https://e.x/ch1", group: "Part I" });
    expect(chapterListSchema.safeParse({ ...list, chapters: [{ ...chapter(1), url: null, group: null }, chapter(2), chapter(3)] }).success).toBe(true);
    expect(chapterListSchema.safeParse(list).success).toBe(true);
    expect(chapterListSchema.safeParse({ ...list, chapters: [{ ...chapter(1), group: "x".repeat(MAX_HEADING + 1) }, chapter(2), chapter(3)] }).success).toBe(false);
  });
});

describe("research's transient fields on a material", () => {
  const base = { id: "M1", origin: "research", type: "link", kind: "book", url: "https://e.x/", title: "T", author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null };
  it("keeps catalogued and foundBy when given and needs neither", () => {
    expect(materialSchema.parse({ ...base, catalogued: true, foundBy: ["backbone", "practice"] })).toMatchObject({ catalogued: true, foundBy: ["backbone", "practice"] });
    const bare = materialSchema.parse(base);
    expect(bare).not.toHaveProperty("catalogued");
    expect(bare).not.toHaveProperty("foundBy");
  });
  it("keeps the draft-only page length, hub mark and note when given and needs none", () => {
    expect(materialSchema.parse({ ...base, pageMinutes: 90, hub: true, note: "a hub" })).toMatchObject({ pageMinutes: 90, hub: true, note: "a hub" });
    expect(materialSchema.safeParse({ ...base, pageMinutes: null, note: null }).success).toBe(true);
    const bare = materialSchema.parse(base);
    for (const key of ["pageMinutes", "hub", "note"]) expect(bare).not.toHaveProperty(key);
  });
  it("rejects a direction research does not have", () => {
    expect(materialSchema.safeParse({ ...base, foundBy: ["somewhere"] }).success).toBe(false);
  });
});

describe("references with chapters", () => {
  it("accepts chapter and activity on both ref shapes and defaults neither", () => {
    expect(materialRefSchema.parse({ id: "a", tier: "must", minutes: 10, note: null, chapter: 3, activity: "review" })).toMatchObject({ chapter: 3, activity: "review" });
    expect(coverRefSchema.parse({ id: "a", note: null })).toEqual({ id: "a", note: null });
    expect(materialRefSchema.safeParse({ id: "a", tier: "must", minutes: 10, note: null, chapter: 0 }).success).toBe(false);
    expect(materialRefSchema.safeParse({ id: "a", tier: "must", minutes: 10, note: null, chapter: 41 }).success).toBe(false);
  });
  it("normalizes a draft to activity read and leaves the chapter to the resolver", () => {
    expect(normalizeMaterialRef({ id: " M1.3 ", tier: "must", minutes: 42.6 })).toEqual({ id: "M1.3", tier: "must", minutes: 43, note: null, activity: "read" });
    expect(normalizeCoverRef({ id: "M2" })).toEqual({ id: "M2", note: null, activity: "read" });
  });
  it("the model cannot write a review: an activity in its answer is dropped and the row is a reading", () => {
    expect(materialRefDraftSchema.parse({ id: "M1.2", tier: "should", minutes: 20, activity: "review" })).toEqual({ id: "M1.2", tier: "should", minutes: 20 });
    expect(coverRefDraftSchema.parse({ id: "M1.2", activity: "review" })).toEqual({ id: "M1.2" });
    expect(normalizeMaterialRef(materialRefDraftSchema.parse({ id: "M1.2", tier: "should", minutes: 20, activity: "review" })).activity).toBe("read");
  });
  it("chapterAt returns the chapter at a 1-based position or null", () => {
    const toc = { source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: [{ n: 1, title: "A", page: null, minutes: null, sections: [] }] };
    expect(chapterAt(toc, 1)?.title).toBe("A");
    expect(chapterAt(toc, 2)).toBeNull();
    expect(chapterAt(toc, null)).toBeNull();
    expect(chapterAt(undefined, 1)).toBeNull();
  });
});

describe("materialPracticeSchema", () => {
  it("keeps a practice source's whole count when its items were cut", () => {
    const p = { format: "problem-set", items: 75, totalItems: 150, perItemMinutes: 10, minutes: 750, answers: true };
    expect(materialPracticeSchema.parse(p).totalItems).toBe(150);
    expect(materialPracticeSchema.parse({ ...p, totalItems: undefined }).totalItems).toBeUndefined();
  });
});

describe("a practice source's item list", () => {
  const item = (i: number) => ({ title: `Problem ${i}`, number: String(i), group: "Arrays", difficulty: "easy" as const, url: `https://example.com/p/${i}`, solutionUrl: null, minutes: null });
  const practice = { format: "problem-set", items: 3, perItemMinutes: 10, minutes: 30, answers: true };
  const list = (n: number) => ({ items: Array.from({ length: n }, (_, i) => item(i + 1)), source: "file" as const, url: "https://example.com/list.json" });
  it("parses a list of three items and is optional and nullable", () => {
    expect(materialPracticeSchema.parse({ ...practice, list: list(3) }).list?.items).toHaveLength(3);
    expect(materialPracticeSchema.safeParse(practice).success).toBe(true);
    expect(materialPracticeSchema.safeParse({ ...practice, list: null }).success).toBe(true);
  });
  it("rejects a list of two items or of 501, and a bad difficulty or source", () => {
    expect(MAX_PRACTICE_ITEMS).toBe(500);
    expect(materialPracticeSchema.safeParse({ ...practice, list: list(2) }).success).toBe(false);
    expect(materialPracticeSchema.safeParse({ ...practice, list: list(500) }).success).toBe(true);
    expect(materialPracticeSchema.safeParse({ ...practice, list: list(501) }).success).toBe(false);
    expect(materialPracticeSchema.safeParse({ ...practice, list: { ...list(3), source: "web" } }).success).toBe(false);
    expect(materialPracticeSchema.safeParse({ ...practice, list: { ...list(3), items: [{ ...item(1), difficulty: "brutal" }, item(2), item(3)] } }).success).toBe(false);
    expect(materialPracticeSchema.safeParse({ ...practice, list: { ...list(3), items: [{ ...item(1), title: " " }, item(2), item(3)] } }).success).toBe(false);
  });
  it("keeps a row's and a reservation's item positions when given, and parses without them", () => {
    const row = { format: "problem-set", id: "u", task: "49. Group Anagrams", done: "solved", minutes: 25, generated: false };
    expect(practiceRefSchema.safeParse(row).success).toBe(true);
    expect(practiceRefSchema.parse({ ...row, itemFrom: 12, itemTo: 12 })).toMatchObject({ itemFrom: 12, itemTo: 12 });
    expect(practiceRefSchema.safeParse({ ...row, itemFrom: null, itemTo: null }).success).toBe(true);
    expect(practiceRefSchema.safeParse({ ...row, itemFrom: 0 }).success).toBe(false);
    const cover = { format: "problem-set", id: "u", note: null };
    expect(practiceCoverSchema.safeParse(cover).success).toBe(true);
    expect(practiceCoverSchema.parse({ ...cover, itemFrom: 1, itemTo: 9 })).toMatchObject({ itemFrom: 1, itemTo: 9 });
    expect(practiceCoverSchema.safeParse({ ...cover, itemTo: 501 }).success).toBe(false);
  });
  it("lets the model write an item alias as a row's id and a run on a reservation", () => {
    expect(practiceRefDraftSchema.parse({ format: "problem-set", id: "M4.12", task: "t", done: "d", minutes: 25 }).id).toBe("M4.12");
    expect(practiceCoverDraftSchema.parse({ format: "problem-set", id: "M4", from: 1, to: 9 })).toMatchObject({ from: 1, to: 9 });
    expect(practiceCoverDraftSchema.safeParse({ format: "problem-set", id: "M4" }).success).toBe(true);
  });
});
