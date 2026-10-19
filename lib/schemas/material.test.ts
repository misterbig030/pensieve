import { describe, expect, it } from "vitest";
import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS, chapterAt, chapterListSchema, coverRefSchema, materialRefSchema, materialSchema, normalizeCoverRef, normalizeMaterialRef, type ChapterList } from "./material";

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
  it("is optional and nullable on a material", () => {
    const base = { id: "M1", origin: "research", type: "link", kind: "book", url: "https://e.x/", title: "T", author: null, year: null, why: null, backbone: true, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null };
    expect(materialSchema.safeParse(base).success).toBe(true);
    expect(materialSchema.safeParse({ ...base, toc: null }).success).toBe(true);
    expect(materialSchema.parse({ ...base, toc: list }).toc).toEqual(list);
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
    expect(normalizeCoverRef({ id: "M2", activity: "review" })).toEqual({ id: "M2", note: null, activity: "review" });
  });
  it("chapterAt returns the chapter at a 1-based position or null", () => {
    const toc = { source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: [{ n: 1, title: "A", page: null, minutes: null, sections: [] }] };
    expect(chapterAt(toc, 1)?.title).toBe("A");
    expect(chapterAt(toc, 2)).toBeNull();
    expect(chapterAt(toc, null)).toBeNull();
    expect(chapterAt(undefined, 1)).toBeNull();
  });
});
