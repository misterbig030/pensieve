import { describe, expect, it } from "vitest";
import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS, chapterListSchema, materialSchema, type ChapterList } from "./material";

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
