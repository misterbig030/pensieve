# Structure finder: research measures, the allocation sizes, the outline picks

Status: draft for approval. Changes the steps between the gate and the end of the top-level outline. Builds on
`2026-10-22-extract-then-allocate-design.md` and `2026-10-23-practice-item-lists-design.md` (both merged).

Diagram of the proposed pipeline: https://claude.ai/artifact/27TFy5bJpJHWHDmkUBjYTy (today's, for comparison:
https://claude.ai/artifact/FNGedoyjZiTv3jYdfJ7g5K).

## Why

The SDE interview draft of 26 Oct (`model-calls-2026-10-26T19-39-46-112Z.json`) lost *system-design-primer*, one of the
best sources for system design. It was not dropped because it was weak. Every stage lacked a fact that only a later
stage needed:

1. **The worker** saw only the first 16,000 characters of the README (`MAX_TEXT_CHARS`), and its notes summed the
   table of contents up rather than keeping it.
2. **The candidates step** wrote "about 8 h" for it. The gate had read the README and counted 11,469 words, which is
   about 50 minutes, but the gate measures only essays, videos and books, so the estimate stood.
3. **The allocation** saw one line, "reading about 8 h (estimated)", kept 180 minutes and gave no reason for that
   number. It had no way to know the README is 30 sections or to choose among them.
4. **The outline** has to place every resource except the backbone in at most one week. 180 minutes did not fit in
   one week's 90 minutes of reading, so the check failed, the silent retry ran (29 s) and failed in the same way, and
   the primer was dropped from the plan.

The same thing happens to any long source that isn't a catalogued book: a docs site, a course, a hub repo whose README
links to one folder per week (`severilov/DL-Audio-AIMasters-Course`, `datawhalechina/zero-to-sglang`). Today such a
source has no parts, so the plan can only take all of it in one week or leave it out.

The owner agreed in conversation that each stage should do one job:

- **Research** records what each source is and measures its real structure and size.
- **The allocation** decides which sources to keep, how much time each gets and what for. It has no tools and doesn't
  read sources, so research's account of each source must be complete enough to decide from.
- **The outline** picks the actual chapters, sections or files that meet each budget and places them in weeks. That
  needs the table of contents, so it is the outline's job, not the allocation's.

Sources come in every shape (a book, a GitHub README, a hub of sub-READMEs, a blog with headings, a course site), so
code can't reliably decide their parts alone. A model decides the parts, with tools that measure. Code checks every
title and size it returns, so the model can't invent a section or a size.

## Goals

1. **The gate measures every page it fetches**, not only essays, videos and books.
2. **A structure finder runs for each source that needs one** and returns its units: chapters, sections, linked files,
   lectures or labs. A unit's minutes come from tool measurements, not from the model. It replaces the chapter finder
   and the item finder.
3. **Code checks every unit** against what the tools fetched before the units are saved. A list that fails is refused
   and the source stays whole, as today.
4. **The allocation sees measured sizes and unit lists**, and decides keep or drop, a minute budget and its purpose,
   the backbone and the practice formats. It no longer chooses chapters.
5. **The outline picks units to meet each budget** and spreads a source's units over consecutive weeks. The rule that
   a resource fits in one week applies only to a source that has no units.
6. **A new check holds the outline to the budgets:** the units it reserves for a material add up to about that
   material's budget.

## Non-goals

- Changing the research workers, their budgets or the candidates step.
- Changing how practice item lists are cut (see call 1) or how the app shares out runs of items.
- Changing the day level beyond showing a unit's own link.
- Re-drafting saved plans. Saved materials keep their cut chapter lists, minutes and parts as saved.

## Anti-goals

- **No invented structure.** A unit title that doesn't appear on a fetched page, or a size the tools didn't measure
  (where there was something to measure), must never reach the allocation or the plan.
- **No steering numbers in prompts.** As in the parent designs: no target shares, ranges, floors or worked examples.
  The allocation's budgets are its own judgement. The check's slack (below) is used in code only, never told to the
  model as a target.
- **The allocation doesn't get tools** and doesn't read sources.
- **The learner's own materials are never dropped**, as today.
- **A failed or slow finder never fails the draft.** The source stays whole and the draft goes on.

## The flow

```
workers ──► candidates ──► GATE ──► STRUCTURE FINDERS ──► CHECK UNITS ──► ALLOCATE ──► READING SHARE ──► OUTLINE ──► checks
 (as today)  (as today)    measures  one per source,       code             budgets +     code                picks units
                           every     Sonnet + code tools                    purposes                          into weeks
                           page
```

### 1. Gate: measure every page (`runGate`, `sizeMaterial`)

- Every fetched page gets a **page size** from code: words ÷ `WORDS_PER_MINUTE`, a video's runtime, or a book's
  catalogue pages × `MINUTES_PER_PAGE`, as today. It is recorded on the material as `pageMinutes` (new, optional).
- The page size becomes the material's size (`minutes`, basis `measured`) only when the page **is** the work: an
  essay or paper as today, and now a `repo` whose README has at least `MIN_MEASURED_WORDS` and isn't a hub. A **hub** is
  a page that links to at least `HUB_MIN_LINKS` pages on the same site or repository. Links are counted on the whole
  body, nav included, because a docs site's sidebar is what makes it a hub.
- For every other kind (course, docs, tool, an unmatched book's page), a hub, or a page the reader couldn't measure, the
  candidates step's estimate stays as the size. The page size is kept beside it and both are shown to the allocation.
  A short landing page must never shrink a course to its intro's minutes.
- Nothing else about the gate changes.

For the primer, this alone turns "about 8 h (estimated)" into "50 min (measured)".

### 2. Structure finder (new, `lib/ai/research/structureFinder.ts`)

**Which sources.** After the gate, a finder runs for each verified source that needs one:

- a book with no catalogue contents;
- a practice source counted by item that has no list yet (today's `likelyItemLists` rule, without the bar on sources
  that already have chapters);
- other reading that is a hub, or whose size is at least `STRUCTURE_MIN_MINUTES`. The size used here is the larger of
  the page size and the estimate.

At most `MAX_STRUCTURE_FINDERS`, in this order: the learner's own; books by recommending domains (as
`likelyBackbones`); practice sources by practice time; the rest by size. All run in parallel through the shared
fetcher.

**What it is.** One Sonnet 5.5 call per source with tools (`STRUCTURE_EFFORT`, medium), at most `STRUCTURE_STEPS`
steps and `STRUCTURE_WALL_MS` of wall clock, outside the research workers' budget. It sees the material's line
(title, kind, URL, why, page size) and is asked for the source's units in the source's own order, what each is, and a
one-line note on how the source is organised and what it is best for.

**Its tools (code).** The model decides; the tools measure.

- `outline(url)`: fetches a page (cached) and returns its heading tree: each heading with its level, anchor, the words
  under it (to the next heading of the same or higher level) and the links under it (URL and link text). It also
  returns the page's total words, its runtime for a video and its page count for a PDF. It reads the whole body
  (`MAX_BODY_BYTES`), not the 16,000-character cut. A GitHub repository or folder URL returns its rendered README.
- `measure(urls)`: fetches up to `MEASURE_BATCH` pages at once and returns each one's size (words, runtime or pages),
  title and top-level headings. Used for a hub's linked files.
- `search(query)`: for a book's table of contents or a practice source's list only, at most `STRUCTURE_SEARCHES`
  per finder (today's chapter finder and item finder searches).
- `items(url)`: runs today's item-list reading on that URL: a full read or a data file, its own model calls (field
  mapping, transcription) on their own clocks (`ITEM_*_MS`, `ITEM_ANSWER_MS`), then `validateItemList`. The finder
  chooses the URL; the reading code is reused, not rewritten. Time spent inside `items` doesn't count against
  `STRUCTURE_WALL_MS`, so practice lists keep the time they have today.

**Its answer.**

```
{ note: string,                       // one line: how the source is organised, what it's best for
  whole: boolean,                     // true when the source has no useful parts
  units: [{ title, at,                // at: a fetched URL, or URL#anchor of a heading on one
            kind: "read" | "practice",
            group: string | null,     // the heading or folder it sits under, for grouping
            minutes: number | null }] // only for a unit the tools couldn't measure (slides, a lecture video with no runtime)
  listUrl: string | null }            // the practice list `items` returned, if any
```

A unit is the smallest part the plan should be able to place on its own: a chapter, a README section, a linked file or
folder, a lecture, a lab. If a source has more units than `MAX_CHAPTERS`, the finder uses the next level up.

What it is asked for depends on the source's role:

- **Reading only:** reading units.
- **Practice only** (no reading time today): practice units only. Its README's sections are not reading, so a practice
  source never starts counting toward the reading share.
- **Both:** both kinds.

A source with a practice role and no list from `items` has its practice units (labs, exercise sets) saved as its item
list, checked like reading units (title on a fetched page or in a link to it). Practice units on a source with no
practice role are discarded.

### 3. Check units (new, code)

Runs on each finder's answer before anything is saved. It is pure code, with no model call.

- **Every unit points to something fetched.** `at` must be a page one of the finder's tools returned, or a heading
  anchor on one (canonical URL match, as `validateChaptersAnswer` does today).
- **Every title is real.** The title must appear, as normalised text, among that page's headings, in the link text
  that points to it, or in the rest of the table row or list item that link sits in (a question beside its
  "Solution" link). A unit that doesn't is dropped. If more than `MAX_UNSEEN_SHARE` (10%) of units are dropped this
  way, the whole list is refused.
- **Sizes come from the tools.** A heading unit's minutes are the words under it ÷ `WORDS_PER_MINUTE`. A linked unit's
  are its page's measured size. A model `minutes` is kept only for a unit whose target couldn't be measured, and the
  unit is marked estimated. Any other number the model wrote is ignored.
- **A linked page that's mostly links counts as unmeasured.** A linked page under `MIN_MEASURED_WORDS` that isn't a
  video is unmeasured: for example, a week folder whose README only links its slides, notebooks and recordings. Its
  unit keeps the model's estimate, marked estimated, so DL-Audio's weeks aren't sized at one minute each.
- **The units cover the source.** For heading units on one page, their words must add up to at least
  `MIN_UNIT_COVERAGE` (70%) of the page's words. Otherwise the list is refused.
- **Sane shape.** Between `MIN_CHAPTERS` and `MAX_CHAPTERS` reading units, in page order, with no unit repeated. Practice
  items are checked by `validateItemList`, as today.
- **Books are checked as today's chapter finder checks them.** A table of contents page lists chapters, often as plain
  list items, and a chapter's text isn't on the page. So for a book:
  - a title only has to appear in the page's text (`validateChaptersAnswer` plus the title match above);
  - the coverage rule is skipped;
  - chapter minutes are shared out of the book's catalogue size (as `withChapterSizes` does), or left null when the
    book has none;
  - the book keeps its catalogue size rather than the sum of its chapters.

**When it passes:**

- Reading units are saved as the material's `toc`, with `source: "page"` and the source page as `url`. Each chapter
  gets `n: null`, `title`, `minutes`, `sections` (sub-headings, as today) and two new optional fields: `url` (where
  the unit is, when it isn't the source page itself) and `group`.
- The material's size becomes the sum of its reading units (a book keeps its catalogue size, below). Its basis is `measured` when every unit was measured, and
  `estimated` otherwise.
- Practice items are saved as `practice.list` (via `withItemList`, as today).
- The finder's `note` is kept with the material for the allocation prompt. It is not saved.

**When it fails:** the material gets no list and stays whole, as every non-book source is today. The reason is a fact
on the finder's call in the call log (`units refused: 4 of 22 titles not on the page`).

### 4. Allocation (`lib/ai/allocate.ts`)

**What it sees, per material:**

- The size with its basis. For a hub without units: the page size and the estimate, both labelled.
- The finder's note.
- The reading units grouped by `group`, each with its minutes and the group's total. No positions are shown: the
  allocation doesn't choose units.
- Everything it sees today: kind, origin, why, found by, book evidence, practice role, practice groups.

The primer would read:

```
M2 [repo] "system-design-primer" · reading 50 min (measured, 30 sections). Note: the README is the whole guide …
  building blocks — 18 sections, 41 min: Performance vs scalability (3 min) · Load balancer (3 min) · Cache (5 min) · …
  interview method — 4 sections, 6 min: How to approach a question (2 min) · Study guide (2 min) · …
```

**What it decides, per material (the `parts` schema):** `{ id, drop, dropReason, minutes, purpose }` for reading, with
the practice fields as today.

- `minutes` is the reading budget. Null means the whole material.
- `purpose` says what the plan uses this material for, in a few words ("building blocks for the design rounds").
- The `chapters` field goes. The allocation no longer picks chapter positions.
- Practice fields (`groups`, `itemRange`, `items`) stay as they are (call 1).
- `backbone`, `picks`, `coverage`, `reason`, `practice` and the prompt's "what to weigh" are unchanged, except that the
  instructions on chapter positions become instructions on budgets and purposes.

**After the call (code, `readingPart`):**

- The budget is capped at the material's size, so the allocation can't keep 3 hours of a 50-minute README. The cap
  uses only a size whose basis is `measured` or that is a sum of units. An estimate is not a cap, because estimates are
  what went wrong. A material with no known size keeps the budget as an estimate, as today.
- The learner's own materials get budgets like any other (the allocation may use part of one). A material with no
  `parts` entry keeps its whole size as its budget.
- The material's `minutes` becomes the budget and `uses` becomes the purpose.
- The `toc` is no longer cut: the outline needs every unit to choose from.

**Reading share:** worked out as today (`readingShareOf` over the kept reading), now from the budgets. Practice gets
the rest, shared by the picks as today.

### 5. Outline (`lib/ai/planPrompt.ts`)

**The material list** shows, for each kept material with units, its budget and purpose, then its units as aliases
(`M2.1`, `M2.2`, …) with their minutes, grouped. This works today for chapters through `aliasMaterials`.

**Heading levels (`headingMaterialRules`).** The backbone's chapter rule becomes the rule for every material with
units:

- A material with units is reserved by its units (`M2.3`), never as a whole.
- Choose the units that serve its purpose and add up to about its budget.
- Reserve them in order across consecutive units at this level, each in exactly one.
- The backbone's units run in order through the plan, as today.

A material without units keeps today's rule, with one change: if its budget is more than one unit's reading time, it
may span consecutive units at this level, with the part named in each unit's note. A book without a chapter list
(`byTopic`) is handled this way today. It removes the forced retry when a finder fails.

In the checks, the span is held in code, not only in the prompt:

- Only a material whose budget is over one unit's reading time may span.
- It may span only units that are consecutive at that level.
- Each row counts its budget ÷ the number of units it spans toward `over-budget`.
- A repeat that skips a unit, or a span by a material too small to need one, is still an `overlap` breach.

`byTopic` books keep today's handling.

**Leaf levels (`leafMaterialRules`):** unchanged. A reserved unit is read like a chapter: a long one spans consecutive
days with the part in the note.

### 6. Checks (`lib/materials.ts`, `levelChecks`)

- **New breach `budget-miss`,** at the level that first reserves reading (the top level). For each kept material with
  units, the units reserved across the level add up to its budget within `BUDGET_SLACK`: 20% of the budget or
  15 minutes, whichever is larger. A miss names the material, its budget and what was reserved. It is quoted in the
  silent retry. It isn't droppable: no row can be removed to cure it. After the retry, it is a fact. A kept material
  with units and none reserved is a miss too.
- **`whole-book` generalised:** reserving a material that has units as a whole is a breach, for any material, not only
  the backbone. It stays droppable.
- **`knownMinutes`:** a unit's minutes come from its `toc` entry, as chapters' do today. A unitless material reserved
  across units by topic counts 0 per row, as `byTopic` books do today.
- `outside`, `overlap`, `over-budget` and the practice checks are unchanged. They already work on chapter keys.

### 7. Fallbacks

- **A finder that throws, times out or is refused:** the source stays whole with its page size or estimate. The draft
  goes on.
- **No search provider:** finders that need `search` skip it. The others run, because `outline` and `measure` only
  fetch.
- **Allocation fails:** today's code-only chooser. Budgets equal each kept material's whole size, and its purpose is
  null.
- **Too little time left:** the structure stage is skipped (sources stay whole) when the time left at its start is
  less than `STRUCTURE_WALL_MS + STRUCTURE_ALLOCATE_MIN_MS (30 s) + OUTLINE_RESERVE_MS`, which is 160 s. Research took
  59 s on both reference runs, which leaves 226 s, so the stage runs unless research takes over 125 s. It is also
  ended early, with the finders done so far kept, when finishing it would leave less than that.
  `researchMaterials` gets the draft's deadline as a new input to do this.

### 8. Saved data

No migration. `toc` and `practice` are `jsonb`, and the new chapter fields (`url`, `group`) are optional. `pageMinutes`
is used during the draft and not saved. A saved material's `minutes` is its budget and `uses` its purpose, which is
what they mean today ("the part the plan uses"). Saved plans with cut chapter lists read exactly as before.

### 9. Events, call log, UI

- The `research.chapters` and `research.items` events are replaced by one `research.structure` event:
  `{ id, title, units, items, refused? }`. The research feed shows "Found 30 sections in system-design-primer".
- Each finder is a logged call, labelled `Research · structure`. Its facts list the tools it called, the units kept,
  and any refusal with its reason.
- On a day card, a unit that has its own `url` links there rather than to the source's front page.

## Timing

The 26 Oct run: research 59 s (candidates 11 s), allocation 16 s, outline 33 s plus a 29 s retry, days 44 s. Finders
run in parallel and are bounded by `STRUCTURE_WALL_MS`. A typical stage is expected at 20–40 s. The retry it removes
saved about 30 s, so the total should stay close to today and well inside `DRAFT_BUDGET_MS`.

## Constraints

- The local `DATABASE_URL` is production. No migration is expected. If the builder finds one is needed, stop and ask.
- No paid eval runs without the owner's go-ahead. One live SDE-interview draft on the builder's own dev server (3001)
  is the final check: the primer kept with sections spread over weeks, and no `budget-miss` after the retry.
- Tests: vitest, node environment. Each code rule above gets a unit test:
  - page sizing and hub detection;
  - the `outline` tool's heading tree and per-heading word counts (fixtures: a GitHub README, a hub README, a blog with
    headings, a book TOC page);
  - every Check-units rule, including refusal;
  - the budget cap in `readingPart`;
  - `budget-miss` and the generalised `whole-book`;
  - the unitless-span rule.

  Prompt tests check that the allocation prompt carries no unit positions and no target numbers, and that the outline
  prompt carries budgets and unit aliases.

## Decided in conversation

- Research records and measures. The allocation decides keep or drop, how much and what for, with no tools. The outline
  picks units and weeks.
- The allocation doesn't read sources; it sees measured sizes and unit lists.
- Structure is found by a sub-agent per source with code tools, because sources come in any shape. Every title and size
  it returns is checked in code.
- One finder replaces the chapter finder and the item finder. A source may have both reading units and practice items.

## Calls made by the author

Each is the author's call, for the owner to check while reading.

1. **Practice lists keep today's split.** The allocation still chooses a listed practice source's groups and range, and
   the app shares the kept items out in runs. The outline never sees item titles, and runs are already placed by code,
   so moving this choice to the outline would mean a new practice design. It can follow later.
2. **The budget check's slack** is 20% or 15 minutes, whichever is larger. Units are whole pieces, so an exact match
   is rarely possible.
3. **A source with both units and items** aliases its items with an `i` (`M4.i12`). Its units keep `M4.3`. Sources
   with items only keep `M4.12`, as today.
4. **Constants to start from:** `STRUCTURE_MIN_MINUTES` 90, `HUB_MIN_LINKS` 6, `MAX_STRUCTURE_FINDERS` 6,
   `STRUCTURE_STEPS` 6, `STRUCTURE_WALL_MS` 40_000, `STRUCTURE_SEARCHES` 2, `MEASURE_BATCH` 12, `MIN_UNIT_COVERAGE` 0.7.
5. **The finder runs at medium effort.** Choosing a source's units is judgement, not transcription.
6. **A measured page replaces the estimate only for essays, papers and non-hub repo READMEs.** For other kinds, a page
   is usually a landing page, so it's shown beside the estimate instead (§1).
7. **Books keep their catalogue size.** Chapters from a contents page are checked and sized as today's chapter finder
   does (§3).
8. **A linked page under `MIN_MEASURED_WORDS` counts as unmeasured,** so a folder README that only links slides keeps
   the model's estimate (§3).
9. **Practice lists keep today's time.** The finder may search for a practice list, and the `items` tool runs on the
   item finder's own clocks, outside `STRUCTURE_WALL_MS` (§2).
10. **A practice-only source gets practice units only.** It never gains reading time from its README's sections (§2).
11. **The structure stage is skipped below 160 s left,** not 220 s. Otherwise any research run over about 65 s would
    turn it off (§7).
12. **A unitless material's span across weeks is checked in code.** It must be consecutive and needed by the budget;
    anything else is still an overlap (§5).
13. **Only measured sizes cap a budget.** An estimate doesn't (§4).

## Left to the builder

- Function names, the heading-tree format the `outline` tool returns, and prompt wording within the anti-goals.
- How the allocation prompt shortens a long unit list (titles cut off after a count is fine; minutes per group must
  stay).
- How the `outline` tool reads a GitHub README: the rendered HTML, or the raw markdown through
  `raw.githubusercontent.com`.
