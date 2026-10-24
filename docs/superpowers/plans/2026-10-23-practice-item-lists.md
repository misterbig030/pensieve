# Practice Item Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Practice sources carry real item lists (found like chapter lists), the allocation keeps items, weeks reserve item ranges and days assign single items with checks, and the page shows "49. Group Anagrams" rows and practice in each week's Covers line.

**Architecture:** `MaterialPractice.list` holds the items (jsonb, no migration); `node_practice` gains `item_from`/`item_to` (migration 0015) so reservations and rows point at item positions the way reading refs point at chapters. A new item-list finder runs beside the chapter finder; the allocation chooses groups/ranges and the format's time follows the kept items; prompts and `levelChecks` work in item aliases (`M4.12`) with the reserved-source rule; the UI renders items and practice covers.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routes/pages), AI SDK (`generateObject` via `loggedGenerateObject`), zod, Drizzle (drizzle-kit for the migration), vitest (`environment: node`).

**Spec:** `docs/superpowers/specs/2026-10-23-practice-item-lists-design.md` (builds on the two 2026-10-22 designs on this branch).

## Global Constraints

- Every item row resolves to a real item of a found list; a row that doesn't is dropped. No site-specific code path (prompts may name examples of readable list formats).
- Item lists apply to per-item formats only (registry `perItemMinutes` set: problem-set, recall, lab). Block formats unchanged.
- Item minutes: the item's own; else for `problem-set` only by difficulty easy 15 / medium 25 / hard 35; else the format's `perItemMinutes`.
- Item list: 3–500 items, 1-based positions in list order; links kept only if https and their host appears in the text the finder read.
- A listed source's kept items' minutes are that format's time; other practice formats share the rest by the model's shares.
- Saved rows (including completed/locked units) are never dropped by the new rules; whole-tree checks report them as facts.
- The local `DATABASE_URL` is production: never run anything that connects to it; the migration is generated in the repo and applied by the owner. No paid evals; no real model or search calls in tests.
- Typecheck `npx tsc --noEmit` (run `npx next typegen` first if `LayoutProps` is missing). Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A finder file lists 450 problems with a subset flag → the source's 150, in file order, with groups in order (Task 2 test `returns the subset the source names`).
2. An item link to a host never seen in what was read → dropped, the item kept with number and title (Task 2 test `drops links to hosts it never read`).
3. A day row names `M4.200` past the kept list, or the source without an item → dropped as unknown (Task 4 test `refuses an item alias outside the list`).
4. A week's days assign items outside its reserved range or already used by an earlier week → `practice-outside` / `practice-overlap`, droppable (Task 4 tests).
5. A saved plan from before this change (no lists, no ranges) is revised → its existing practice rows stay; new-rule violations appear as facts only (Task 4 test `never drops saved rows for the new rules`).

---

### Task 1: Item data, positions and aliases

**Files:**
- Modify: `lib/schemas/material.ts` (`materialPracticeSchema`, `practiceRefSchema`, `practiceCoverSchema`, `practiceRefDraftSchema`, `practiceCoverDraftSchema`)
- Modify: `lib/db/schema.ts` (`nodePractice`: `itemFrom`, `itemTo` nullable integers); create `drizzle/0015_practice_item_positions.sql` and meta via drizzle-kit
- Modify: `lib/db/planQueries.ts` (save/load of `itemFrom`/`itemTo`)
- Modify: `lib/materials.ts` (`aliasMaterials`: item aliases), `lib/practice.ts` (`itemMinutes`)
- Test: `lib/schemas/material.test.ts`, `lib/materials.test.ts`, `lib/db/materials.test.ts` (pure mapping tests only), `lib/practice.test.ts`

**Interfaces:**
- Produces: `PracticeItem = { title: string; number: string | null; group: string | null; difficulty: "easy"|"medium"|"hard"|null; url: string|null; solutionUrl: string|null; minutes: number|null }`; `MaterialPractice.list?: { items: PracticeItem[]; source: "page"|"file"; url: string } | null`.
- Produces: `PracticeRef.itemFrom?/itemTo?: number | null` (a row: equal), `PracticeCover.itemFrom?/itemTo?`. Draft schemas: a row's `id` may be an item alias (`"M4.12"`); a cover gains optional `from`/`to` numbers.
- Produces: `MaterialAliases.resolve("M4.12") → { id, chapter: null, item: 12 }` for a listed practice source (item ≤ list length); `MaterialAliases.items(id): number`; `alias(id, { item })`. A chapter alias on a practice source, or an item alias on a book, is unknown.
- Produces: `itemMinutes(format: PracticeFormat, item: PracticeItem): number` in `lib/practice.ts`.

- [ ] **Step 1: Tests.** Schema: a practice with a 3-item list parses; 2 items or 501 fail; a ref/cover with and without `itemFrom/itemTo` parses. Aliases: `M4.12` resolves on a 100-item list, `M4.101` is undefined, `M1.3` stays a chapter of a book, `M4.3` on a book without a toc is undefined. `itemMinutes`: problem-set medium → 25, hard → 35, no difficulty → 10 (registry), item's own minutes win; recall "hard" → 3. DB mapping: rows with `itemFrom/itemTo` round-trip through the save/load mappers; rows without stay null.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Migration: after editing `lib/db/schema.ts`, generate with a pseudo-TTY: `script -q /dev/null npx drizzle-kit generate --name practice_item_positions` (generation reads the schema and snapshots only; it does not connect). If it prompts for anything, stop and report. Never run `migrate` or `push`.
- [ ] **Step 4: Run** `npx vitest run lib` and `npx tsc --noEmit` — expect PASS / clean. Confirm `drizzle/0015_*.sql` only adds the two nullable columns.
- [ ] **Step 5: Commit** `feat(practice): item lists on practice sources, and item positions on practice rows`.

---

### Task 2: The item-list finder

**Files:**
- Create: `lib/ai/research/itemFinder.ts` (mirrors `chapterFinder.ts`)
- Modify: `lib/ai/research/pipeline.ts` (run it beside the chapter finder), `lib/ai/research/tools.ts` or `egress.ts` only as needed to read raw data files (text/plain or application/json) beyond the usual page cut
- Modify: `lib/ai/planDraft.ts` / `app/api/plan/draft/route.ts` only to wire `research.items` like `research.chapters`
- Test: `lib/ai/research/itemFinder.test.ts`, `lib/ai/research/pipeline.test.ts`; fixture `lib/ai/research/__fixtures__/problemList.json` modelled on NeetCode's `.problemSiteData.json` shape (fields like `problem`, `pattern`, `link`, `video`, `difficulty`, `neetcode150`, `blind75`), ~12 entries, a subset flag on some

**Interfaces:**
- Produces: `ItemFinder.find(source: Material, ctx): Promise<{ list: MaterialPractice["list"]; counts: ResearchCounts; costUsd: number }>`; `createItemFinder(options)`; `validateItemList(raw, readText: string): MaterialPractice["list"] | null` (pure: 3–500, non-empty titles, collapse duplicate titles within a group, https links whose host appears in `readText`, positions in order).
- Produces: pipeline runs it for verified practice sources of per-item formats (Global Constraints), at most 3 (most kept practice time, else list order), in parallel with the chapter finder, before the allocation; sets `practice.list`, `practice.totalItems = items.length` (and `items` when unset); a fact when the found count differs from the claimed `items` by more than 10%. Logged as "Research · items" with facts (items, groups, url). Emits a `research.items` progress event like `research.chapters`.

- [ ] **Step 1: Tests:** `returns the subset the source names` (model answer from the fixture → only flagged entries, file order, groups in first-appearance order); `drops links to hosts it never read` (composed `https://leetcode.com/problems/two-sum/` kept when "leetcode.com" is in `readText`, a youtube link dropped when "youtube.com" isn't); `rejects a list under 3 or over 500`; `keeps working by count when no list is found` (pipeline: source unchanged); `runs for at most three practice sources, in parallel`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Budget: one or two searches, up to 4 reads, a data file read in full up to ~400 KB, a wall of ~45 s (builder's call within these). The model is told the source's title and what research said about it; it prefers a machine-readable file in the source's repository or a static page listing every item; it returns items with the fields above, may compose links only from patterns visible in what it read, and names the URL it read the list from (a list not traceable to a read URL is discarded, as the chapter finder does).
- [ ] **Step 4: Run** `npx vitest run lib/ai` and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(research): an item-list finder gives practice sources their real items`.

---

### Task 3: The allocation keeps items, and the format's time follows them

**Files:**
- Modify: `lib/ai/allocate.ts` (prompt rendering of listed sources, `allocationDraftSchema` parts, `applyAllocation`, `fallbackAllocation`)
- Test: `lib/ai/allocate.test.ts`

**Interfaces:**
- Consumes: `MaterialPractice.list`, `itemMinutes` (Task 1).
- Produces: a part for a listed source may carry `groups: string[] | null` and/or `itemRange: { from: number; to: number } | null`; code keeps the matching items in list order, cuts `list.items` to them (positions renumber), sets `items`, keeps `totalItems`, and sets `practice.minutes = Σ itemMinutes`. For each listed per-item format, its share of practice is set from its kept minutes (over the practice minutes left after reading); the other picks share the remainder by the model's shares (normalised). A fact records model share → derived share per such format.

- [ ] **Step 1: Tests:** `shows each listed source by group with counts, difficulty mix and minutes` (prompt contains "Arrays & Hashing — 9 items" style lines, no item titles, no `\d+%`); `keeps the chosen groups in list order and cuts the list`; `keeps an item range within a group`; `sets the format's time from the kept items and shares the rest`; `an unknown group keeps nothing of it and is a fact`; `the fallback keeps a listed source whole`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npx vitest run lib/ai/allocate.test.ts`, `npx vitest run`, `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(plan): the allocation keeps real items, and a listed format's time follows them`.

---

### Task 4: Weeks reserve item ranges, days assign items, and the checks hold them

**Files:**
- Modify: `lib/ai/planPrompt.ts` (`headingPracticeRules`, `leafPracticeRules`, `leafPickSources`, `practiceHeld`, `renderMaterials` for listed sources)
- Modify: `lib/materials.ts` (`resolvePracticeRefs`, `resolvePracticeCovers`, `levelChecks`, `treeChecks`, `dropBreaches` as needed)
- Modify: `lib/ai/planDraft.ts`, `lib/ai/planRevision.ts` only where checks are invoked (new-level vs whole-tree)
- Test: `lib/materials.test.ts`, `lib/ai/planPrompt.test.ts`, `lib/ai/planDraft.test.ts`

**Interfaces:**
- Consumes: item aliases and positions (Task 1), cut lists (Task 3).
- Produces: heading prompt lists a listed source compactly by group with position ranges and asks each unit for `{ format, id, from, to }`, continuing from where earlier reservations end, sized by that unit's slice of the format's time; leaf prompt lists the parent's reserved items one per line (`M4.12 49. Group Anagrams · Arrays & Hashing · medium · 25 min`) and asks one row per item with `id: "M4.12"`.
- Produces (checks, new level only): row outside the parent's reserved range → `practice-outside`; an item used by an earlier unit or twice in the level → new droppable kind `practice-overlap`; reservation positions out of range → dropped as unknown; two headings reserving the same item → `practice-overlap`; reservation runs out of order → fact; a month's week ranges must sit inside the month's (as chapters); **reserved-source rule (all sources):** once any heading reserves a source, a leaf may use it only if its parent reserved it — prompt offers only the parent's reserved sources for a format and says when none; check → `practice-outside`. Leftover reserved items not assigned by a parent's children → fact `items N–M of <source> reserved by <unit> but not assigned`. Whole-tree checks over saved rows report these as facts, never drops. Splitting a week by hand (`streamExpandNode` reason "split") carries each item row's `itemFrom`/`itemTo` onto its one-item reservation.

- [ ] **Step 1: Tests:** `reserves item ranges in list order across weeks` (prompt + resolution); `lists a week's reserved items to its days`; `refuses an item alias outside the list`; `breaches a day item outside its week's range`; `breaches an item an earlier week already used`; `keeps a source reserved elsewhere out of an unreserved week` (prompt offers none; a row is `practice-outside`); `records reserved items no day assigned`; `never drops saved rows for the new rules` (whole-tree check on a saved plan with an old-style row → fact only); a month → week nesting case; `a week split by hand keeps each item as a one-item reservation`.
- [ ] **Step 2–4:** run (FAIL) → implement → `npx vitest run lib` and `npx tsc --noEmit`; update existing expectations only where the reserved-source rule changes them, listing each.
- [ ] **Step 5: Commit** `fix(plan): days follow their week's practice reservation, by item, and never repeat or invent items`.

---

### Task 5: The page shows items and practice reservations

**Files:**
- Modify: `components/pensieve/PlanTree.tsx` (`CoversRow`), `components/pensieve/ReadTable.tsx` (`practiceRowsFor`, `DoRows`, `coverPracticeRows`), `components/pensieve/MaterialsList.tsx` (group summary), the leaf/day view if it renders practice rows separately
- Test: `components/pensieve/PlanTree.test.ts` (create if absent, static render), `components/pensieve/ReadTable.test.ts`, `components/pensieve/MaterialsList.test.ts`

**Interfaces:**
- Consumes: `PracticeRef.itemFrom`, `MaterialPractice.list` (Tasks 1, 3).

- [ ] **Step 1: Tests:** `shows a listed item as number and title, linked, with a solution link` ("49. Group Anagrams" in an `<a href="https://leetcode.com/problems/group-anagrams/">`, a "solution" link to `solutionUrl`, the group as a label; title alone when no number; no link when url null); `shows practice reservations in the Covers line` (chip "NeetCode 150 · Arrays & Hashing – Two Pointers" for a range spanning those groups; a source without a list shows its note; "+ N more" counts both kinds); `summarises a listed source's groups in the materials list` ("9 groups · 100 of 150").
- [ ] **Step 2–4:** run (FAIL) → implement → `npx vitest run` and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(plan): problem rows read "49. Group Anagrams", and weeks show their practice`.

---

## After the tasks

Whole-branch review of this plan's range, one fix wave if needed. Then the owner applies migration 0015. Then one live SDE draft on the builder's own 3002 server, Admin on, fresh tab: check "Research · items" found the NeetCode 150, the allocation kept items by group, Week 1's days show named problems, no repeats across expanded weeks, practice in the Covers line, and the total time against the 300 s limit.
