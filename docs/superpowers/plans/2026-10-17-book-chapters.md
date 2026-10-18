# Book Chapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Research records each verified book's chapter list, and the outline reserves and names chapters it was given instead of chapters the model remembers.

**Architecture:** A `ChapterList` rides on the material (`Material.toc` on the wire, `sources.toc` in the database). The gate fills it from Open Library's editions for every matched book; a new pipeline stage after the gate fills the backbone's from a web page when the catalogue had none, through one search, up to three reads and one logged model call whose answer must name a page that was read. `renderMaterials` prints the chapters under the book in every prompt that lists materials, and the backbone rules switch on whether the list exists.

**Tech Stack:** Next.js 16 app, TypeScript, Drizzle + Postgres (PGlite in tests), Vercel AI SDK (`generateObject` through `loggedGenerateObject`), Zod, Vitest (node environment; no component renderer).

**Spec:** `docs/superpowers/specs/2026-10-17-book-chapters-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/book-chapters` on branch `feat/book-chapters` (cut from `origin/main` at `02fdd3c`). The main checkout runs the dock branch and its dev server; leave it alone.
- Caps, from the spec: `MIN_CHAPTERS = 3`, `MAX_CHAPTERS = 40`, `MAX_SECTIONS = 12`, `MAX_HEADING = 120` characters. A list under `MIN_CHAPTERS` is unusable, never stored.
- Sizes are shares: a chapter's minutes are its span's share of the whole span, applied to `Material.minutes`. `MINUTES_PER_PAGE` and the whole-book size are unchanged. `printPages` is true only when the end position is at most `1.1 ×` the edition's `number_of_pages`.
- Finder budget, from the spec: one search of 5 results, at most 3 pages that opened, a 20 s wall clock, 8,000 characters of each page in the prompt. Results on `openlibrary.org` and non-https results are skipped. The model call: label `Research · chapters`, caller `research`, effort `CANDIDATE_STEP_EFFORT`, retried once on a schema failure, a provider refusal on `keyOwner: "user"` rethrown.
- Prompt copy is fixed by the spec's "Rules" section; copy it verbatim.
- Event: `{ type: "research.chapters"; id; title; chapters: number; source: "catalogue" | "page" | null; url?: string }`.
- Migration `0010_source_toc` is produced by `npx drizzle-kit generate --name source_toc`, never hand-written: the next `generate` diffs against `drizzle/meta/` snapshots. `drizzle-kit` needs a TTY (repo quirk): run it in the app's Terminal panel; if that is not available, ask the operator to run it and continue when the files exist. `npx drizzle-kit migrate` touches the production database and is the operator's to run.
- Test commands: `npx vitest run <file>` per task, `npx vitest run` for the suite; `npx tsc --noEmit` and `npm run lint` before the final review. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The research eval (`evals/research/compare.ts`) costs money and is the operator's to trigger; this plan changes its metrics code only.

## Review Focus

1. **A list whose chapters carry no numbers** (level-1 headings like "Introduction", "Getting Started"): rendered without `ch. N`, and the rules still tell the model to name them "as listed", so notes name chapters by title. Pinned in Task 4.
2. **Materials saved before this change** (`toc` undefined on the row): prompts render no chapter lines, the no-list rule applies, nothing throws. Pinned in Task 4.
3. **The finder's model echoes the page URL with a trailing slash, `www.` or a tracking query** that differs from the URL read: the match is by `canonicalUrl`, not string equality. Pinned in Task 5.
4. **A list with positions but no page count and no back matter after the last chapter**: the last chapter has nothing to bound it; it gets the mean span of the other chapters so every chapter has a size, and `printPages` is false. Pinned in Task 2.
5. **A learner's own book that a candidate enriches**: the gate's enrichment path must attach the chapter list too, or the one book the learner cares most about has none. Pinned in Task 3.

---

### Task 1: The chapter list on the wire and in the database

**Files:**
- Modify: `lib/schemas/material.ts` (after `MINUTES_BASES`, and `materialSchema`)
- Modify: `lib/db/schema.ts:44-78` (`sources`), `lib/db/queries.ts:70-125` (`sourceToMaterial`, `materialsToRows`)
- Create: `drizzle/0010_source_toc.sql` + journal/snapshot, via `drizzle-kit generate`
- Test: `lib/schemas/material.test.ts` (new), `lib/db/materials.test.ts`

**Interfaces:**
- Produces, in `lib/schemas/material.ts`:
  ```ts
  export const MIN_CHAPTERS = 3; export const MAX_CHAPTERS = 40; export const MAX_SECTIONS = 12; export const MAX_HEADING = 120;
  export const chapterSchema = z.object({
    n: z.number().int().min(1).nullable(),
    title: z.string().trim().min(1).max(MAX_HEADING),
    page: z.number().int().min(0).nullable(),
    minutes: z.number().int().min(1).max(60000).nullable(),
    sections: z.array(z.string().trim().min(1).max(MAX_HEADING)).max(MAX_SECTIONS),
  });
  export const chapterListSchema = z.object({
    source: z.enum(["catalogue", "page"]),
    url: z.string().trim().min(1).max(2000),
    printPages: z.boolean(),
    /** The position after the last chapter (first back-matter entry or the page count); null when unknown or without positions. */
    end: z.number().int().min(0).nullable(),
    chapters: z.array(chapterSchema).min(MIN_CHAPTERS).max(MAX_CHAPTERS),
  });
  export type Chapter = z.infer<typeof chapterSchema>;
  export type ChapterList = z.infer<typeof chapterListSchema>;
  // materialSchema gains:  toc: chapterListSchema.nullable().optional(),
  ```
- Produces: `sources.toc` as `jsonb("toc").$type<ChapterList>()`, nullable, no default; `sourceToMaterial` sets `toc: row.toc ?? null`; `materialsToRows` sets `toc: m.toc ?? null`.

- [ ] **Step 1: Install dependencies in the worktree and confirm the baseline is green**

Run: `cd .claude/worktrees/book-chapters && npm ci && npx vitest run lib/db/materials.test.ts`
Expected: the install completes; the existing materials tests pass.

- [ ] **Step 2: Write the failing schema tests**

Create `lib/schemas/material.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS, chapterListSchema, materialSchema, type ChapterList } from "./material";

function chapter(n: number) {
  return { n, title: `Chapter ${n}`, page: n * 10, minutes: 30, sections: ["A", "B"] };
}
const list: ChapterList = { source: "catalogue", url: "https://openlibrary.org/books/OL1M", printPages: true, end: 100, chapters: [chapter(1), chapter(2), chapter(3)] };

describe("chapterListSchema", () => {
  it("accepts a list at the caps", () => {
    const full = { ...list, chapters: Array.from({ length: MAX_CHAPTERS }, (_, i) => ({ ...chapter(i + 1), title: "x".repeat(MAX_HEADING), sections: Array.from({ length: MAX_SECTIONS }, () => "s") })) };
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/schemas/material.test.ts`
Expected: FAIL, `chapterListSchema` is not exported.

- [ ] **Step 4: Add the constants, `chapterSchema`, `chapterListSchema`, the types and `materialSchema.toc`**

In `lib/schemas/material.ts`, as in the Interfaces block.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run lib/schemas/material.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write the failing round-trip test**

In `lib/db/materials.test.ts`, add to the `MATERIALS` fixture a `toc` on `M1`:

```ts
const TOC: ChapterList = { source: "catalogue", url: "https://openlibrary.org/books/OL54058212M", printPages: false, end: 1027, chapters: [
  { n: 1, title: "Introduction", page: 34, minutes: 107, sections: [] },
  { n: 2, title: "Understanding Foundation Models", page: 130, minutes: 140, sections: ["Training Data", "Modeling"] },
  { n: 3, title: "Evaluation Methodology", page: 256, minutes: 94, sections: [] },
] };
// M1: add  toc: TOC
```

and a test inside `describe("persistence of materials")`, which already saves `MATERIALS` in its `beforeAll` and reads them back with `getTrackDetail(trackId, "u1")`:

```ts
it("keeps a book's chapter list through save and load, and null for the rest", async () => {
  const detail = (await getTrackDetail(trackId, "u1"))!;
  expect(detail.materials.map((m) => m.toc ?? null)).toEqual([TOC, null, null]);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run lib/db/materials.test.ts`
Expected: FAIL, `toc` is undefined on the loaded material (or a type error on the fixture).

- [ ] **Step 8: Add the column and generate the migration**

In `lib/db/schema.ts`, import `type ChapterList` from `@/lib/schemas/material` and add to `sources` after `uses`:

```ts
/** The book's chapter list, when research found one. Null for non-books and books with no list. */
toc: jsonb("toc").$type<ChapterList>(),
```

Run: `npx drizzle-kit generate --name source_toc` (in the app's Terminal panel if it needs a TTY)
Expected: `drizzle/0010_source_toc.sql` containing `ALTER TABLE "sources" ADD COLUMN "toc" jsonb;`, a new entry in `drizzle/meta/_journal.json` and `drizzle/meta/0010_snapshot.json`. Nothing else in the diff.

- [ ] **Step 9: Copy `toc` through both mappers**

`sourceToMaterial`: `toc: row.toc ?? null`. `materialsToRows`: `toc: m.toc ?? null`.

- [ ] **Step 10: Run the tests, then the type check**

Run: `npx vitest run lib/db/materials.test.ts lib/schemas/material.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 11: Commit**

```bash
git add lib/schemas/material.ts lib/schemas/material.test.ts lib/db/schema.ts lib/db/queries.ts lib/db/materials.test.ts drizzle/0010_source_toc.sql drizzle/meta/
git commit -m "feat(materials): a book carries its chapter list on the wire and in sources.toc"
```

---

### Task 2: Parsing Open Library's table of contents and sizing chapters

**Files:**
- Create: `lib/ai/research/chapters.ts`, `lib/ai/research/chapters.test.ts`

**Interfaces:**
- Consumes: `ChapterList`, `Chapter`, caps and `clip` from `lib/schemas/material.ts` (Task 1).
- Produces:
  ```ts
  export type OpenLibraryTocEntry = string | { level?: number; label?: string; title?: string; pagenum?: string | number; type?: unknown };
  export const MATTER_RE = /^(preface|foreword|acknowledg|about the|index|glossary|bibliography|references|notes|epilogue|afterword|appendix|colophon|contents|dedication|copyright)/i;
  /** Section headings that say nothing about the chapter's subject. */
  export const SECTION_SKIP_RE = /^(summary|exercises?|conclusions?|further reading|key takeaways|review questions)$/i;
  export const PRINT_PAGES_SLACK = 1.1;
  /** Null when unusable. Every chapter's `minutes` is null; `withChapterSizes` fills them. */
  export function parseOpenLibraryToc(entries: OpenLibraryTocEntry[], edition: { url: string; numberOfPages: number | null }): ChapterList | null;
  /** Shares of the span applied to `bookMinutes`. Unchanged when `bookMinutes` is null or the list has no positions. */
  export function withChapterSizes(toc: ChapterList, bookMinutes: number | null): ChapterList;
  ```

The parser's rules, which the tests below pin:

- Each entry becomes `{ level, heading, pos }`. Object with a non-empty `label`: heading is `label`, pos is `pagenum` when numeric else `title` when numeric. Object without `label`: heading is `title`, pos is `pagenum` when numeric. String: `level` is 1 plus the number of leading `*` characters, which are removed; the rest is split on `|` and trimmed; heading is the first non-numeric segment, pos the last numeric one. `level` defaults to 1. Numeric means a positive integer after removing commas and spaces. Entries without a heading are dropped, and so are sections that come before the first chapter.
- Chapters are level 1. When every level-1 heading that is not matter matches `/^part\b/i`, chapters are level 2 and sections level 3.
- A chapter-level heading matching `MATTER_RE` is matter: dropped before the first chapter; the first one after the last chapter, with a position above the last chapter's, is `end`.
- The chapter number is the leading integer of `/^(?:chapter\s+)?(\d{1,3})\b[\s.:–-]*/i`, stripped from the title; `n` is null without one. An empty remainder keeps the whole heading as the title.
- Sections are the entries one level below a chapter until the next chapter-level entry, minus those matching `SECTION_SKIP_RE`, clipped to `MAX_HEADING`, at most `MAX_SECTIONS`.
- Positions are kept only when every chapter has one and they strictly increase; otherwise every `page` and `end` is null. With positions kept and no matter after the last chapter, `end` is `numberOfPages` when known.
- `printPages` is true when positions are kept, `numberOfPages` is known, and `(end ?? last chapter's page) <= PRINT_PAGES_SLACK * numberOfPages`.
- The first `MAX_CHAPTERS` chapters are kept; fewer than `MIN_CHAPTERS` makes the result null.

`withChapterSizes`: span of chapter *i* is `page[i+1] - page[i]`; the last chapter's is `end - page[last]`, or, with `end` null, the mean of the other spans (rounded). Each chapter's minutes is `Math.round(bookMinutes * span / totalSpan)`, at least 1.

- [ ] **Step 1: Write the failing parser tests**

```ts
import { describe, expect, it } from "vitest";
import { MAX_CHAPTERS, MAX_HEADING, MAX_SECTIONS } from "@/lib/schemas/material";
import { parseOpenLibraryToc, withChapterSizes, type OpenLibraryTocEntry } from "./chapters";

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
    const a = parseOpenLibraryToc([{ level: 1, label: "Chapter 1 Alpha", pagenum: "5", title: "ignored" }, { level: 1, label: "Chapter 2 Beta", pagenum: 20 }, { level: 1, label: "Chapter 3 Gamma", pagenum: "40" }], { url: "u", numberOfPages: 60 })!;
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
    const toc = parseOpenLibraryToc([
      { level: 1, label: "Part I. Basics", title: "1" }, { level: 2, label: "1. One", title: "3" }, { level: 3, label: "Deep", title: "4" },
      { level: 2, label: "2. Two", title: "10" }, { level: 1, label: "Part II. More", title: "19" }, { level: 2, label: "3. Three", title: "20" },
    ], { url: "u", numberOfPages: 30 })!;
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
  const base = parseOpenLibraryToc([{ level: 1, label: "1. A", title: "10" }, { level: 1, label: "2. B", title: "30" }, { level: 1, label: "3. C", title: "70" }, { level: 1, label: "Index", title: "100" }], { url: "u", numberOfPages: 100 })!;
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ai/research/chapters.test.ts`
Expected: FAIL, cannot resolve `./chapters`.

- [ ] **Step 3: Implement `parseOpenLibraryToc` and `withChapterSizes` in `lib/ai/research/chapters.ts`**

Per the rules above. Import `MIN_CHAPTERS`, `MAX_CHAPTERS`, `MAX_SECTIONS`, `MAX_HEADING`, `clip` and the types from `@/lib/schemas/material`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/ai/research/chapters.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/research/chapters.ts lib/ai/research/chapters.test.ts
git commit -m "feat(research): parse Open Library tables of contents into chapter lists with sizes as shares"
```

---

### Task 3: The catalogue lookup, the gate, and the event

**Files:**
- Modify: `lib/ai/research/verify.ts:191-265` (`BookLookup`, `createOpenLibraryLookup`), `verify.ts:421-607` (`runGate`)
- Modify: `lib/ai/research/events.ts`
- Test: `lib/ai/research/chapters.test.ts`, `lib/ai/research/verify.test.ts`

**Interfaces:**
- Consumes: `parseOpenLibraryToc`, `withChapterSizes` (Task 2); `ChapterList` (Task 1).
- Produces:
  ```ts
  // verify.ts
  export interface BookLookup {
    find(title: string, author: string | null, signal?: AbortSignal): Promise<BookMatch | null>;
    /** The work's chapter list from the edition with the longest usable table of contents; null when none, on a missing key, or on any failure. Optional so fakes stay small. */
    chapters?(match: BookMatch, signal?: AbortSignal): Promise<ChapterList | null>;
  }
  // events.ts
  | { type: "research.chapters"; id: string; title: string; chapters: number; source: "catalogue" | "page" | null; url?: string }
  ```
- The Open Library `chapters` fetches `https://openlibrary.org{match.key}/editions.json?limit=50` with the existing user agent and a 5 s timeout, parses each entry's `table_of_contents` array through `parseOpenLibraryToc(toc, { url: \`https://openlibrary.org${entry.key}\`, numberOfPages: entry.number_of_pages ?? null })`, and returns the result with the most chapters. Any thrown error or non-OK response → null.
- The gate: `bookChecks` also awaits `books.chapters?.(match, signal)` for a match, catching to null. At acceptance, `toc = bookMatched && check.toc ? withChapterSizes(check.toc, size.minutes) : null` goes on the material (`toc: null` on the learner path and on non-books). The enrichment path (`mine`) sets `mine.material.toc = toc ?? mine.material.toc ?? null`. In step 4, for every material with a `toc`, emit `research.chapters` with `chapters: toc.chapters.length`, `source: toc.source`, `url: toc.url`, right after its `research.verified` event (or in its place in the loop for a learner's book, which gets no `verified` event).

- [ ] **Step 1: Write the failing lookup tests** (in `chapters.test.ts`)

```ts
import { createOpenLibraryLookup } from "./verify";

describe("Open Library chapters", () => {
  const match = { key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024, pages: 350 };
  const editions = { entries: [
    { key: "/books/OL2M", number_of_pages: 534 },
    { key: "/books/OL1M", number_of_pages: 350, table_of_contents: [
      { level: 1, label: "1. A", title: "10" }, { level: 1, label: "2. B", title: "30" }, { level: 1, label: "3. C", title: "70" }, { level: 1, label: "Index", title: "100" },
    ] },
    { key: "/books/OL3M", number_of_pages: 300, table_of_contents: [{ level: 1, label: "1. A", title: "1" }, { level: 1, label: "2. B", title: "9" }] },
  ] };
  const fetchJson = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response);

  it("fetches the work's editions and returns the longest usable list", async () => {
    const fetchImpl = fetchJson(editions);
    const toc = await createOpenLibraryLookup(fetchImpl).chapters!(match);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://openlibrary.org/works/OL1W/editions.json?limit=50");
    expect(toc).toMatchObject({ source: "catalogue", url: "https://openlibrary.org/books/OL1M", end: 100, printPages: true });
    expect(toc!.chapters.map((c) => c.title)).toEqual(["A", "B", "C"]);
  });
  it("is null without a work key, on a failed request, and when no edition has a usable list", async () => {
    expect(await createOpenLibraryLookup(fetchJson(editions)).chapters!({ ...match, key: null })).toBeNull();
    expect(await createOpenLibraryLookup(fetchJson({}, false)).chapters!(match)).toBeNull();
    expect(await createOpenLibraryLookup(vi.fn(async () => { throw new Error("down"); })).chapters!(match)).toBeNull();
    expect(await createOpenLibraryLookup(fetchJson({ entries: [editions.entries[0]] })).chapters!(match)).toBeNull();
  });
});
```

(add `vi` to the vitest import.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ai/research/chapters.test.ts`
Expected: FAIL, `chapters` is not a function.

- [ ] **Step 3: Add `chapters` to `BookLookup` and implement it in `createOpenLibraryLookup`**

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/ai/research/chapters.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing gate tests** (in `verify.test.ts`, inside `describe("sizes through the gate")` or a new `describe("chapters through the gate")`)

```ts
const TOC_IN = { source: "catalogue" as const, url: "https://openlibrary.org/books/OL1M", printPages: true, end: 100, chapters: [
  { n: 1, title: "A", page: 10, minutes: null, sections: [] }, { n: 2, title: "B", page: 30, minutes: null, sections: ["B1"] }, { n: 3, title: "C", page: 70, minutes: null, sections: [] },
] };
const withChapters: BookLookup = {
  find: async () => ({ key: "/works/OL1W", title: "AI Engineering", authors: ["Chip Huyen"], year: 2024, pages: 500 }),
  chapters: async () => TOC_IN,
};

it("a matched book carries its chapter list sized from the book, and the gate announces it", async () => {
  const book = "https://publisher.example.com/ai-engineering";
  const f = gateFixture({ [book]: info(book, "AI Engineering") }, withChapters);
  const result = await runGate({ candidates: [candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen" })], learner: [], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(), emit: f.emit, secret: SECRET });
  const m = result.materials[0];
  expect(m.minutes).toBe(1250);
  expect(m.toc!.chapters.map((c) => c.minutes)).toEqual([278, 556, 417]);
  expect(f.events.find((e) => e.type === "research.chapters")).toEqual({ type: "research.chapters", id: m.id, title: "AI Engineering", chapters: 3, source: "catalogue", url: "https://openlibrary.org/books/OL1M" });
});
it("chapters() throwing leaves toc null and the book verified", async () => {
  const book = "https://publisher.example.com/ai-engineering";
  const f = gateFixture({ [book]: info(book, "AI Engineering") }, { ...withChapters, chapters: async () => { throw new Error("boom"); } });
  const result = await runGate({ candidates: [candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen" })], learner: [], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(), emit: f.emit, secret: SECRET });
  expect(result.materials[0]).toMatchObject({ title: "AI Engineering", toc: null });
  expect(f.events.some((e) => e.type === "research.chapters")).toBe(false);
});
it("a learner's own book enriched by a candidate gets the chapters too", async () => {
  const book = "https://publisher.example.com/ai-engineering";
  const f = gateFixture({ [book]: info(book, "AI Engineering") }, withChapters);
  const result = await runGate({ candidates: [candidate({ url: book, title: "AI Engineering", kind: "book", author: "Chip Huyen" })], learner: [{ url: book, type: "link" }], learnerNotes: [], fetcher: f.fetcher, books: f.books, seenUrls: new Set(), emit: f.emit, secret: SECRET });
  expect(result.materials).toHaveLength(1);
  expect(result.materials[0]).toMatchObject({ origin: "learner", toc: { source: "catalogue" } });
  expect(f.events.filter((e) => e.type === "research.chapters")).toHaveLength(1);
});
```

(Use the file's existing `candidate(...)` helper and `info(...)`.)

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run lib/ai/research/verify.test.ts`
Expected: the three new tests FAIL (`toc` undefined, no event); the rest pass.

- [ ] **Step 7: Add the event type and wire the gate**

`events.ts`: the union member. `verify.ts`: `bookChecks` returns `{ match, unavailable, toc }`; acceptance and enrichment set `toc`; step 4 emits. Import `withChapterSizes` from `./chapters` and `ChapterList` from the schema.

- [ ] **Step 8: Keep the progress reducer compiling, then run the research tests and the type check**

`reduceResearch` in `lib/researchProgress.ts` switches over every event type with no default, so the new member makes its end reachable and tsc rejects it. Add `case "research.chapters": return state;` now; Task 7 replaces it.

Run: `npx vitest run lib/ai/research && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add lib/ai/research/verify.ts lib/ai/research/verify.test.ts lib/ai/research/chapters.test.ts lib/ai/research/events.ts lib/researchProgress.ts
git commit -m "feat(research): the gate attaches a matched book's Open Library chapter list and announces it"
```

---

### Task 4: Chapters in the prompts, and the rules that depend on them

**Files:**
- Modify: `lib/ai/planPrompt.ts:104-133` (`renderMaterials`, `contextLines`), `:231-262` (`headingMaterialRules`, `leafMaterialRules`), `buildUnitsPrompt`, `buildRevisionPrompt`, `buildPlanChatSystemPrompt`
- Test: `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Consumes: `Material.toc: ChapterList | null | undefined` (Task 1).
- Produces:
  ```ts
  export interface RenderMaterialsOptions { /** Print section headings under the backbone's chapters. */ sections?: boolean }
  export function renderMaterials(materials: Material[], aliases?: MaterialAliases, options?: RenderMaterialsOptions): string;
  /** The indented chapter lines and the source line for one book; [] without a list. */
  export function renderChapters(toc: ChapterList, options: { sections: boolean }): string[];
  ```
- Chapter line: two spaces, then `ch. {n} ` when `n` is not null, then `"{title}"`, then ` · pp. {page}–{nextPage − 1}` when `printPages` and the chapter has a page (the last chapter ends at `end − 1`, or shows ` · p. {page}` when `end` is null), then ` · about {formatMinutes(minutes)}` when `minutes` is not null, then ` — {sections joined by "; "}` when `options.sections` and the chapter has sections. Last line: `  (chapters from Open Library)` for `source: "catalogue"`, `  (chapters from {hostOf(url)})` for `"page"`.
- `contextLines(ctx, options)` passes `options` to `renderMaterials`. `buildUnitsPrompt` and `buildRevisionPrompt` pass `{ sections: true }`; the chat prompt calls `renderMaterials(input.materials)` as today. Sections print only for the material with `backbone: true`.
- Rules: `headingMaterialRules(input)` and `leafMaterialRules(input, aliases)` find the backbone and branch on `backbone.toc`; the four texts are the spec's, verbatim. Whenever `input.materials.some((m) => m.kind === "book")`, both rule blocks end with the spec's general line before `Use only ids from the list.`

- [ ] **Step 1: Write the failing tests**

Update the existing expectation in "asks headings to reserve the backbone's chapters in order…": the fixture's backbone has no `toc`, so it now reads

```ts
expect(prompt).toContain("M1 is the backbone textbook, but its chapters are not listed: reserve it in order across the units");
expect(prompt).toContain("Never write a chapter number or a chapter title you were not given.");
expect(prompt).toContain("Where a book's chapters are listed, name them as listed.");
```

Add a `describe("chapters in prompts")`:

```ts
const TOC: ChapterList = { source: "catalogue", url: "https://openlibrary.org/books/OL1M", printPages: true, end: 100, chapters: [
  { n: 1, title: "Alpha", page: 10, minutes: 200, sections: ["A1", "A2"] },
  { n: 2, title: "Beta", page: 30, minutes: 400, sections: [] },
  { n: 3, title: "Gamma", page: 70, minutes: 300, sections: ["G1"] },
] };
const withToc: Material[] = [{ ...MATERIALS[0], toc: TOC }, MATERIALS[1]];

it("renders chapter lines under the book, with sections for the backbone when asked", () => {
  expect(renderMaterials(withToc, undefined, { sections: true })).toBe([
    'M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024 <https://example.com/aie>. The backbone.',
    '  ch. 1 "Alpha" · pp. 10–29 · about 3.3 h — A1; A2',
    '  ch. 2 "Beta" · pp. 30–69 · about 6.7 h',
    '  ch. 3 "Gamma" · pp. 70–99 · about 5 h — G1',
    "  (chapters from Open Library)",
    `M2 [video · the learner's own] "Intro talk" <https://youtu.be/x>`,
  ].join("\n"));
  expect(renderMaterials(withToc)).not.toContain("A1; A2");
});
it("omits the number, the pages and the size when the list has none, and names the page host", () => {
  const sparse: ChapterList = { source: "page", url: "https://www.example.org/review?x=1", printPages: false, end: null, chapters: [
    { n: null, title: "Alpha", page: null, minutes: null, sections: [] }, { n: null, title: "Beta", page: null, minutes: null, sections: [] }, { n: null, title: "Gamma", page: null, minutes: null, sections: [] },
  ] };
  expect(renderChapters(sparse, { sections: true })).toEqual(['  "Alpha"', '  "Beta"', '  "Gamma"', "  (chapters from example.org)"]);
});
it("switches the backbone rules on the list, at both levels", () => {
  const heading = buildUnitsPrompt({ topic: "X", materials: withToc, granularity: "week", level: "month", spans: [28, 28], startDay: 1, totalDays: 56, unitsAreLeaves: false });
  expect(heading).toContain("M1 is the backbone textbook and its chapters are listed above: reserve them in order across the units, each chapter in exactly one unit, and write the note as the chapter numbers and titles exactly as listed");
  expect(heading).toContain('ch. 1 "Alpha"');
  const leaf = buildUnitsPrompt({ topic: "X", materials: withToc, granularity: "week", level: "week", spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true });
  expect(leaf).toContain("M1 is the backbone textbook and its chapters are listed above with their sizes");
  expect(leaf).toContain("A unit's minutes for it are the listed size of what it reads, or that share of a chapter.");
  const leafNoList = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "week", spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true });
  expect(leafNoList).toContain("M1 is the backbone textbook, but its chapters are not listed: it runs in order across the units");
});
it("a saved material with toc undefined renders no chapter lines and gets the no-list rule", () => {
  const saved = MATERIALS.map((m) => ({ ...m, toc: undefined }));
  const prompt = buildUnitsPrompt({ topic: "X", materials: saved, granularity: "week", level: "month", spans: [28], startDay: 1, totalDays: 28, unitsAreLeaves: false });
  expect(prompt).not.toContain("ch. ");
  expect(prompt).toContain("but its chapters are not listed");
});
it("revision prompts show sections and chat prompts do not", () => {
  const root = makeRoot([makeNode({ id: "d1", level: "day", title: "A", summary: "b", len: 1 })]);
  expect(buildRevisionPrompt({ topic: "X", materials: withToc, granularity: "day", tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "x" })).toContain("— A1; A2");
  const chat = buildPlanChatSystemPrompt({ mode: "create", topic: "X", materials: withToc, granularity: "day", tree: root, lockBefore: 0 });
  expect(chat).toContain('ch. 2 "Beta"');
  expect(chat).not.toContain("— A1; A2");
});
it("leaves the general chapter line out when no book is listed", () => {
  const prompt = buildUnitsPrompt({ topic: "X", materials: [MATERIALS[1]], granularity: "day", level: "day", spans: [1], startDay: 1, totalDays: 1, unitsAreLeaves: true });
  expect(prompt).not.toContain("Where a book's chapters are listed");
});
```

(`formatMinutes(200)` is `3.3 h`, `400` → `6.7 h`, `300` → `5 h`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ai/planPrompt.test.ts`
Expected: the updated test and the six new tests FAIL; `renderChapters` is not exported.

- [ ] **Step 3: Implement `renderChapters`, the `options` parameter, and the rule branches**

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/ai/planPrompt.test.ts lib/ai/planDraft.test.ts lib/ai/planRevision.test.ts`
Expected: PASS. (The draft and revision tests assert on prompt text in places; if one asserts the old backbone sentence, update it to the no-list wording.)

- [ ] **Step 5: Commit**

```bash
git add lib/ai/planPrompt.ts lib/ai/planPrompt.test.ts
git commit -m "feat(prompt): list a book's chapters under it and reserve only chapters the model was given"
```

---

### Task 5: The chapter finder: one search, three reads, one call

**Files:**
- Modify: `lib/ai/research/chapters.ts`
- Test: `lib/ai/research/chapters.test.ts`

**Interfaces:**
- Consumes: `SearchProvider`, `SearchProviderError`, `SourceFetcher`, `FetchOutcome` (`tools.ts`); `loggedGenerateObject`, `GenerationLogContext` (`../logged`); `providerError` (`../providerError`); `CANDIDATE_STEP_EFFORT`, `DEFAULT_RESEARCH_MODEL`, `AiModelId`, `ReasoningEffort` (`../models`); `mainTitle`, `canonicalUrl` (`./verify`); `ResearchEvent`, `ResearchCounts` (`./events`); `hostOf`, caps, `clip` (schema).
- Produces:
  ```ts
  export const FINDER_RESULTS = 5; export const FINDER_READS = 3; export const FINDER_WALL_MS = 20_000; export const FINDER_PAGE_CHARS = 8_000;
  export const chaptersAnswerSchema = z.object({
    found: z.boolean().describe("True only when one of the pages shows this book's chapter list"),
    url: z.string().nullable().describe("The one page the list came from"),
    chapters: z.array(z.object({ n: z.number().nullable(), title: z.string(), sections: z.array(z.string()) })),
  });
  export type ChaptersAnswer = z.infer<typeof chaptersAnswerSchema>;
  export function buildChaptersPrompt(book: Pick<Material, "title" | "author">, pages: { url: string; text: string }[]): string;
  /** The answer as a ChapterList, or null when it names no page that was read, has fewer than MIN_CHAPTERS chapters, or numbers that do not increase. */
  export function validateChaptersAnswer(answer: ChaptersAnswer, readUrls: string[]): ChapterList | null;
  export interface ChapterFinderContext { fetcher: SourceFetcher; emit: (event: ResearchEvent) => void; signal?: AbortSignal; log?: GenerationLogContext }
  export interface ChapterFinderResult { toc: ChapterList | null; counts: ResearchCounts; costUsd: number }
  export interface ChapterFinder { find(book: Material, ctx: ChapterFinderContext): Promise<ChapterFinderResult> }
  export function createChapterFinder(options: { provider: SearchProvider; model?: AiModelId | LanguageModel; effort?: ReasoningEffort }): ChapterFinder;
  ```
- `buildChaptersPrompt` copy, lines joined by `\n`:
  ```
  Find the table of contents of the book "{title}"{ by {author}} in the pages below.
  --- {url} ---
  {text clipped to FINDER_PAGE_CHARS}
  (one block per page)
  List the book's chapters as the page gives them, in order, with the headings under each chapter when the page shows them. Set "url" to the one page the list came from. If no page shows this book's chapter list, return found: false and no chapters. Do not add chapters from memory.
  ```
- `find`, in order, under `signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(FINDER_WALL_MS)])` (just the timeout when `ctx.signal` is absent): search `${mainTitle(book.title)} ${book.author ?? ""} table of contents` trimmed, `maxResults: FINDER_RESULTS`, emit `research.search`; a `SearchProviderError` or abort → `{ toc: null, counts: { searches: 1, fetches: 0 }, costUsd: 0 }`. Keep results whose URL is https and whose `hostOf` is not `openlibrary.org`. In order, emit `research.reading`, `ctx.fetcher.fetch(url, signal)`, emit `research.fetch`, count the fetch; stop after `FINDER_READS` pages opened or the results run out. No page opened → null. One `loggedGenerateObject` (`label: "Research · chapters"`, `facts: readUrls`, `effort: options.effort ?? CANDIDATE_STEP_EFFORT`, `{ ...ctx.log, caller: "research" }`), retried once on failure like `runCandidateStep`; `ctx.log?.keyOwner === "user" && providerError(error)` rethrows. Result: `validateChaptersAnswer(object, readUrls)`.
- `validateChaptersAnswer`: `found` and `url` whose `canonicalUrl` equals the `canonicalUrl` of one read URL; chapters mapped to `{ n: positive integer or null, title: clip(MAX_HEADING), page: null, minutes: null, sections: clipped, SECTION_SKIP_RE removed, at most MAX_SECTIONS }`, empty titles dropped, first `MAX_CHAPTERS` kept; at least `MIN_CHAPTERS`; the non-null `n`s strictly increasing. Returns `{ source: "page", url: <the read URL as fetched>, printPages: false, end: null, chapters }`.

- [ ] **Step 1: Write the failing tests** (in `chapters.test.ts`)

Local helpers, copied from the other research tests: `usage` and `fetcherFor(pages)` from `agent.test.ts`; `info(url, title, extra)` from `verify.test.ts`. `MockLanguageModelV4` (from `ai/test`) records what it was asked in `doGenerateCalls`. `APICallError` comes from `@ai-sdk/provider`, `providerError` from `../providerError`.

```ts
describe("the chapter finder", () => {
  const book: Material = { id: "M1", origin: "research", type: "link", kind: "book", url: "https://openlibrary.org/works/OL1W", title: "AI Engineering: Building Applications", author: "Chip Huyen", year: 2024, why: null, backbone: true, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, minutes: 1105 };
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
  const provider = () => ({ name: "fake", search: vi.fn(async () => results) });
  const answer = (a: unknown) => new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify(a) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }) });
  const good = { found: true, url: "https://example.org/review/?utm_source=x", chapters: [{ n: 1, title: "A", sections: ["A1", "Summary"] }, { n: 2, title: "B", sections: [] }, { n: 3, title: "C", sections: [] }] };

  it("searches once, reads the https non-catalogue results that open, and feeds them to the model", async () => {
    const p = provider();
    const model = answer(good);
    const { fetcher, fetchPage } = fetcherFor(pages); // as in agent.test.ts: unknown URLs throw
    const events: ResearchEvent[] = [];
    const found = await createChapterFinder({ provider: p, model }).find(book, { fetcher, emit: (e) => void events.push(e) });
    expect(p.search.mock.calls[0][0]).toBe("AI Engineering Chip Huyen table of contents");
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual(["https://www.example.org/review", "https://blocked.example.com/", "https://uni.example.edu/syllabus"]);
    expect(events.filter((e) => e.type === "research.fetch").map((e) => (e as { ok: boolean }).ok)).toEqual([true, false, true]);
    expect(found.counts).toEqual({ searches: 1, fetches: 3 });
    expect(found.toc).toMatchObject({ source: "page", url: "https://www.example.org/review", printPages: false, end: null });
    expect(found.toc!.chapters.map((c) => [c.n, c.title, c.page, c.minutes, c.sections])).toEqual([[1, "A", null, null, ["A1"]], [2, "B", null, null, []], [3, "C", null, null, []]]);
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
    expect(validateChaptersAnswer(good, read)).not.toBeNull(); // trailing slash, www and a query are ignored
  });
  it("is null when the search fails or no page opens, without calling the model", async () => {
    const model = answer(good);
    const down = { name: "fake", search: vi.fn(async () => { throw new SearchProviderError("down"); }) };
    expect((await createChapterFinder({ provider: down, model }).find(book, { fetcher: fetcherFor({}).fetcher, emit: () => {} })).toc).toBeNull();
    expect((await createChapterFinder({ provider: provider(), model }).find(book, { fetcher: fetcherFor({}).fetcher, emit: () => {} })).toc).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(0);
  });
  it("rethrows a provider refusal on the user's key and swallows one on the app's", async () => {
    const refusal = () => new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false });
    const refusing = new MockLanguageModelV4({ doGenerate: async () => { throw refusal(); } });
    const ctx = { fetcher: fetcherFor(pages).fetcher, emit: () => {} };
    await expect(createChapterFinder({ provider: provider(), model: refusing }).find(book, { ...ctx, log: { keyOwner: "user" } })).rejects.toSatisfy((e: unknown) => providerError(e)?.statusCode === 400);
    expect((await createChapterFinder({ provider: provider(), model: refusing }).find(book, ctx)).toc).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ai/research/chapters.test.ts`
Expected: FAIL, `createChapterFinder` is not exported.

- [ ] **Step 3: Implement the schema, prompt, validator and finder**

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/ai/research/chapters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/research/chapters.ts lib/ai/research/chapters.test.ts
git commit -m "feat(research): a chapter finder reads a book's table of contents from a page found by one search"
```

---

### Task 6: The pipeline stage, the default finder, and the route

**Files:**
- Modify: `lib/ai/research/pipeline.ts:82-161` (`ResearchMaterialsInput`, `defaultArm` neighbourhood, `researchMaterials`), `lib/ai/planDraft.ts:337-347` (`StreamResearchedDraftInput.research`), `app/api/plan/draft/route.ts:40-55`
- Test: `lib/ai/research/pipeline.test.ts` (new)

**Interfaces:**
- Consumes: `ChapterFinder`, `createChapterFinder` (Task 5); `research.chapters` event (Task 3).
- Produces:
  ```ts
  // pipeline.ts
  export interface ResearchMaterialsInput { …; chapters?: ChapterFinder }
  /** The finder the app ships, on the same provider as the arm; null when TAVILY_API_KEY is unset. */
  export function defaultChapterFinder(env?: Record<string, string | undefined>, options?: { model?: AiModelId | LanguageModel }): ChapterFinder | null;
  // planDraft.ts
  research?: Pick<ResearchMaterialsInput, "fetcher" | "books" | "caps" | "chapters">;
  ```
- The stage, after the gate and before `research.done`: when `input.chapters` is set and the backbone (`gate.materials.find((m) => m.backbone)`) exists with no `toc`, run `yield* streamWhile((emit) => input.chapters.find(backbone, { fetcher, emit, signal: input.signal, log: input.log }))` in a try/catch that rethrows `input.log?.keyOwner === "user" && providerError(error)` and otherwise logs `[research] chapter finder failed` and continues as not found. Add the finder's `counts` into `counts` and its `costUsd` into the outcome's cost; replace the backbone in the materials list with `{ ...backbone, toc }` when found; emit `research.chapters` for the backbone either way (`chapters: 0, source: null` when not found). `research.done` and the returned outcome carry the updated materials.
- The route passes `research: { chapters: defaultChapterFinder(process.env, { model: models.research.model }) ?? undefined }`.

- [ ] **Step 1: Write the failing tests**

Create `lib/ai/research/pipeline.test.ts`. Fixtures (`collect`, `fetcherFor`, `page` as in `agent.test.ts`; `brief` is `{ topic: "LLM engineering", days: 30, sources: [] }`):

```ts
const recs = ["https://lists.bookrecs.com/best", "https://blog.readinglist.org/reading"];
const bookUrl = "https://books.example.com/core";
const arm: ResearchArm = async () => ({
  candidates: [{ url: bookUrl, title: "Core Textbook", kind: "book", backbone: true, author: "A. Author", why: "The standard text", recommendedBy: recs }],
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
```

Tests:

```ts
const TOC: ChapterList = { source: "page", url: "https://www.example.org/review", printPages: false, end: null, chapters: [
  { n: 1, title: "A", page: null, minutes: null, sections: [] }, { n: 2, title: "B", page: null, minutes: null, sections: [] }, { n: 3, title: "C", page: null, minutes: null, sections: [] },
] };

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
  const catalogue: BookLookup = { ...books, chapters: async () => ({ ...TOC, source: "catalogue", url: "https://openlibrary.org/books/OL1M", printPages: true, end: 100, chapters: TOC.chapters.map((c, i) => ({ ...c, page: (i + 1) * 10 })) }) };
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
  const boom = { find: vi.fn(async () => { throw new Error("boom"); }) };
  const { outcome } = await collect(researchMaterials({ brief, arm, fetcher, books, chapters: boom }));
  expect(outcome.materials.find((m) => m.backbone)!.toc ?? null).toBeNull();
  const refusal = { find: vi.fn(async () => { throw new APICallError({ message: "credit balance is too low", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, responseBody: "Your credit balance is too low", isRetryable: false }); }) };
  await expect(collect(researchMaterials({ brief, arm, fetcher, books, chapters: refusal, log: { keyOwner: "user" } }))).rejects.toSatisfy((e: unknown) => providerError(e)?.statusCode === 400);
});
it("defaultChapterFinder is null without a search key", () => {
  expect(defaultChapterFinder({})).toBeNull();
  expect(defaultChapterFinder({ TAVILY_API_KEY: "k" })).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ai/research/pipeline.test.ts`
Expected: FAIL, `chapters` is not a known input / `defaultChapterFinder` is not exported.

- [ ] **Step 3: Implement the input, the stage, `defaultChapterFinder`, the `research` pick and the route**

- [ ] **Step 4: Run the research tests and the type check**

Run: `npx vitest run lib/ai/research lib/ai/planDraft.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/research/pipeline.ts lib/ai/research/pipeline.test.ts lib/ai/planDraft.ts app/api/plan/draft/route.ts
git commit -m "feat(research): find the backbone's chapters on a page when the catalogue has none"
```

---

### Task 7: The progress line, the size line, and the eval field

**Files:**
- Modify: `lib/researchProgress.ts` (`ResearchLogKind`, `reduceResearch`), `components/pensieve/ResearchProgress.tsx:100-120`, `components/pensieve/MaterialsList.tsx:228-236` (`SizeLine`), `evals/research/metrics.ts` (`RunMetrics`, `runMetrics`, `ArmSummary`, `summarize`), `evals/research/README.md`
- Test: `lib/researchProgress.test.ts`, `evals/research/metrics.test.ts`

**Interfaces:**
- Consumes: `research.chapters` (Task 3), `Material.toc` (Task 1).
- Produces: `ResearchLogKind` gains `"chapters"`; the reducer pushes `{ kind: "chapters", text }` with the spec's copy: `Chapters of “{title}”: {n}, from Open Library` / `…, from {hostOf(url)}` / `No chapter list found for “{title}”; its parts will be named by topic.` In `metrics.ts`: `export function chaptersSource(materials: Material[]): "catalogue" | "page" | null` (the backbone's `toc?.source`, null without a backbone or a list); `RunMetrics.chaptersSource` set from it in `runMetrics`; `ArmSummary.chaptersFound: number | null` (share of the arm's runs whose `chaptersSource` is not null, over runs with `backboneHit !== false`; null when there are none). The `RunMetrics` literals in the existing `decide` and `decideWorkers` test fixtures gain `chaptersSource: null`.

- [ ] **Step 1: Write the failing reducer test** (in `lib/researchProgress.test.ts`)

```ts
it("logs the chapters line for a found list and for none", () => {
  const found = reduceResearch(initialResearch(0), { type: "research.chapters", id: "M1", title: "AI Engineering", chapters: 10, source: "catalogue", url: "https://openlibrary.org/books/OL1M" }, new Set());
  expect(found.log.at(-1)).toMatchObject({ kind: "chapters", text: "Chapters of “AI Engineering”: 10, from Open Library" });
  const page = reduceResearch(initialResearch(0), { type: "research.chapters", id: "M1", title: "AI Engineering", chapters: 10, source: "page", url: "https://www.example.org/review" }, new Set());
  expect(page.log.at(-1)!.text).toBe("Chapters of “AI Engineering”: 10, from example.org");
  const none = reduceResearch(initialResearch(0), { type: "research.chapters", id: "M1", title: "AI Engineering", chapters: 0, source: null }, new Set());
  expect(none.log.at(-1)!.text).toBe("No chapter list found for “AI Engineering”; its parts will be named by topic.");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/researchProgress.test.ts`
Expected: FAIL (the case returns the state unchanged, or the stub from Task 3).

- [ ] **Step 3: Implement the reducer case; render `kind: "chapters"` in `ResearchProgress.tsx` like a `verified` line (not muted, no strike-through); extend `SizeLine`**

`SizeLine`: return null only when `!m.minutes && !m.uses && !m.toc`; append `${m.toc.chapters.length} chapters` to `parts` when `m.toc`; when `m.toc`, the `title` attribute gains `; chapters from ${m.toc.source === "catalogue" ? "Open Library" : hostOf(m.toc.url) ?? "a page"}`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/researchProgress.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Write the failing metrics test** (in `evals/research/metrics.test.ts`, using its `material(...)` helper and the `run(...)` fixture of `describe("decide")`)

```ts
describe("chaptersSource", () => {
  const toc = { source: "page" as const, url: "https://www.example.org/review", printPages: false, end: null, chapters: [
    { n: 1, title: "A", page: null, minutes: null, sections: [] }, { n: 2, title: "B", page: null, minutes: null, sections: [] }, { n: 3, title: "C", page: null, minutes: null, sections: [] },
  ] };
  it("reads the backbone's list source, null without a backbone or a list", () => {
    expect(chaptersSource([material("Core", { kind: "book", backbone: true, toc }), material("Other", { toc: { ...toc, source: "catalogue" } })])).toBe("page");
    expect(chaptersSource([material("Core", { kind: "book", backbone: true })])).toBeNull();
    expect(chaptersSource([material("Other", { toc })])).toBeNull();
  });
  it("summarizes the share of runs with a source", () => {
    const runs = [{ ...run("A", 0.7, true), chaptersSource: "page" as const }, { ...run("A", 0.7, true), chaptersSource: null }, { ...run("A", 0.7, false), chaptersSource: null }];
    expect(summarize("A", runs).chaptersFound).toBe(0.5);
    expect(summarize("C", runs).chaptersFound).toBeNull();
  });
});
```

(Move `run` out of `describe("decide")` or duplicate it; add `chaptersSource: null` to both existing fixtures first so the file compiles.)

- [ ] **Step 6: Run it to verify it fails, implement, run it to verify it passes**

Run: `npx vitest run evals/research/metrics.test.ts`
Expected: FAIL on `chaptersSource`, then PASS.

- [ ] **Step 7: Add to `evals/research/README.md` a short section "Book chapters (Oct 17)"**: one paragraph saying each run now records `chaptersSource` for the backbone, that the rubric's "Materials fit" dimension should treat a chapter reference that is not in the book's list as a regression, and that the eval has not been rerun for this change.

- [ ] **Step 8: Commit**

```bash
git add lib/researchProgress.ts lib/researchProgress.test.ts components/pensieve/ResearchProgress.tsx components/pensieve/MaterialsList.tsx evals/research/metrics.ts evals/research/metrics.test.ts evals/research/README.md
git commit -m "feat(research): show where a book's chapters came from, in the progress log, the size line and the eval"
```

---

### Task 8: Whole-tree checks and the spec's status

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-book-chapters-design.md` (Status line)

- [ ] **Step 1: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all green; the suite count is 382 plus the tests this plan added.

- [ ] **Step 2: Update the spec's Status line** to "implemented YYYY-MM-DD (branch `feat/book-chapters`); live check pending the migration" and commit.

```bash
git add docs/superpowers/specs/2026-10-17-book-chapters-design.md
git commit -m "docs(spec): book chapters implemented; live check pending"
```

- [ ] **Step 3: Operator steps, not automatable** (state them in the final message, do not run them): apply `0010_source_toc` with `npx drizzle-kit migrate` from a terminal (the local database is production); then the live check from the spec's Testing section, run from this worktree's dev server on another port (`npm run dev -- -p 3001`) in the user's Chrome: draft the AI-engineering plan again and confirm the backbone's notes read `ch. 5 "Prompt Engineering"` and the like, the progress log shows the chapters line, the size line shows `10 chapters`, and a split on the saved track lists the chapters in its prompt (admin dock). If Clerk refuses the port, stop and ask.
