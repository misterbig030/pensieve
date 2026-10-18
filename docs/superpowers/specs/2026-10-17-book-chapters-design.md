# Book chapters: the outline reserves real chapters — design

**Status:** implemented 2026-10-17 (branch `feat/book-chapters`); live check pending the migration
`0010_source_toc`, which the operator applies with `npx drizzle-kit migrate`. Suite 404 passing, tsc and lint clean.
Follows the investigation in the session of 2026-10-17: a lesson prompt named "Ch. 2: Prompting strategies and best
practices" in a book whose chapter 2 is "Understanding Foundation Models" and whose prompt-engineering chapter is 5.

## Summary

Research finds a backbone textbook and records its title, author, year, a page count and a one-line *why*. Nothing
records its chapters. The outline prompt then tells the model to "reserve its chapters in order across the units
and name them in the note", so the model writes chapter numbers and titles from memory. Each lower level is told to
take its materials from what the parent reserved, so the invented range is inherited and refined, never corrected:
month "Ch. 1–3: Introduction, Prompting, RAG" → week "Ch. 1–2: Introduction and Prompting" → day "Ch. 2: Prompting
strategies and best practices". The lesson prompt prints the note as stored. In the plan that prompted this, the
model treated a ten-chapter book as seven chapters ordered like its own curriculum; every chapter reference in the
plan is off.

After this change, research looks a book's chapters up and the outline reserves what it was given. Chapters come
from the Open Library catalogue when any edition carries a table of contents, and otherwise, for the backbone only,
from a web page found by one search and read through the existing fetcher, with the research model extracting the
list. The chapter list travels with the material: on the wire while drafting, in a `sources.toc` column once saved,
rendered under the book in every prompt that lists materials. Each chapter carries its page span and the minutes
that span takes, so a unit's reading is sized from pages, not guessed. When no list can be found, the prompt says so
and forbids chapter numbers and titles: the note names the part by topic. A chapter number appears in a plan only
when code saw it in a table of contents.

## Why

- The note is the only thing that tells the learner which part of a book a unit reads, and the lesson prompt
  guides the learner "to the part named in each note". A wrong chapter sends them to the wrong pages.
- The outline needs the chapters to divide the book: how many there are, what each covers, how long each is.
  Today it has a whole-book page count and a title.
- Open Library, which the gate already queries to verify a book, returns a table of contents on some editions:
  heading, nesting level and page number per entry. For the book in question, the 2024 edition carries all ten
  chapters with their sections and pages. Coverage is thin, though: of eight well-known textbooks spot-checked,
  one had a table of contents on any edition. So the catalogue is the first source, not the only one.
- Publisher pages cannot be the second source directly: O'Reilly answers plain fetches with a bot-block 403, and
  Manning loads its chapter list by script. The app's fetcher is an HTTP fetch with HTML extraction, not a
  rendering browser. A web search finds pages that do carry the list in static HTML (reviews, syllabi, author
  pages, retailer listings), and the research model can read a chapter list out of a page it is given.

## Decisions

1. **Chapters come from a catalogue first, a page second, never from the model's memory.** Open Library editions
   are tried first. If none has a usable table of contents, one web search for the book's table of contents, up to
   three page reads, and one structured model call extract the list; the model must name the URL it read it from,
   and that URL must be one of the pages fetched in this step. A list the model cannot source is discarded.
2. **The catalogue lookup runs for every verified book; the page fallback runs for the backbone only.** The
   catalogue costs one request per book. The fallback costs a search, fetches and a model call, and only the
   backbone's chapters are reserved across units.
3. **Without a list, no chapter numbers.** When a book has no chapter list, the prompt tells the model so and
   forbids chapter numbers and chapter titles for it; the note names the part by topic ("the chapters on
   evaluation"). This is the floor under everything else.
4. **The list is data on the material.** `Material.toc` on the wire, `sources.toc` in the database. Drafting
   happens before anything is saved and reads the wire shape; expand, split, chat and revision read the saved
   row. One shape, rendered by one function, so every prompt sees the same chapters.
5. **Chapters and sections, not subsections.** A chapter keeps its number, title, start page and the headings one
   level below it. Deeper levels are dropped. Front and back matter are not chapters, but their page positions
   bound the last chapter. Caps: 40 chapters, 12 sections per chapter, 120 characters per heading.
6. **Sizes are shares of the book.** A table of contents gives each chapter a start position. The positions are
   not always print pages: the record for the book in question runs to position 1094 in an edition of 350 pages,
   so they are e-book positions. They are therefore used as proportions only. A chapter's span is the positions
   from its start to the next chapter's start, or to the first back-matter entry after the last chapter, or to the
   edition's page count; when nothing bounds the last chapter, it gets the mean span of the others, so every chapter
   has a size. A chapter's size is its span's share of the whole span, applied to the book's own size
   (`Material.minutes`, whatever its basis). Print page ranges are shown only when the last position fits the
   edition's page count. A list from a page has no positions, so its chapters have no sizes; the model estimates
   as it does today. The whole-book size is unchanged.
7. **The chapters model call is an ordinary logged call.** It runs on the research model at the candidate step's
   effort, writes a `generation_log` row with caller `research`, and reaches the admin dock like every other call.
8. **No backfill.** Saved plans keep their notes. The re-verification on confirm does not look chapters up. A
   plan drafted again gets chapters; a "find chapters" action on the materials list is a follow-up.

## Architecture

```
candidate step ─► gate ──────────────────────────► backbone chosen ─► chapters stage ─► research.done
                   │ for each matched book:            │                   │
                   │ books.chapters(match)             │                   │ backbone has no toc?
                   │   → toc { source: "catalogue" }   │                   │ finder.find(backbone)
                   │                                   │                   │   search → read ≤3 → model → toc { source: "page" }
                   ▼                                   ▼                   ▼
            Material.toc ─────────────────────► renderMaterials ─► units / revision / chat prompts
                   │
                   ▼ (confirm)
            sources.toc ─► sourceToMaterial ─► the same prompts on saved tracks
```

The gate gains one call per matched book. The pipeline gains one stage between the gate and `research.done`. The
prompt builders gain chapter lines under each book that has them and a rule that depends on whether the backbone
has them. Nothing else moves.

## Data model

### `ChapterList`

```ts
/** One chapter as a table of contents lists it. `n` is null when the heading carries no number. */
export interface Chapter {
  n: number | null;
  title: string;
  /** Start position as the list gives it (a print page only when `ChapterList.printPages`); null without positions. */
  page: number | null;
  /** This chapter's share of the whole span, applied to the book's size; null without positions or a book size. */
  minutes: number | null;
  /** Headings one level below the chapter, in order. */
  sections: string[];
}

export interface ChapterList {
  /** Where the list came from. */
  source: "catalogue" | "page";
  /** The edition on Open Library, or the page the model read the list from. */
  url: string;
  /** True when the positions fit the edition's page count, so they can be shown as `pp.` ranges. */
  printPages: boolean;
  /** The position after the last chapter: the first back-matter entry, else the edition's page count; null when unknown or without positions. */
  end: number | null;
  chapters: Chapter[];
}
```

Zod schema `chapterListSchema` in `lib/schemas/material.ts`, with the caps of decision 5 and `MIN_CHAPTERS = 3`.
`materialSchema` gains `toc: chapterListSchema.nullable().optional()`. The signature does not cover `toc`: it only
shapes prompts, which the learner's own instructions already do.

### `sources.toc`

| Column | Type | Notes |
|---|---|---|
| `toc` | jsonb `ChapterList`, null | Null for every row today, for books with no list found, and for every non-book. |

Migration `0010_source_toc.sql`, one added column. `sourceToMaterial` and `materialsToRows` copy it through.

## The research step

### Catalogue (`lib/ai/research/chapters.ts`, `verify.ts`)

`BookLookup` gains `chapters(match: BookMatch, signal?: AbortSignal): Promise<ChapterList | null>`. The Open
Library implementation fetches `https://openlibrary.org{match.key}/editions.json?limit=50` with the same user agent
and 5 s timeout as the search, and returns null on any failure: chapters are optional, so no
`BookLookupUnavailable` here. It parses each edition's `table_of_contents` with `parseOpenLibraryToc`, and returns
the longest usable list, with `url` the edition's page (`https://openlibrary.org{edition.key}`).

`parseOpenLibraryToc(entries, numberOfPages)` is tolerant, because the records are not uniform:

- An entry is an object or a string. Objects seen in the wild: `{ level, label, title, type }` with the heading in
  `label` and the page in `title`; `{ level, label, pagenum, title }` with the page in `pagenum`; `{ level,
  pagenum, title }` with the heading in `title`. The heading is `label` when present, else `title`; the page is
  `pagenum` when numeric, else `title` when `label` is present and `title` is numeric. A string entry is split on
  `|` into heading and page.
- Level 1 entries are chapters; level 2 under a chapter are its sections. When the level 1 headings are parts
  (`/^part\b/i`), chapters are level 2 and sections level 3.
- A heading is matter, not a chapter, when it matches `/^(preface|foreword|acknowledg|about the|index|glossary|
  bibliography|references|notes|epilogue|afterword|appendix|colophon|contents|dedication|copyright)/i`. Matter
  before the first chapter is dropped; the first matter entry after the last chapter bounds its span.
- A chapter's number is the leading integer of its heading (`5. Prompt Engineering`, `Chapter 5`, `5 Prompt
  Engineering`), stripped from the title; null when there is none.
- Sections are the headings one level below a chapter, minus those that say nothing about its subject
  (`Summary`, `Exercises`, `Conclusion`, `Further reading`, `Key takeaways`, `Review questions`). Headings below
  the level of sections, and sections before the first chapter, are dropped.
- Fewer than `MIN_CHAPTERS` chapters, or positions that do not increase, make the edition's list unusable.
- The parser records positions and `printPages` (the last position, or the first back-matter position after the
  last chapter, is at most 1.1 × the edition's `number_of_pages`); it leaves `minutes` null.

In the gate, `bookChecks` calls `books.chapters(match)` for every matched book under the same concurrency of 4.
When the material is accepted and sized, `withChapterSizes(toc, material.minutes)` fills each chapter's `minutes`
as its share of the span (null when the book has no size), and the material carries the result as `toc`. The gate
emits `research.chapters` for each material that has one, beside its `research.verified` event.

### Page fallback (`lib/ai/research/chapters.ts`, `pipeline.ts`)

```ts
export interface ChapterFinder {
  find(book: Material, ctx: { fetcher: SourceFetcher; emit: (e: ResearchEvent) => void; signal?: AbortSignal; log?: GenerationLogContext }):
    Promise<{ toc: ChapterList | null; counts: ResearchCounts; costUsd: number }>;
}
export function createChapterFinder(options: { provider: SearchProvider; model?: AiModelId | LanguageModel }): ChapterFinder;
/** Null when TAVILY_API_KEY is unset, like defaultArm. */
export function defaultChapterFinder(env?, options?: { model? }): ChapterFinder | null;
```

`ResearchMaterialsInput` gains `chapters?: ChapterFinder`, and `StreamResearchedDraftInput.research` picks it
through like `fetcher` and `books`. The draft route builds it next to `defaultArm` with the same provider and
model. After the gate, when the backbone exists and has no `toc` and a finder was given, the pipeline runs the
finder inside `streamWhile` so its events stream, attaches the result, adds its counts to `counts` and its cost to
the outcome's `costUsd`, and emits `research.chapters` for the backbone whether or not a list was found.

What `find` does, in order, under a 20 s wall clock and without touching the arm's budget:

1. One search: `${mainTitle(book.title)} ${book.author ?? ""} table of contents`, 5 results. Emits
   `research.search`. A `SearchProviderError` ends the step with null.
2. Keeps https results not on `openlibrary.org`, in search order, and reads up to three through the shared
   `SourceFetcher` (cached, guarded, 2 MB, 16k characters of text), emitting `research.reading` and
   `research.fetch` as the gate does. A page that fails to open is skipped and does not count against the three.
3. One `loggedGenerateObject` call, label `Research · chapters`, caller `research`, effort
   `CANDIDATE_STEP_EFFORT`, facts: the URLs read. Prompt: the book's title and author, then each page as
   `--- {url} ---` followed by its text clipped to 8,000 characters, then the ask: list the book's chapters as the
   page gives them, in order, with the headings under each chapter when the page shows them; set `url` to the one
   page the list came from; return `found: false` when no page shows the book's chapter list. Schema:
   `{ found: boolean; url: string | null; chapters: { n: number | null; title: string; sections: string[] }[] }`.
   Retried once on a schema failure, as the candidate step is. A provider refusal on the user's own key is
   rethrown, as everywhere in research.
4. Validation in code: `found`, `url` canonicalises to one of the pages read, at least `MIN_CHAPTERS` chapters,
   numbers strictly increasing where present, caps applied. Anything else is null. The result carries
   `source: "page"`, `printPages: false`, `end: null`, and `page: null` and `minutes: null` on every chapter.

### Events (`events.ts`)

```ts
| { type: "research.chapters"; id: string; title: string; chapters: number; source: "catalogue" | "page" | null; url?: string }
```

`chapters: 0, source: null` is the backbone for which nothing was found.

## Prompt changes (`lib/ai/planPrompt.ts`)

### Rendering

`renderMaterials(materials, aliases, options: { sections?: boolean } = {})` prints, under a book with a `toc`, one
indented line per chapter:

```
M1 [book · backbone] "AI Engineering: Building Applications with Foundation Models" — Chip Huyen, 2024 <https://openlibrary.org/works/OL39671094W> · skip or skim the finetuning and dataset engineering chapters, about 18.4 h (estimated). Covers building on …
  ch. 1 "Introduction to Building AI Applications with Foundation Models" · about 1.8 h
  ch. 2 "Understanding Foundation Models" · about 2.3 h — Training Data; Modeling; Post-Training; Sampling
  …
  ch. 10 "AI Engineering Architecture and User Feedback" · about 1.6 h — …
  (chapters from Open Library)
```

The sizes are each chapter's share of the book's 1105 minutes. `ch. N` is omitted when `n` is null; the size is
omitted when `minutes` is null; `pp. 453–540` is added after the title only when `printPages` is true; the
`— sections` tail is printed only with `sections: true`, which `buildUnitsPrompt` and `buildRevisionPrompt` pass
for the backbone and no one passes for other books. The chat system prompt passes nothing: chapter lines without
sections. The last line names the source: `(chapters from Open Library)` or `(chapters from {host})`.

### Rules

`headingMaterialRules`, backbone with a list:

> M1 is the backbone textbook and its chapters are listed above: reserve them in order across the units, each
> chapter in exactly one unit, and write the note as the chapter numbers and titles exactly as listed ("ch. 5–6:
> Prompt Engineering; RAG and Agents").

Backbone without a list:

> M1 is the backbone textbook, but its chapters are not listed: reserve it in order across the units and name each
> unit's part by topic ("the chapters on evaluation"). Never write a chapter number or a chapter title you were not
> given.

`leafMaterialRules`, backbone with a list:

> M1 is the backbone textbook and its chapters are listed above with their sizes: they run in order across the
> units, continuing from where earlier units stopped. Name the chapter in the note by number and title as listed,
> and the sections when a chapter spans several units. A unit's minutes for it are the listed size of what it
> reads, or that share of a chapter.

Backbone without a list:

> M1 is the backbone textbook, but its chapters are not listed: it runs in order across the units, continuing from
> where earlier units stopped. Name each unit's part by topic ("the chapters on evaluation"). Never write a chapter
> number or a chapter title you were not given.

And one line for every prompt that lists materials, whenever any book is on the list:

> Where a book's chapters are listed, name them as listed. Where they are not, name the part by topic and never
> invent a chapter number.

The existing size rule ("a material's minutes should add up to about that size") stays. The lesson prompt
(`dailyContent.ts`) is unchanged: it prints the note, which is now right.

## Streaming and UI

- **Research progress** (`lib/researchProgress.ts`, `ResearchProgress.tsx`): `research.chapters` adds a log line.
  Copy: `Chapters of “AI Engineering”: 10, from Open Library` / `…, from oreilly.com` / `No chapter list found for
  “AI Engineering”; its parts will be named by topic.` The fallback's search and reads appear through the existing
  `research.search` / `research.reading` / `research.fetch` lines.
- **Materials list** (`MaterialsList.tsx`): the size line of a book with a `toc` gains `· 10 chapters`, with a
  title attribute naming the source. No expanded chapter view in this version.
- **Admin dock**: the `Research · chapters` call appears on its own, through the existing capture.

## Failure handling

Nothing in this change fails a draft. The editions request failing, timing out or returning no usable list leaves
`toc` null and, for the backbone, hands over to the finder. The finder's search failing, every page failing to
open, the model call failing twice, or validation rejecting the answer all end with null and the
`research.chapters` event saying nothing was found; the outline then runs under the no-list rule. The one
exception is the existing one: a provider refusal on the user's own key is rethrown so the request stops with the
message that says why.

## Testing

Vitest, node environment, as the rest of research.

- `chapters.test.ts`: `parseOpenLibraryToc` on the three object shapes and the string shape; parts shifting the
  levels; matter dropped before and bounding after; numbers parsed and stripped; unnumbered chapters keep `n:
  null`; fewer than three chapters or non-increasing positions → unusable; `printPages` true for positions within
  the page count and false for the 1094-in-350-pages record; caps on chapters, sections and heading length.
  `withChapterSizes`: shares of the span applied to the book's minutes, the last chapter bounded by the first
  back-matter position, else by the page count; null minutes when the book has no size or the list no positions.
- `chapters.test.ts`, the finder with a fake provider, fetcher and model: skips `openlibrary.org` and http
  results; reads at most three pages that opened; the prompt carries each page under its URL; a `url` not among
  the pages read → null; `found: false` → null; fewer than three chapters → null; the result has `source: "page"`
  and no sizes; counts and cost reported; a provider refusal on `keyOwner: "user"` is rethrown.
- `verify.test.ts`: a matched book gets its catalogue list and the gate emits `research.chapters`; `chapters`
  throwing leaves `toc` null and the book verified.
- A new `lib/ai/research/pipeline.test.ts` (today `researchMaterials` is exercised from `agent.test.ts` and
  `workers.test.ts`): the finder runs only when the backbone has no `toc`; its counts and cost are added; the
  event is emitted for found and not found; no finder → no call.
- `planPrompt.test.ts`: chapter lines rendered with and without numbers, pages and sections; the source line;
  the backbone rule text with and without a list; the general line present whenever a book is listed.
- `lib/db/materials.test.ts`: `toc` survives `materialsToRows` → `sourceToMaterial`.
- Schema: `materialSchema` accepts a list at the caps and rejects one over them.
- Live check, in Chrome against the local app: draft the AI-engineering plan again and confirm the backbone's
  notes read `ch. 5 "Prompt Engineering"` and the like, the progress log shows the chapters line, the size line
  shows `10 chapters`, and a saved track's split-into-days prompt lists the chapters. The research eval
  (`evals/research`) gains a `chaptersSource` field per run and a rubric note that chapter references must match
  the list; running it costs money and is the operator's to trigger.

## Files

- Create: `lib/ai/research/chapters.ts`, `lib/ai/research/chapters.test.ts`, `lib/ai/research/pipeline.test.ts`,
  `drizzle/0010_source_toc.sql`.
- Modify: `lib/schemas/material.ts` (schema, caps), `lib/db/schema.ts` (`sources.toc`), `lib/db/queries.ts`
  (both mappers), `lib/ai/research/verify.ts` (`BookLookup.chapters`, the gate), `lib/ai/research/pipeline.ts`
  (the stage, `defaultChapterFinder`), `lib/ai/research/events.ts`, `lib/ai/planDraft.ts`
  (`StreamResearchedDraftInput.research`), `app/api/plan/draft/route.ts` (builds the finder beside `defaultArm`),
  `lib/ai/planPrompt.ts` (rendering, rules), `lib/researchProgress.ts`, `components/pensieve/ResearchProgress.tsx`,
  `components/pensieve/MaterialsList.tsx`, `evals/research/metrics.ts` and `README.md` (the field and the note).
  `evals/research/compare.ts` and `effort-bench.ts` pass no finder and are unaffected.

## Sequencing

1. Schema and data: `ChapterList`, `materialSchema.toc`, the column, the migration, the two mappers.
2. Catalogue: parser, `BookLookup.chapters`, the gate, the event.
3. Prompt: rendering and rules. At this point a catalogue-listed book already gets real chapters end to end.
4. Fallback: the finder, the pipeline stage, `defaultChapterFinder`, the route.
5. UI: progress line, size line. Eval field. Live check.

## Out of scope

- Looking chapters up for saved plans, on confirm or on demand.
- Passing a chapter's sections to the lesson prompt.
- Computing the used part's size from `uses` and the chapter list.
- A rendering browser for publisher pages.
- Chapters for non-book kinds (course lecture lists, playlist entries).

## Open items

- Open Library's `editions.json` may page past 50 editions for very popular works; the first page is taken.
- The matter regex and the parts rule are heuristics from a handful of records. The first live runs on other
  books will say whether "Introduction" as an unnumbered first entry should count as a chapter (it does here).
- Whether the chat prompt, on Haiku, should see chapter lines at all for latency. The lines are about 400 tokens
  for a ten-chapter book; the first live check decides.
