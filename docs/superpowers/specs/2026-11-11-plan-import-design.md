# Plan import: turn a plan file into a track

## Intent

Today every track starts from the goal form: a topic, weeks, hours and sources go in, research runs, the outline is
drafted, and the learner lands on the draft page (`PlanWorkspace`, `mode="create"`) to shape and confirm it.

Some learners already have a plan. The owner's own `weekly-plan.md` (8 dated weeks, an hour budget per line, named
book chapters, numbered LeetCode problems, timed drills, an exit check per week) is the model case. Drafting that
plan again from scratch wastes the work and loses its intent.

Plan import is a second way to start a track. The learner uploads a file that already holds a plan. One model call
**converts** it, with no research and no drafting. The learner lands on the same draft page, with the file's plan
already in place, and confirms it as they would a drafted plan.

It is a converter, not a planner. Whatever structure the file has is copied, and nothing is invented.

## Goals

- A file that contains a plan becomes a track whose units match the file one for one, in order, at the file's own
  level (months, weeks or days).
- Each unit's contents become Pensieve's own reading materials and practice rows. The converter decides which category
  each item belongs in.
- This happens for every unit the file fills in, across the whole plan, not only the first unit. Materials shared
  across units (the same book in several weeks) are one entry on the list.
- After import, the track is an ordinary track: chat, redraft, expand and splitting a week into days all work.
- A file with no plan in it is refused with a plain message, and no track is created.

## Non-goals

- Planning from a syllabus, topic list or reading list. That needs a planner, and the normal new-track flow already is
  one. These files count as "no plan".
- Looking anything up: no links, no verification, no Open Library, no research.
- Filling in levels the file does not write. A file with month headings imports as month headings, and the learner
  expands them later as they would on any track.
- Keeping the file's calendar dates as dates. Pensieve has no track calendar; dates stay as text in unit titles.

## Anti-goals

- **Inventing structure.** Extra units, rebalanced weeks or a different week count are failures, even if the result
  looks like a better plan.
- **Forcing a bad fit.** An item that fits no existing type goes to "other", not to the nearest wrong type.
- **Losing things silently.** A section the converter could not place is listed back to the learner, not dropped.
- **Passing as verified.** An imported material must never show a verified badge or look like one research checked.

## Decided with the owner

1. **Lands on the draft page.** The import result opens in the existing draft page, with no research step. Chat, expand,
   split and confirm work there as they do now.
2. **Weeks as the file has them.** For `weekly-plan.md`: 8 week units, in order, with the file's titles. Each can be
   split into days using the track's default days per week.
3. **Contents become materials and practice, categorized by the model.** Each unit's sections become rows in that unit's
   reading table and practice list, plus entries on the track's materials list. The converter model picks each item's
   category from the types the app already has:
   - reading kinds: book, course, video, docs, essay, paper, repo, tool, note (`MATERIAL_KINDS`)
   - practice formats: problem-set, recall, design-exercise, lab, project, mock, session (`PRACTICE_FORMATS`)
4. **New "other" category** for items the model cannot map to a predefined type.
5. **No lookups.** Imported materials have no links and no verification.
6. **Structure is copied exactly.** No planning happens for files without a timeline. A syllabus is out of scope.
7. **No plan, no track.** The converter decides whether the file holds a plan. If it doesn't, the learner is told
   Pensieve could not find a plan in it.
8. **An imported track behaves like a drafted one.** Chat, redraft and expand all work on it. Redraft may rewrite the
   open part of the plan, as it does on any track.
9. **What the file specifies is kept; what it leaves open, the model decides.** `weekly-plan.md` gives weeks, not
   days. When an imported week is split into days, the model decides which day gets what, the same way it does for a
   drafted week. It may cut a row into day-sized parts (seven Heap problems over five days), but every item the week
   names stays covered. When the file does break a week into days, those days are kept exactly as written.
10. **Every unit is converted, not just the first.** Every unit the file fills in gets its materials and practice rows.
   A unit the file names but leaves empty imports with just its title and summary.
11. **Success test:** importing `weekly-plan.md` shows all 8 weeks, each with the materials and practice the file gives
    it, sorted into the right categories. Week 1 is the worked example below. The same rules apply to every week.

## Worked example: Week 1 of `weekly-plan.md`

The file's Week 1:

> **Week 1 · Nov 10–15 · freeze + calibrate + Heap + framework**
> Pensieve (5 h): merge or close three branches; copy results out of a worktree; grade calibration files.
> LeetCode, Heap (7): 703, 1046, 973, 215, 621, 355, 295.
> System design: read Alex Xu vol. 1 ch. 1–3. Drill 1: rate limiter, 45 min cold, compare with ch. 4, one-page note.
> ✅ Exit: open branches closed; results saved; judge agreement measured; 7 heap problems.

The expected conversion:

| File item | Becomes |
|---|---|
| Week heading | A week unit titled "Week 1 · Nov 10–15 · freeze + calibrate + Heap + framework" |
| Alex Xu, *System Design Interview* vol. 1 | One **book** on the track's materials list, with no link. Week 1 reads ch. 1–3 and ch. 4 (the comparison read). Later weeks reuse this entry (ch. 5–6, 10, 11) instead of adding copies |
| LeetCode Heap (7) | A **problem-set** practice row with the seven problem numbers as its items |
| Drill 1: rate limiter | A **design-exercise** practice row: 45 minutes cold, then a one-page note |
| The three Pensieve tasks | Practice rows, as **project** or **other**, whichever the model judges fits. These are to-dos, not study, and either is acceptable |
| ✅ Exit line | The week's summary or done-when text, not a material |
| Hours (5 h Pensieve, ~5 h LeetCode, ~3 h system design) | Minutes on the matching rows. The week's budget is the sum when the file gives one, otherwise the track's hours per week |

Weeks 2–8 convert the same way. For example, Week 2 gets a problem-set (Backtracking + Tries), two design exercises
(key-value store, notification system) and reading from the same Alex Xu entry. Week 7 (holiday, light) gets only
the rows it names.

Plan-level parts of the file (the target, the phase table, "Where you start", the Rules) don't become units. They go
into the stored file text (below), where the model can read them.

## Draft page: no UI changes (approved with the mockup)

The draft page (`PlanWorkspace`) keeps its current layout and components. Import only fills it with content.
Mockup: `docs/mockups/plan-import.html`; screens 3 and 4 show the real page. The only visible differences come from
the new data:

- the "Other" category gets a chip, the same shape as the practice chips
- an unlinked material shows "From file" where a checked one shows "Verified"
- the split card's source label reads "From your file"
- the import notes appear as ordinary Conversation messages

A redesign of the draft page is separate work and out of scope here.

## What the converter returns

One structured-output model call returns one of:

- **`plan`**: track title, hours per week and days per week when the file states them, granularity, the unit tree at
  the file's own levels, the track materials list, each unit's reading and practice rows, and a list of **skipped**
  sections (text the converter could not place, with a one-line reason each).
- **`no_plan`**: a one-line reason ("this is a reading list with no timeline"). The learner sees: Pensieve couldn't
  find a plan in this file, followed by that reason, plus a pointer to the normal new-track flow.

The tree must pass the same validation a drafted tree does (`planTreeInputSchema`), so everything downstream (draft
page, confirm, expand, split, redraft) needs no import-specific path once the tree exists.

## Keeping the file's text

The original file text is stored on the track and given to chat, redraft and expand as context, so revisions follow the
learner's real plan and not only the rows extracted from it. `instructions` is capped at 2000 characters, and
`weekly-plan.md` is about 10,000, so this needs its own place. A track column or a `file` source both work; that choice
is the builder's.

## Changes the data model needs

- **"other"** is added to `MATERIAL_KINDS` (with a label and an icon) and to `PRACTICE_FORMATS`. It is kept separate from
  "note", which stays the learner's own notes.
- **Unlinked materials (settled in the plan):** they use the existing no-link path. That means `type: "note"`,
  `origin: "import"`, and a free-text `url` of the form `import:<slug>`. `url` stays required. The original note
  follows, for history. **Unlinked materials.** `url` is required on materials today. Imported ones have none. They must save, display without a
  link and without a verified badge, and pass `vetMaterials` untouched, as `origin: "learner"` materials already do. A new
  origin value (`"import"`) is an option if the list should say where an entry came from. The builder decides.
- **Logging and credits.** The converter call is logged in `generation_log` under a new caller (`"import"`), and it is
  charged like any other generation: credits, or the learner's own key.

## Entry point (my call, not discussed)

The new-track page gets a secondary action, "Import a plan file", next to the goal form. Choosing a file runs the
converter, with a progress state while it works, and opens the draft page on success. On `no_plan` or an error, the
learner stays on the form and sees the message.

## File formats (my call, not discussed)

The file type only changes the reader, not the design.

- **Version 1:** `.md` and `.txt`, read as text.
- **Next:** PDF (the models read it natively), then `.docx` (needs text extraction). Scanned images are out.

Version 1 caps files at a size that comfortably fits the model's context, well under Vercel's 4.5 MB request limit.
The exact cap is the builder's.

## Testing (my call)

- Unit tests with the existing mock-model replay: converter output to tree, "other" handling, unlinked materials saving
  and rendering, `no_plan` showing its message.
- A small fixture set for the converter itself: `weekly-plan.md` (the success test above), a month-level plan, a
  syllabus (should be `no_plan`), a bare reading list (`no_plan`), and a plan with one odd section (should list it as
  skipped).

## Fitting the import into the plan rules (my calls, after review)

These settle places where today's plan code is stricter than a free-form file. None was discussed with the owner.

- **A split comes from the file.** The converter produces the track's `PlanSplit`: the reading share comes from the
  file's hours, and the picks are every practice format the file uses. Imports may go past `MAX_PRACTICE_PICKS` (4).
  `weekly-plan.md` alone needs problem-set, design-exercise, mock and project/other. Folding a real format into
  "other" just to fit the cap would be the bad fit the anti-goals rule out.
- **"other" is a pickable format** with its own registry entry. Its rows carry the file's task text.
- **Practice lists are materials.** A named practice source with numbered items (LeetCode problems) becomes a
  practice-source material on the materials list, with no URL and an item list of the file's numbers. Week rows point
  at its items, so each problem can be ticked off. `practiceListSchema.url` becomes optional. Lists with fewer than 3
  items, and drills with no source (rate limiter, key-value store), become sourceless rows that carry the file's task
  text. Imported sourceless rows count as written: expand and split must not refuse them as "never written", and a split keeps every item the week names (decision 9).
- **Month-level files.** A month is a heading, so its contents become reservations (`covers`, `practiceCovers`) plus
  `time`, the same as a drafted month. Granularity is "week".
- **Day-only files.** Consecutive days are grouped into weeks of the track's days per week. Each day is kept exactly as
  written. Only the week wrappers are added, because the app only allows top-level days on one-week plans.
- **Long plans.** Imports are capped at 40 top-level units, the redraft schema's limit, so an imported track can always
  be redrafted. A longer file is refused with a message saying so.
- **Drafts.** "Research again" is hidden on an imported draft.

## Left to the builder

- The converter's model tier and prompt.
- Where the file text is stored, and how chat, redraft and expand receive it.
- Whether imported materials use `origin: "learner"` or a new `"import"` origin.
- How the draft page starts from a ready tree instead of calling `/api/plan/draft`.
- The "other" icon and label, and the file size cap.
- The wording of the `no_plan` and skipped-sections messages.
