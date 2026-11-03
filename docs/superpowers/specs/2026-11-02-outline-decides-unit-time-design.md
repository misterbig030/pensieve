# The outline decides each unit's time; the checks report instead of retrying — design

**Status:** design, 2026-11-02. Not built.

## Summary

Today the allocation (one model call) decides the plan's totals — how much of each material is read, what share of the
practice each format gets — and then **code** spreads those totals evenly: every week gets the same reading minutes and
the same minutes per practice format (`weekBudgets` / `practiceBudgets`). Four checks hold every week to that even split,
and a level that breaks any check is drafted a second time by the outline model ("… (retry)"), with rows that still break
it dropped by code.

After this change the **top-level outline call** decides how each unit spends its hours: a reading-heavy week 1, a
week 8 of mocks and design, whatever the materials call for. The allocation keeps deciding the plan's totals. The even
split, the four rules that enforce it, and the retry all go. The checks still run, once, but they only **report**: every
problem they find is added, in plain words, to the plan's response in the conversation panel, and the learner decides
whether to keep the plan, ask the chat for a fix, or ask it to regenerate.

## Why

From the model-call export of 2026-11-02 (senior SWE interview prep, 8 weeks × 6 h, 47 calls, 4 min 11 s of model time,
≈ $1.56 on the user's key):

- The allocation gave reading 20% of the plan (576 min of 2,880) — a plan-wide figure. Code turned it into "72 min of
  reading every week" and refused a week holding more than 90 min.
- The allocation gave *Designing Data-Intensive Applications* 210 min; each of its chapters is about 129 min. One
  chapter is already over any week's 90, and a chapter cannot be split across weeks, so **no answer could pass**. The
  top-level outline was drafted twice (25 s + 37 s, $0.075 + $0.093); the retry still broke the rules, and week 3 would
  break the same rule again when its days were planned.
- The allocation is for the whole plan. It does not mean every week follows it; front-loading reading and ending on
  practice is a sound plan that today's rules forbid. The 2026-10-18 chapter-resources spec already noted, as an open
  item, that the retry cannot cure a reservation too big for its unit.

A retry that cannot succeed costs time and money, and code that quietly drops rows hides the plan's real weak spots from
the learner. The learner should see them and decide.

## Goals

- The top-level outline call writes, for each unit, its minutes per activity: reading, and each practice format the
  allocation picked. Units may differ freely, within their own hours.
- Every later step uses the unit's own minutes where it uses the even split today: the prompts that plan a unit's
  children, the sizing of listed practice runs (how many NeetCode problems a week gets), and the checks.
- The plan's totals stay the allocation's: reading per material, practice time per format.
- No automatic retry of any drafted level. No row dropped or trimmed because a check failed.
- Every check failure is shown to the learner in the conversation panel, in plain words, after the draft or level it
  belongs to.

## Non-goals

- A Regenerate button. Regenerating or fixing is done by asking in the chat (the learner's decision); the chat gets a
  re-draft tool for it (§6).
- Changing the allocation call, beyond what the outline now needs from it. (Allocation budgets that no whole set of
  chapters can meet, such as 210 min against 129-min chapters, are a separate change; under this design they surface as
  a reported problem.)
- The item finder's JSON path missing keyed-map files (the NeetCode file), and prompt caching. Both separate.
- Persisting the conversation panel's messages.

## Anti-goals

- Code rewriting the plan to make a check pass: rescaling the model's minutes to fit, dropping rows, moving
  reservations. The model's plan stands as written; problems are reported.
- Reintroducing a per-unit split by another name (for example a default per-unit share the model is told to keep).
- Reports in admin-only terms: aliases such as `M1`, internal rule names, or the word "breach" in what the learner reads.

## Decisions (the learner-owner's)

1. **The outline decides each unit's time per activity**, from the input materials; the allocation decides the totals.
2. **The even weekly split goes**, with the four rules that enforce it (listed below).
3. **No retry.** Checks run once and report.
4. **Every rule reports, placement rules included.** Nothing is fixed quietly; a row outside its parent's reservation or
   a problem two weeks both take stays as written and is reported.
5. **Reports go to the conversation panel**, appended to the response for that draft.
6. **Chat only** for acting on them, for now — and the chat can **re-draft**: a new chat tool re-runs the outline for
   one level or the whole plan (§6).
7. **Problems found when a week is planned from the track page are saved** with the week and shown there (§5).
8. **Changing hours per week or the time split after drafting re-drafts the outline** for the units not yet started
   (§7), rather than rescaling or keeping stale minutes.

## Design

### 1. A unit's time

Each heading the outline drafts carries its time: minutes of reading, and minutes per picked practice format, e.g.

```
Week 1: reading 150 · Problems 180 · Design 30            (= 360, the week's 6 h)
Week 8: reading 0 · Problems 90 · Design 120 · Mock 150   (= 360)
```

- The top level gets the plan's totals in its prompt — reading per kept material (the allocation's `parts` minutes),
  practice per format (`formatHours` over the plan's hours, and for a listed source the doing time of its kept items),
  and each block format's plan budget (`planBlockBudgets`) — plus each unit's hours. It is told the units may weight
  differently, that each unit's minutes must fit its hours, and that across the units each activity should add up to its
  plan total.
- A level below a heading gets the heading's minutes as its totals, the same way: a month's weeks share out the month's
  minutes; a week's days share out the week's.
- Week leaves (a plan in week granularity, where the top level is the leaf level) write their rows as today; their time
  is the sum of their rows, and the top-level prompt states the plan totals the same way.
- Stored per node, alongside `budgetHours`. Builder's call on shape and column (a `jsonb` on `plan_nodes` is the obvious
  fit; `tracks.split` is already `jsonb`).
- **Reading minutes are must-reading** (*my call*). Should-tier reading stays an optional extra inside a day's own time,
  as today, and counts in no unit's stated reading; the prompts say so.
- **Shown to the learner** (*my call*): a heading's line in the plan tree (`PlanTree`, used by the workspace and the
  track page) shows its time, e.g. "2 h 30 min reading · 3 h problems · 30 min design", so the reports and the chat
  refer to a number the learner can see.

### 2. What uses a unit's time instead of the even split

| Today (even split) | After |
|---|---|
| `weekBudgetsOf` in `planPrompt.ts` — the per-unit budget lines and the leaf rules ("the week has about 72 min of reading…") | the parent's own minutes |
| `leafPracticeRules`: `fitWeekToDays(weekPracticeTime(weekBudgetsOf…))` | the week's own minutes, still fitted to what its days hold |
| `sizeItemRuns`: each unit's run sized by `practiceBudgets` over its weeks | sized by the unit's own minutes for that format |
| `weekRule` and the heading reading check in `levelChecks` | removed (see §3) |

**Plans saved before this change** have no unit time. *My call:* they keep today's even split as the stand-in wherever a
unit has no minutes of its own, so existing tracks still plan their next week; nothing is migrated.

### 3. The checks

`levelChecks` / `treeChecks` keep their structure and their messages' facts; what changes is which rules exist and that
none of them blocks or triggers anything.

**Removed** (they hold a unit to the even split):

- Heading reading over-budget — "Week 3 reserves about 154 min of reading against a budget of about 72 min"
  (`materials.ts` ~1418).
- `weekRule` must-reading — the days' must-reading against the week's even reading share (~1299).
- `weekRule` per-format practice — e.g. Problems against 54% of the week's practice (~1321).
- `weekRule` total practice (~1336), and the "practice short" fact that is its mirror.

**Kept, now reports:**

- Placement: `whole-book`, `outside`, `overlap`, `review-before-read`, `practice-outside`, `practice-overlap`,
  `practice-generated`.
- Coverage: `unread-reservation`; `budget-miss` (a material's reserved units against its allocation budget, plan-wide).
- A day's reading and practice against the day's time (~1411) — a real limit: the learner has that much time that day.

**New, reports:**

- **Unit capacity:** a unit's minutes (headings: its stated time; leaves: its rows) against its hours. Same tolerance as
  today's day rule (`budgetCeiling`) — builder may revisit.
- **Plan totals per practice format:** across the top-level units, each format's minutes against its plan total, with
  `budget-miss`'s slack. (Reading per material is already `budget-miss`.)
- **Children against their parent:** a level's minutes per activity, summed, against the parent's minutes for that
  activity, same slack.
- **Reservation against stated time:** a heading's reserved reading (chapter sizes) against the reading minutes it
  stated for itself. This is what catches "week 3 reserves a 129-min chapter but gave itself 60 min of reading".

### 4. No retry, no drops

- `draftLevel` streams once and returns. The retry branch, `RETRY_HEADER`, the `silent` stream option and the
  out-of-time drop path go.
- No `dropBreaches` after a draft, an expansion, or a chat revision (`planRevision.ts` runs `treeChecks` then
  `dropBreaches` today; *my call:* revisions report the same way, since the rule is "code never changes the plan").
  `dropBreaches` and `DROPPABLE` can go if nothing else uses them.
- Code that **sizes** rather than fixes stays: `sizeChapterRows` (chapter rows add up to the chapter's measured size)
  and `sizeItemRuns` (code assigns item runs; the model only names the units). These are how the plan is built, not
  corrections of a failed check.
- The model-call log keeps its `facts`, problems included, for the admin panel.

### 5. Reporting in the conversation panel

- The stream events that end a draft and an expansion (`finish` in `lib/planChat.ts`) carry the level's problems as
  learner-facing lines.
- `PlanWorkspace` appends them to the assistant message it already writes on `finish` (`draftedText` after a draft; the
  "planned …" message after an expansion). No problems, no addition.
- Wording is for the learner: material titles and chapter names, not aliases; minutes as hours where long; one line per
  problem; an ending that says they can ask the chat to fix it or regenerate. Example:
  - "Week 3 plans 2 h 10 min of reading in a week that gave itself 1 h for it."
  - "Problems add up to 21 h across the plan; the time split gave them 26 h."
  - "*Designing Data-Intensive Applications* gets about 2 h 10 min of chapters; the plan meant to give it 3 h 30 min."
- The chat's own revisions report the same way, in the reply that applies them.

**Saved problems.** Problems are stored with the node whose level they belong to — the track for the top level, the
week (or month) for the level planned inside it — and replaced whenever that level is drafted, re-drafted or revised.
The conversation panel shows them on `finish` as above. **When the learner plans a week from the track page**
(`expandNodeAction`, no conversation panel), the week's saved problems are shown on the track page with that week, and
on the week's own page. Storage shape is the builder's call (a `jsonb` on `plan_nodes` and `tracks` fits).

### 6. The chat: seeing, editing and re-drafting

- **Editing** (*my call*, needed for the chat to fix any time problem): the revision prompt (`buildRevisionPrompt` /
  `renderTree`) shows each unit's time, and the revised-tree schema (`revisedTreeSchema` / `RevisedUnit`) lets the chat
  write it. A unit the chat adds, merges or re-lengthens gets its time from the chat, never from an even split; a unit
  left without minutes is reported, not filled in. `applyRevision` keeps a kept unit's minutes unless the chat changed
  them. After a revision the checks run and report (§4).
- **Re-drafting** (the learner-owner's decision): a new chat tool beside `revisePlan` re-runs the outline through
  `draftLevel`, for one level (a heading's children, or the top level) or the whole plan. It goes through the same
  sizing (`sizeItemRuns`, `sizeChapterRows`) and checks as a first draft and reports the same way. *My call:* it
  re-drafts only units not yet started — completed or started units, and their reservations and items, stay and are
  given to the outline as taken (the existing lock, `LockedNodeError`, marks what can't change). The chat chooses the
  scope from what the learner asked.

### 7. Changing hours or the time split after drafting

`changeHours` / `changeSplit` in `PlanWorkspace` and `confirmRevisionAction` on the adjust page re-draft the outline for
the units not yet started, through the same path as §6's re-draft tool (whole-plan scope), instead of keeping minutes
that no longer fit or rescaling them. A split change runs the allocation first when that is how it works today.

## What's left to the builder

- The shape and storage of a unit's time, and its migration.
- The exact prompt wording for the top level and the levels below, within §1.
- Tolerances for the new checks (start from `budgetCeiling` and `budgetMissSlack`).
- How each report is worded, within §5's rules.
- Removing code that becomes dead (`weekBudgets` callers, `fitWeekToDays`/`weekPracticeTime` if unused, `DROPPABLE`).
- Tests: update the planDraft / materials / planPrompt suites; the 2026-11-02 export is a good fixture for "a week
  reading a 129-min chapter is reported, not retried".

## Calls made without the learner-owner (check these)

- Revisions by the chat report instead of dropping rows (§4).
- `sizeChapterRows` and `sizeItemRuns` stay: they build the plan, they don't correct it (§4).
- Plans saved before this change keep the even split as a stand-in where a unit has no minutes (§2).
- A unit's reading minutes are must-reading only (§1).
- A heading's time is shown on its line in the plan tree (§1).
- The chat can see and edit unit time; new or merged units get their time from the chat (§6).
- Re-drafting, and the re-draft after an hours or split change, leave started and completed units alone (§6, §7).
- Problems are saved for every level, not only those planned from the track page, so one store serves both places (§5).
