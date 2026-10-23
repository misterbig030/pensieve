# Practice item lists: plans work from real problems, like chapters

Status: draft for approval. Builds on the two designs already on `feat/allocate-after-research` (PR #24):
`2026-10-22-allocate-after-research-design.md` and `2026-10-22-extract-then-allocate-design.md`.

## Why

A saved SDE plan on this branch (track 48c1daf7) assigned 17 h to NeetCode problems, yet its weeks showed rows like
"NeetCode 150 · Arrays & Hashing, problems 1–3", repeated problems across weeks, used problems before any week
reserved them, and invented a "Queue" topic. Investigation found:

1. **Research never had the list.** The practice researcher knew "NeetCode 150, 18 topic folders, solutions" but not a
   single problem's title, number, difficulty or position, so everything downstream worked from a count.
2. **An unreserved week may use any source.** `levelChecks` binds a day's practice rows only "for the formats [the
   week] reserved", and `leafPickSources` offers every plan-wide source when the week reserved nothing; weeks 1–2 used
   NeetCode problems that weeks 3+ reserved.
3. **Only the source is checked, never the part.** A practice reservation's part is free text ("Arrays & Hashing; Two
   Pointers") no code checks, so week 3's days did other topics and week 4 repeated week 2–3's.
4. **Week headings never show practice.** The "Covers" line (`components/pensieve/PlanTree.tsx` `CoversRow`) draws
   reading reservations (`covers`) only, never `practiceCovers`.

The owner's target is a plan like their own LeetCode plan: each week a list of named problems in the list's topic
order ("1. Two Sum, 49. Group Anagrams, 347. Top K Frequent Elements"). Books already work this way through chapter
lists; practice sources should too.

## Goals

1. **A practice source can carry an item list**, the way a book carries a chapter list: its items in the source's own
   order, each with a title, an optional number (LeetCode's 49), a group (the topic), an optional difficulty, a link
   to the item, and an optional solution link (a video or a solution page).
2. **The list is found like chapters are**: an item-list finder runs for practice sources made of countable items and
   prefers a machine-readable copy (a JSON or CSV file in the source's repository, a static page that lists them).
3. **The allocation chooses items, not a count**: which groups and items the plan keeps, in the list's order.
4. **Weeks reserve item ranges and days assign single items**, like chapters, and code checks them: inside the week's
   reservation, never twice across the plan, and a source reserved anywhere is used only where reserved.
5. **Days show each item as "number. title"** (or just the title when there is no number), linked to the item, with
   a solution link when the list has one.
6. **Week headings' "Covers" line shows practice reservations** next to the reading.
7. **Generic**: any per-item practice source that is a list of items (problem lists, question banks, exercise sets)
   uses the same machinery. NeetCode is the motivating case, not a special case.

## Non-goals

- The learner's own history (solved problems, stale areas, redo vs new). Out of scope.
- Core vs stretch problems: one list per week.
- Per-item completion tracking. Completion stays per day, as today; an item is a row like a chapter row.
- Changing how reading, chapters or the allocation of shares work beyond what is listed here.

## Anti-goals

- Inventing items, topics or numbers the list doesn't contain (the "Queue" topic). Every item row resolves to a real
  item of a found list; a row that doesn't is dropped.
- A NeetCode- or LeetCode-specific code path. The finder's prompt may name examples of readable list formats; code
  must not branch on a site.
- All existing anti-goals of the parent designs still hold (no steering share numbers in prompts, learner's own never
  dropped, and so on).

## The data

### The item list (on the material)

`MaterialPractice` gains an optional `list`, stored in the existing `sources.practice` jsonb (no migration for this
part):

```
list: {
  items: { title: string; number: string | null; group: string | null; difficulty: "easy" | "medium" | "hard" | null;
           url: string | null; solutionUrl: string | null; minutes: number | null }[];   // 3–500 items, list order
  source: "page" | "file";        // found on a page, or read from a machine-readable file
  url: string;                    // where the list came from
}
```

- Positions are 1-based, as chapter positions are. `number` is the item's own label on its site ("49"); it may be
  null. `group` keeps the list's own topic names, in order of first appearance.
- `practice.items` stays the count of kept items; `practice.totalItems` the whole list's count (existing fields).
- Item minutes: the item's own when the list gives it; otherwise by difficulty — easy 15, medium 25, hard 35
  *(author's call; the owner's own plan uses 25/35-minute timers for medium/hard)*; otherwise the format's
  `perItemMinutes`. `practice.minutes` becomes the sum over kept items.

### Item positions on plan rows (migration)

The owner approved a migration. `node_practice` gains two nullable integer columns, `item_from` and `item_to`
(1-based positions in the source's item list, inclusive):

- a **reservation** (`practiceCovers`, a heading's practice) holds a range: `itemFrom`–`itemTo`;
- a **row** (`practice`, a leaf's practice) holds one item: `itemFrom = itemTo`.

Rows and reservations of a source without a list keep these null and behave as today. `practiceRefSchema` and
`practiceCoverSchema` gain optional `itemFrom` / `itemTo`; the save and load paths map them. The migration is
generated in the repo (`drizzle/0015_…`) and applied by the owner, as 0013 and 0014 were.

## The flow

```
research ─► extract ─► gate ─► chapter finder (≤2 books) ─┐
                              item-list finder (practice) ─┴─► allocate (Opus) ─► weeks ─► days
```

### 1. Item-list finder (new, beside the chapter finder)

- **Runs for** each verified practice source whose format counts items (the registry's `perItemMinutes` is set:
  problem-set, recall, lab today) and that the extraction gave a positive item count or a list-like description; at
  most three sources, in parallel with the chapter finder, before the allocation.
- **Works like the chapter finder** (`lib/ai/research/chapterFinder.ts`): a small bounded search-and-read loop through
  the shared fetcher, then one structured model call that lists the items from what it read. It prefers a readable,
  machine-readable copy of the same list: a data file in the source's repository (raw file URLs read fine), a static
  page that lists every item, the source's own repository README. It reads at most a few pages; a large data file may
  be read in full up to a size cap (builder's call on the cap, large enough for a 450-entry JSON).
- **Subsets:** when a source names a subset of a larger file ("NeetCode 150" inside a 450-entry file with a flag),
  the finder returns the subset the source names, in the file's order. It reports the items, their groups in order,
  numbers, difficulties, item links and solution links where the file has them.
- **Code validates:** 3–500 items; titles non-empty; duplicate titles within a group collapsed; links must be
  https; when the extraction claimed an item count and the found list differs by more than a little, the list is kept
  and the difference is a fact. A list that fails validation is discarded and the source works by count, as today.
- **Logged** as its own call ("Research · items") with facts (items found, groups, source URL), like the chapter
  finder.

### 2. Allocation

- **Sees** a practice source's list as groups with item counts and difficulty mix ("Arrays & Hashing — 9 items: 3
  easy, 6 medium"), not every title, to keep the prompt small (author's call: titles would push the prompt past what
  one decision needs).
- **Chooses** the kept part of a listed practice source as a set of groups, and optionally an item range within a
  group, in place of today's `items` count. Code turns that into the kept item positions, in list order, sets
  `practice.items`, `totalItems`, and `practice.minutes`, and cuts the list to the kept items (positions renumber, as
  chapter cuts do; nothing has referenced positions yet).
- Sources without a list keep today's `items` count behaviour.

### 3. Weeks (headings) reserve item ranges

- The heading prompt lists a listed source's kept items compactly by group with their positions ("M4 items 1–9
  Arrays & Hashing; 10–14 Two Pointers; …") and asks each unit to reserve a contiguous run, `{ format, id, from, to }`,
  continuing from where earlier units' reservations end, in list order, so every week with that format's time holds a
  run.
- Code checks (as with chapters): positions in range; no item reserved by two headings; runs out of order are a fact
  (as chapter regressions are). Breaches are droppable (the reservation row is dropped), never new retry-only kinds.

### 4. Days (leaves) assign single items

- The leaf prompt lists the parent's reserved items one per line, with alias, number, title, group and minutes, like
  chapter lines (`M4.12 49. Group Anagrams · Arrays & Hashing · medium · 25 min`), and asks for one practice row per
  item: `{ format, id: "M4.12", task, done, minutes }` (task may restate the title; the row's identity is the alias).
- `aliasMaterials` resolves `M4.12` to `{ id, item: 12 }` for a listed practice source, as it resolves `M1.3` to a
  chapter (an item alias on a book, or a chapter alias on a practice source, is unknown).
- **Code checks (the drift fix):**
  - an item row must be inside its parent's reserved range (`practice-outside`, droppable);
  - an item used by an earlier unit, or twice in one level, is `practice-overlap` (droppable);
  - a row naming the source without an item, when the source has a list, is refused like an unknown alias;
  - **reserved-source rule (all sources, listed or not):** once any heading reserves a source, a leaf may use that
    source only if its own parent reserved it. The leaf prompt offers only the parent's reserved sources for a
    format; when the parent reserved none of a format whose sources are reserved elsewhere, the prompt says so and
    offers none (a generated format may still be written, per its registry rule). The check mirrors the prompt.
- Minutes per row are the item's minutes; the week's practice budgets work as today.

### 5. Page

- **Day rows:** a listed item shows as "**49. Group Anagrams**" (title alone when there is no number), linked to the
  item's URL, with a small "solution" link when `solutionUrl` is set, and its group as a quiet label. Other practice
  rows show as today.
- **Covers line** (`CoversRow`): practice reservations appear after the reading, one chip per source:
  "NeetCode 150 · Arrays & Hashing – Two Pointers" (the groups the run spans), or the reservation's note for a source
  without a list. Same chip styling; the existing "+ N more" overflow applies across both.
- The materials list shows a listed practice source's group summary under it ("9 groups · 100 of 150").

## Revision, chat and expand

They read the saved materials (with `practice.list`) and the saved item ranges, and use the same prompts and checks,
so a week expanded later continues from what earlier weeks used. Plans saved before this change have no lists and no
item ranges and behave as today, plus the reserved-source rule.

## Constraints

- The local `DATABASE_URL` is production. The migration is generated with drizzle-kit (needs a TTY — see the tooling
  memory) and applied by the owner; the builder never runs it. No paid evals; one live draft on the builder's dev
  server as the final check (approved pattern).
- Tests (vitest, node): the finder's validation and subset handling (with a fixture modelled on NeetCode's
  `.problemSiteData.json` shape, not fetched live), item aliases, the allocation's group choice and cut, heading range
  checks, leaf item checks and the reserved-source rule, the save/load mapping of `itemFrom`/`itemTo`, the Covers
  line and the day row rendering (static render).

## Decided in conversation

- A problem row shows the problem's number and title, like a chapter; a solution link when research has one (a
  video or a solution page).
- Generic for any practice source that is a list of items.
- No learner history; one list per week (no stretch tier).
- A migration adding item positions to `node_practice` is approved.
- Fold the drift fix (reserved-source rule, item-level checks, no repeats) and the Covers line into this change.

## Author's calls

- Item minutes by difficulty: easy 15, medium 25, hard 35, else the format's default.
- The allocation sees groups with counts and difficulty mix, not every title.
- Day completion stays per day; no per-item ticks.
- At most three practice sources get the item-list finder per draft.

## Settled after the builder check

1. **Time follows the kept items** (answered by the conversation: the owner said the model decides whether to keep
   all 150 problems or a subset, just as it decides how much of a book to read). For a listed per-item source, the
   kept items' minutes *are* that format's time, the way kept reading is the reading time: code sets the format's
   share from them, and the other practice formats share what is left by the model's shares. The allocation prompt
   shows each group's minutes so choosing items is choosing time. A week's run is sized by that week's slice of the
   format's time. Items a week reserves but its days don't assign are a fact (`items N–M of <source> reserved by
   <week> but not assigned`); they are not handed to later weeks. If the learner later moves the slider or changes
   hours, the saved items stay as they are and the mismatch shows as facts, as other budget mismatches do. *(Author's
   call on the leftover handling.)*
2. **Saved plans are not cleaned up.** The reserved-source rule and the item checks apply to rows a call drafts now
   (`levelChecks` on the new level). Rows already saved — including completed and locked days — are never dropped by
   them; when revision's whole-tree checks see a saved row that breaks the new rules, it is a fact only. *(Author's
   call.)*
3. **Block formats get no item lists in this change.** Item lists apply to per-item formats only (the registry's
   `perItemMinutes` set: problem-set, recall, lab). Design question sets and mocks stay as today. Goal 7's "design
   question sets" is out of this change. *(Author's call.)*
4. **Links may be composed, but only to hosts seen in what was read.** The finder may build an item or solution link
   from a file's fields (a slug, a video id) when the pages or files it read show that link pattern; code keeps a link
   only if it is https and its host appears in the text the finder read (the list's own page or file, or a page it
   read for the list). Otherwise the link is dropped and the row shows number and title only. No site-specific code.
   *(Author's call.)*
5. **The difficulty table is for problem lists only.** Easy 15 / medium 25 / hard 35 applies to `problem-set`;
   recall and lab items use their own minutes or the format's `perItemMinutes` whatever their difficulty label.
   *(Author's call.)*

Settled by the builder without changing what gets built: the finder may read raw data files beyond the fetcher's
usual page cut and with a longer clock than the chapter finder; in month → week → day plans a week's item range sits
inside its month's, as chapters do; a week-leaf plan shows one row per item; splitting a week by hand turns each item
row into a one-item reservation; with more than three qualifying sources the finder runs for the three with the most
kept practice time; items whose groups interleave keep the file's order, and a group is the run of consecutive items
sharing a group name.

## Left to the builder

- Module and function names; the finder's prompt wording and its read/size caps; the exact chip and row styling.
- How the heading prompt compacts long lists (group lines with position ranges is the expectation).
