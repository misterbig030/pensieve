# Chapters as resources: the outline reserves chapters, not books — design

**Status:** implemented 2026-10-18 on `feat/chapter-resources` (eleven tasks, suite 473 passing, tsc and lint clean, main
merged in). The whole-branch review found one Critical and five Important issues, all fixed with tests that failed first:
the hand-split flow had bypassed the reservation (the client sends the week before converting its Read table; the server
now converts it), the budget was judged before chapter rows were sized, `treeChecks` misread a month with one hand-split
week as headings, a revision dropped every whole-book row of a plan saved before this change (rows whose note names
chapters now stand as written), the availability block offered review covers as reading, and an unlisted book reserved by
topic was charged in full to every heading. Live-checked 2026-10-18 in Chrome against the worktree's dev server after the
operator applied `0011_chapter_refs` (169 existing rows took chapter 0): a 90-day draft of the AI-engineering plan reserved
ch. 1–4 for month 1, ch. 5–6 and 10 for month 2, and a review of ch. 3–6 for month 3; month 1's weeks read each chapter once
(1–2, 3, 4) with marked reviews; splitting week 1 sent the days the reservation (`M1.1–M1.2`) and what other units hold, the
first answer broke the day budgets, the retry was asked with those lines quoted, a non-consecutive re-read of ch. 1 on day 6
was dropped as an overlap, and the days ended inside ch. 1–2 at exactly 107 and 140 minutes; planning month 2 produced four
weeks inside ch. 5, 6 and 10 with no retry; day 1's lesson prompt read `ch. 1 "Introduction to Building AI Applications with
Foundation Models" · sections: The Rise of AI Engineering; Foundation Model Use Cases — must, 55 min` and the lesson followed
it. About $0.16 on the user's key. Observed: when a week's reservation cannot fit its days' must-reading (247 min against
7 × 30), the retry cannot cure the over-budget breaches and only costs a call; see Open items.
Builds on `feat/book-chapters` (PR #10, merged), which gives every verified book a chapter list. Follows the live check of 2026-10-17, in which a hand-split week
read chapters its neighbour had reserved, and the design conversation and Open Library survey of 2026-10-18.

## Summary

Today a book is one material, `M1`, and its chapters are lines printed under it for the model to read. Every
reference to the book is free text the model writes in a note: "ch. 1–4: Introduction …" on a month, "Ch. 1 …; Ch.
2 Understanding Foundation Models" on a week, "Ch. 2 Understanding Foundation Models (Post-Training; Sampling)" on a
day. Code parses chapter numbers back out of those notes to report facts after the fact, and nothing stops two
units from naming the same chapter, a unit from naming a chapter its parent never reserved, or a week from calling
a second pass over four chapters a reading.

After this change each chapter of a book with a list is a resource of its own in the list the outline sees,
`M1.3 ch. 3 "Evaluation Methodology" · about 1.6 h`, beside the essays and docs. Headings reserve resources; leaves
assign them; a resource is read in one place. The book itself stops being something the model can refer to once it
has a list. Chapter titles are rendered from the list and never written by the model; the note shrinks to the part
of a chapter a unit covers. Two checks run in code after every drafted level: nothing outside the parent's
reservation, nothing read twice. A level that breaks them is asked once more with the breaches quoted, and what
still breaks them is dropped. A review of something read earlier is a second kind of row, allowed and marked, not a
second reading. Sizes are data: a chapter's rows add up to its listed size, and a level whose reservation cannot fit
its reading budget is refused before its children inherit the problem.

## Why

- **The leaf rules let a split overrun its reservation.** In the live check, week 1 reserved chapters 1 and 2 (247
  minutes) against seven days with 20 minutes of must-reading each (140 minutes). The prompt asked both for sizes
  from the list and for minutes within budget, which could not both hold; the model wrote a flat 20 minutes a day,
  paced by sections instead, spent the reservation by day 4, and the rules "at least one must per unit" and "run in
  order … continuing from where earlier units stopped" carried days 5–7 into chapters 3 and 4, which week 2 had
  reserved. Nothing flagged it: the only chapter check looks for the backbone going backwards.
- **The weeks call front-loaded.** Month 1 reserved chapters 1–4 for four weeks whose must-reading totals 576
  minutes against 466 minutes of chapters, so one chapter a week fitted. The model put four chapters into weeks 1
  and 2, nothing new in week 3, and "Ch. 1–4 review and synthesis" in week 4. The reservation week 1 was handed was
  already too big for its budget, and a review was indistinguishable from a reading.
- **Free text cannot be checked exactly.** `parseChapters` reads numbers out of notes, misses titles, cannot tell a
  review from a reading, and cannot say which chapter a day's "Post-Training; Sampling" belongs to.
- **The chapter is the unit the data supports.** A survey of 157 works on Open Library (77 likely backbones, 80 from
  subject searches) found a table of contents on some edition for 50%, sections under chapters in 47% of those, and
  sections on every chapter in 17 of the 69 lists the parser accepts. Sections exist for about one book in four and
  are often partial; chapters exist whenever a list exists at all.
- **A page-found list has no sizes.** The finder's chapters carry no page numbers, so today they have no minutes and
  the outline cannot budget them.

## Decisions

1. **Each chapter of a book with a list is a resource.** Its alias is `M<i>.<k>` where `i` is the book's position in
   the materials list and `k` the chapter's 1-based position in its list (`M1.3`). The book as a whole is not a
   resource once it has a list: a bare `M1` in an answer is a breach, not a reference to the whole book. Books
   without a list stay one resource under today's rule: name the part by topic, never a chapter number or title.
2. **References carry data, not prose.** A reference is `{ id, chapter, activity, tier, minutes, note }` on a leaf
   and `{ id, chapter, activity, note }` on a heading. `chapter` is the position in the list or null for a whole
   resource. The chapter's number and title are rendered from the list everywhere they are shown; `note` is only the
   part: the sections a day covers, or the part of a resource that has no chapters.
3. **Two kinds of row: read and review.** `activity` is `"read"` (the default) or `"review"`. A review revisits a
   resource that an earlier unit, in plan order, reads. It costs minutes and counts toward the unit's reading time,
   and it does not count as the resource's reading, so it may name resources other units hold. Headings may reserve
   a review; leaves may assign one. A review of something no earlier unit reads is a breach.
4. **One reading per resource, inside the parent's reservation, checked in code.** After every drafted level: a
   read row must be in the parent's reservation (containment), and a resource read or reserved at this level must
   not be read or reserved anywhere else in the tree outside this unit's own line of ancestors (exclusivity).
   Breaches block: the level is asked once more with the breaches quoted; rows that still breach are dropped and
   the drop is a fact. Chapters running backwards and chapters no month reserves stay facts, as today.
5. **Sizes are data.** A chapter's size comes from its list. When one leaf reads a chapter, its row's minutes are
   that size. When consecutive leaves share a chapter, their rows' minutes are rescaled so they add up to the size,
   keeping the model's proportions; if the model wrote none, the size is split evenly. A heading's reservation
   must fit: the known minutes it reserves (chapter sizes plus sized whole resources) may not exceed its span's
   must-reading budget by more than `SHARE_TOLERANCE` (1.25). A leaf's must minutes keep today's rule, now a
   breach rather than a fact. Over-budget and reserved-but-unread cannot be fixed by dropping, so after the retry
   they stay facts.
6. **Page-found lists get sizes.** With no page positions, a list's chapters share the book's minutes evenly.
7. **Sections stay descriptive.** They print under the backbone's chapters in the units prompt, a day names the ones
   it covers in its note, and they reach the lesson prompt with the chapter title. They are not resources.
8. **The prompt says what is free.** For an expand or split, code lists the unit's reservation as the only resources
   its units may use, and what other units hold. At the top level everything is free and every chapter goes to at
   most one unit, in order.
9. **Saved plans keep their rows.** Existing rows become whole-resource reads (`chapter` 0, `activity` read) and
   render as before; `parseChapters` stays for them. No backfill of notes into chapter references.

## Architecture

```
materials (with toc) ─► aliasMaterials ─► M1, M1.1 … M1.10, M2 …
                              │
units prompt ◄── renderMaterials (chapter lines carry aliases)
             ◄── availability block (reservation of the >> unit, what others hold)
             ◄── rules (read once, inside the reservation, chapters in order, review rows)
                              │
model answer { covers | materials: [{ id: "M1.3", activity?, tier?, minutes?, note? }] }
                              │
resolveRefs ─► { id, chapter, activity, … }   unknown / bare-book ids kept aside for the checks
                              │
levelChecks ─► facts + breaches ─► breaches? retry once (silent) ─► still? drop rows, facts
                              │
sizeChapterRows ─► minutes from the list
                              │
PlanNode.covers / .materials ─► node_materials (chapter, activity) ─► tree, lesson prompt, UI
```

## Data model

### Wire (`lib/schemas/material.ts`)

`materialRefSchema` and `coverRefSchema` gain:

- `chapter: z.number().int().min(1).max(MAX_CHAPTERS).nullable()` — the chapter's 1-based position in the
  material's list; null for the whole resource.
- `activity: z.enum(["read", "review"])` — exported as `REF_ACTIVITIES`; `read` when absent on input.

The draft schemas the model writes change their `id` description to "A resource id from the list, e.g. M3 or M1.3",
gain `activity: z.enum(["read", "review"]).optional()`, and describe `note` as the part: for a chapter, the sections
this unit covers; for a resource without chapters, the part ("lectures 3–4", "§2 only"). `normalizeMaterialRef` and
`normalizeCoverRef` default `activity` to `read` and clip the note as today.

### Database (`lib/db/schema.ts`, migration `0011_chapter_refs`)

`node_materials` gains `chapter integer not null default 0` (0 is the whole resource) and
`activity text not null default 'read'` (`REF_ACTIVITIES`). The primary key becomes `(node_id, source_id, chapter)`:
a unit may read a chapter and review another of the same book. `refsByNode`, `refRows` and the two selects in
`lib/db/planQueries.ts` map 0 ↔ null and carry `activity`. The migration adds the columns with their defaults and
replaces the primary key; it is additive for existing rows.

### Plan nodes (`lib/planTree.ts`)

`PlanNode.covers` and `.materials` keep their shapes; `CoverRef` and `MaterialRef` carry the new fields. The
client-side hand split in `PlanWorkspace.splitWeek` and the server-side one in `insertChildren` carry `chapter` and
`activity` into the covers they create.

### Aliases (`lib/materials.ts`)

```ts
interface MaterialAliases {
  alias(id: string, chapter?: number | null): string | undefined;   // "M1", "M1.3"
  resolve(alias: string): ResolvedAlias | undefined;                 // { id, chapter: number | null }
  chapters(id: string): number;                                      // list length, 0 without a list
}
```

Resolution: `M1.3` on a material with fewer than three chapters or no list is unknown; `M1` on a material with a
list resolves with `chapter: null` and is a `whole-book` breach for the checks; case and stray brackets are ignored
as today. `resolveMaterialRefs` and `resolveCoverRefs` return `{ refs, unknown, wholeBook }`, dedupe on
`(id, chapter)`, and keep whole-book refs in the result so the retry can quote them; the caller drops them after the
retry. `remapTreeRefs`, `removeMaterialRefs` and `assignmentsOf` key on `id` and so already cover every chapter row
of a removed material.

## Checks (`lib/materials.ts`)

`levelFacts` becomes `levelChecks(input) → { facts: string[]; breaches: Breach[] }`, where

```ts
interface Breach {
  kind: "outside" | "overlap" | "whole-book" | "review-before-read" | "over-budget" | "unread-reservation";
  unit: string;        // "Week 1"
  refs: string[];      // aliases, "M1.3"
  text: string;        // the sentence the retry quotes and the dock shows
}
```

Definitions, with the placed units already in `root`:

- **outside** — a read row (or, on a heading, a read reservation) whose `(id, chapter)` is not in the parent's
  reservation. The parent's reservation is `parent.covers`; a hand-split week's converted Read table is its covers
  by then. A whole-resource reservation (chapter null) covers every chapter of that resource, so covers from before
  this change keep working. Top-level units have no parent and no containment check.
- **overlap** — a read `(id, chapter)` that also appears as a read or a read reservation on a node that is neither
  one of the placed units, nor an ancestor of them, nor a descendant. Within the placed units, two siblings reading
  the same `(id, chapter)` is an overlap too.
- **whole-book** — a reference to a material with a list and `chapter: null`.
- **review-before-read** — a review row whose `(id, chapter)` is not read by a leaf, or reserved as a read by a
  heading, whose span ends before this unit starts.
- **over-budget** — leaves: today's rule (`must > budget × readingShare × SHARE_TOLERANCE + 10`). Headings: the
  known minutes reserved (chapter sizes from the list, `m.minutes` for sized whole resources, 0 for unsized) exceed
  `budgetFor(len, hoursPerWeek) × 60 × readingShare × SHARE_TOLERANCE`. Without a reading share (the top level of a
  new plan decides it in the same call) `MUST_SHARE` stands in, as today.
- **unread-reservation** — after a mid or leaf level is placed: a read reservation on the parent that no placed unit
  reads or reserves. Reported once the level is complete; the retry quotes it.

Facts kept from today: dropped unknown ids, leaves without a must, backbone chapters out of order (`chapterRegressions`,
now from `chapter` fields with `parseChapters` as the fallback for rows without one), backbone chapters no month
reserves. A dropped row after the retry adds `dropped <alias> from <unit>: <kind>`.

### Retry and drop (`lib/ai/planDraft.ts`)

`draftLevel` runs `levelChecks` where it runs `levelFacts` today. With breaches, it calls `streamUnits` a second time
with the same prompt plus a block:

```
Your previous answer broke these rules; return all <n> units again, corrected:
- Week 1 reads M1.3, M1.4, which Week 2 holds.
- Week 4 reviews M1.1–M1.4, which no earlier unit reads.
- Week 1's must-reading is 247 min against a budget of about 144 min.
```

The retry's units are not streamed to the client: the first attempt's units stay on screen until the retry's result
replaces them at `done`. Both calls are logged, the second labelled `… (retry)`, with the breaches in `facts`. After
the retry, rows with `outside`, `overlap`, `whole-book` or `review-before-read` breaches are removed from their
units; `over-budget` and `unread-reservation` remain facts. A retry that fails outright (provider error) falls back
to the first answer with the same drops. `revisePlanTree` runs `levelChecks` over the whole revised tree with no
retry: breaching rows are dropped with facts, since a revision is one large call and the learner can ask again.

### Sizing (`lib/ai/planDraft.ts`, `lib/ai/research/chapters.ts`)

`sizeChapterRows(nodes, materials)` runs on leaf levels after the checks: for every `(id, chapter)` with a listed
size, the rows across the placed units that read it are rescaled to sum to the size (`Math.round`, remainder to the
last row); rows summing to zero share it evenly; chapters without a size keep the model's minutes. `withChapterSizes`
gains the even split for lists with no positions, so page-found lists are sized when the book is.

## Prompt changes (`lib/ai/planPrompt.ts`)

### Rendering

A book with a list renders as its line, then one line per chapter with the alias first, then the source line:

```
M1 [book · backbone] "AI Engineering: …" — Chip Huyen, 2024 <url> · about 18.4 h. Refer to its chapters by id; M1 itself is not a resource.
  M1.1 ch. 1 "Introduction to Building AI Applications with Foundation Models" · about 1.8 h — The Rise of AI Engineering; …
  M1.2 ch. 2 "Understanding Foundation Models" · about 2.3 h — Training Data; Modeling; Post-Training; Sampling
  …
  (chapters from Open Library)
```

The sentence after the book's size appears only for books with a list. Sections print for the backbone in the units
and revision prompts, as today. `renderRefs` collapses runs of consecutive chapters and names the activity:
`covers M1.1–M1.4, M3` for a heading; `reads M1.2 must 35 min (Post-Training; Sampling); M3 should 79 min` and
`reviews M1.1 should 20 min` for a leaf. A row with a note on a chapter shows the note after the minutes; a whole
resource's note shows as today.

### Availability block

For an expand or split (`input.tree && input.parentId`), computed from the tree and placed after the numbered unit
list:

```
This unit's reservation, the only resources its days may use: M1.1, M1.2. Held by other units: M1.3, M1.4, M3 (Week 2); M4 (Week 3); M1.5, M1.6, M2, M5 (Month 2); M1.10, M4, M6, M7 (Month 3).
```

Runs of consecutive chapters collapse (`M1.5–M1.6`); a unit's holdings are its read reservations or reads, reviews
excluded. For the top level the block is one line: `Every resource is free. Reserve each in at most one month; the
book's chapters in order.` A unit whose parent reserved nothing gets the leaf fallback sentence that exists today
("Take them from the list above, matching each unit's ground.").

### Rules

Headings (`headingMaterialRules`), when the backbone has a list:

```
Materials: for each unit, list in "covers" the resources its weeks will read, as { id, activity, note }. activity is "read" (the default) or "review". note names the part only for a resource without chapters ("lectures 3–4"); leave it out otherwise. No tier and no minutes yet: the units inside are planned later from this reservation.
Each resource is read in at most one unit at this level. M1's chapters are resources of their own (M1.1, M1.2, …): reserve them in order across the units, each chapter in exactly one unit, and never refer to M1 itself.
A unit may also reserve a review of resources that an earlier unit reads, with activity "review". A review is not a reading, so it may name resources another unit holds.
<availability block>
Use only ids from the list.
```

When the backbone has no list, the second paragraph is today's: reserve it in order across the units and name each
unit's part by topic; never write a chapter number or a chapter title you were not given. Without a backbone the
first and third paragraphs stand with "spread the materials where they fit best".

Leaves (`leafMaterialRules`):

```
Materials: for each unit, list its Read table in "materials" as { id, tier, minutes, note, activity }. tier is "must" or "should"; minutes is the reading or watching time for this unit; activity is "read" (the default) or "review"; note names the part: for a chapter, the sections this unit covers ("Post-Training; Sampling"), for anything else the part ("§2 only", "whole essay").
<availability block>
Rules: at least one must per unit where the reservation has material for it; must minutes stay within about 40% of the unit's budget, because the rest of the time is for hands-on projects; should items are optional extras.
Each resource's size is in the list. A chapter longer than one unit's reading time spans consecutive units: list it in each with the part in the note; across those units its minutes add up to its size. A resource is read once: do not assign what another unit reads, and never refer to M1 itself.
A review (activity "review") revisits a resource an earlier unit read. Its minutes count for this unit, and it may name resources other units hold.
Use only ids from the list.
```

The budget sentence keeps its three variants (decided split, given split, default share). The no-list backbone
sentence is kept for books without a list. `CHAPTER_LINE` ("Where a book's chapters are listed, name them as listed
…") is dropped: a listed book's chapters are ids now, and the unlisted case has its own sentence.

### Revision (`buildRevisionPrompt`, `lib/ai/planRevision.ts`)

The materials rule names the new shapes: `"covers" (headings: { id, activity, note })` and `"materials" (units
without children: { id, tier, minutes, note, activity })`, "ids may be a resource or a chapter (M1.3)", and "a
resource is read in one unit; a review of something read earlier is activity review". `applyRevision` resolves with
the new resolver and runs `levelChecks` tree-wide with the drop behaviour above. The chat prompt renders the same
materials list and needs no rule change.

## Lesson prompt (`lib/ai/dailyContent.ts`, `app/tracks/[id]/nodes/[nodeId]/actions.ts`)

`LessonMaterial` gains `chapter?: { n: number | null; title: string; sections: string[] } | null` and
`activity?: "read" | "review"`, filled from the source's `toc` where the row has a chapter. A row renders as

```
- AI Engineering: Building Applications with Foundation Models (url) — ch. 2 "Understanding Foundation Models" · sections: Post-Training; Sampling — must, 35 min
- AI Engineering: … (url) — review of ch. 1 "Introduction to …" — should, 20 min
```

and the list's lead sentence gains: `Rows marked review revisit material the learner read earlier: recap and
connect it to today, do not teach it afresh.` This closes the previous spec's "passing a chapter's sections to the
lesson prompt".

## UI

- **Read rows** (`components/pensieve/ReadTable.tsx`): a row with a chapter shows the material's title, then
  `Ch. 2 Understanding Foundation Models` on its part line with the note after a middle dot; a `Review` pill sits
  beside the tier pill for review rows. `ReadRow` gains `chapter` and `activity`; `readRowsFor` fills them from the
  material's list.
- **Covers chips** (`PlanTree.CoversRow`): a backbone chip reads `AI Engineering · ch. 1–4`, from the chapter runs
  rather than the note; a review reservation chip is prefixed `Review:`.
- **Remove confirmation** (`MaterialsList.describeUses`, `assignmentsOf`): unchanged wording; a material with
  chapter rows is listed once per unit.
- **Admin dock**: breaches appear in each call's facts; the retry is its own call.

## Failure handling

- The model answers with a bare `M1` for a listed book: breach, retry, drop. The unit keeps its other rows and the
  fact says so.
- The retry breaks the same rules: the breaching rows are dropped, over-budget and unread-reservation stay facts,
  the plan is saved. Nothing is invented to fill the hole; the admin dock and the eval see it.
- The retry call fails (provider error on the app's key): the first answer is used with the same drops. On the
  user's key a provider refusal stops the request, as every call does today.
- A list changes after rows reference it (a research rerun on a saved track is out of scope; the list is written
  once): `chapter` beyond the list's length renders without a chapter label and the lesson prompt omits the chapter.
- A page-found list without a book size stays unsized; chapter rows keep the model's minutes and the heading budget
  check counts them as 0.
- A week split by hand whose Read table held a whole-book row on a listed book (a saved plan from before this
  change): the row converts to a whole-book cover and the days' containment accepts any chapter of that book.

## Testing

Unit tests, all against fakes, with one fixture: the saved AI-engineering plan as drafted on 2026-10-17 (tree of
three months and four weeks, materials with the ten-chapter list, 6 hours a week, 40% reading), stored as
`lib/__fixtures__/plans/ai-engineering-90d.json`.

- `lib/materials.test.ts`: `M1.3` resolves to `(id, 3)`; `M1.7` on a six-chapter book is unknown; `M1` on a listed
  book resolves whole with a `whole-book` breach; each breach kind on the fixture (week 1 days reading `M1.3` →
  `outside` and `overlap` naming Week 2; week 4 reviewing `M1.1–M1.4` with weeks 1–2 reading them → no breach, and
  without them → `review-before-read`; weeks 1–2 holding `M1.1–M1.4` → `over-budget` for week 1 at 247 against 144;
  a month's weeks leaving `M1.4` → `unread-reservation`); a tree-wide overlap when month 2's weeks name `M1.4`;
  `renderRefs` collapsing runs and naming reviews; `sizeChapterRows` rescaling 3 rows of 20 min on a 107-minute
  chapter to 36/36/35 and splitting evenly when the model wrote zeros.
- `lib/ai/planPrompt.test.ts`: chapter lines carry aliases and the "not a resource" sentence; the availability block
  for the fixture's week 1 split names `M1.1, M1.2` and what the other units hold; the heading and leaf rule copy;
  the top-level line; the no-list sentences unchanged.
- `lib/ai/planDraft.test.ts`: with a mock model whose first answer reads `M1.3` from week 1's split and whose second
  complies, the level makes two calls, streams units only once, and keeps the second; when the second also breaches,
  the row is dropped and the fact recorded; `over-budget` on a leaf triggers a retry and then stays a fact.
- `lib/ai/planRevision.test.ts`: a revision answer with a bare `M1` and a duplicated chapter drops both rows with
  facts and makes one call.
- `lib/db/materials.test.ts` (round trip): rows with `chapter` 2 and `activity` review survive save and load; two
  rows for the same source on one node with different chapters coexist under the new key; old rows load as whole
  reads.
- `lib/ai/dailyContent.test.ts`: the row copy for a chapter with sections and for a review.
- `lib/ai/research/chapters.test.ts`: `withChapterSizes` even split for a positionless list; unchanged behaviour
  with positions.
- `components`: `readRowsFor` fills chapter and activity (pure function, tested beside the lib tests).
- Eval: `evals/scripts/sample-plans.ts` records `breaches` per call next to `facts`; the research README gets a
  paragraph.

Live check, after the migration: redraft the AI-engineering plan at 90 days, confirm, split week 1; expect week 1 to
hold one or two chapters that fit 144 minutes, its days to stay inside them, week 4's review (if any) marked as such,
and month 2's weeks, when planned, to read only chapters 5 and 6.

## Files

- `lib/schemas/material.ts` — `REF_ACTIVITIES`, `chapter` and `activity` on both ref schemas and both drafts.
- `lib/db/schema.ts`, `drizzle/0011_chapter_refs.sql` + meta — columns and key.
- `lib/db/planQueries.ts` — `refsByNode`, `refRows`, the two selects, the hand-split conversion.
- `lib/materials.ts` — aliases, resolvers, `levelChecks`, `Breach`, `sizeChapterRows`, chapter runs helper.
- `lib/ai/planDraft.ts` — checks, retry, drops, sizing in `draftLevel`; `streamUnits` gains `silent`.
- `lib/ai/planPrompt.ts` — rendering, availability block, rules, revision rule.
- `lib/ai/planRevision.ts` — new resolver, tree-wide checks and drops.
- `lib/ai/research/chapters.ts` — even split in `withChapterSizes`.
- `lib/ai/dailyContent.ts`, `app/tracks/[id]/nodes/[nodeId]/actions.ts` — chapter and activity on lesson rows.
- `components/pensieve/ReadTable.tsx`, `PlanTree.tsx`, `PlanWorkspace.tsx` — rows, chips, hand split.
- `evals/scripts/sample-plans.ts`, `evals/research/README.md` — breaches recorded and described.
- Tests and the fixture as listed.

## Sequencing

1. Data: schemas, column and key, mappers, aliases and resolvers, hand split carrying the fields. Everything still
   works with whole-resource rows.
2. Checks: `levelChecks` with breaches, retry and drops in `draftLevel`, tree-wide checks in revision.
3. Prompts: chapter aliases in the list, the availability block, the rules. From here a draft reserves chapters by
   id end to end.
4. Sizing: `sizeChapterRows`, the even split for page-found lists.
5. Lesson prompt and UI. Eval field. Live check.

## Out of scope

- Sections as resources, and section sizes.
- Practice as explicit rows: the reading share remains a plan-level percentage and practice remains the lesson's.
- Backfilling saved plans' notes into chapter references.
- Letting the learner assign or move chapters by hand in the UI.
- Chapters for non-book kinds (course lectures, playlist entries).
- Re-reading a book's list after the plan is saved, and what happens to references if it changes.
- Checking that a research `uses` estimate ("ch. 1–6, 9–10") matches what the outline reserved.

## Open items

- Whether review minutes should count toward the reading share or the practice share of a unit's budget. This spec
  counts them as reading, since they are time spent with the material.
- Whether the chat prompt should carry the availability block when the learner asks about a specific unit. It does
  not here.
- Lists whose chapters have no numbers (`n` null, from the page path): the alias still works by position and the
  prompt shows `M1.3 "Title"` without `ch. 3`. Whether to number them for the learner is a UI question.
- The retry doubles the cost of a level that breaches. The live check showed one case it cannot cure: a week whose
  reservation is larger than its days' must-reading in total (247 min against 7 × 30). The model shrank its minutes, sizing
  restored them, and the breaches stayed facts. Either the weeks call should be told the days' capacity, or a level whose
  only breaches are over-budget ones that no answer can fix should skip the retry.
