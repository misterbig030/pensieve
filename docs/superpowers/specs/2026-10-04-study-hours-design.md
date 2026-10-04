# Study hours, sized materials and the plan's time split

Date: 2026-10-04 · Amends `2026-09-28-research-materials-design.md` · Mock: https://claude.ai/artifact/8SEs5hLGjsPZw9VywnDR6U

## Why

The research build hardcoded three numbers that belong to the learner or the topic, not to the code:

- six study hours a week (`budgetFor`);
- "12 to 25 materials", whatever the plan's length;
- 60% of every unit's time for must-reading, "because the rest is for building" (`MUST_SHARE`), which is wrong for
  history (nothing to build) and for training (almost nothing to read).

## Decisions

1. **The learner says how much time they have.** The new-track form asks for hours a week: Casual (3), Part time (6,
   the default and today's behaviour), Full time (30), or a custom number from 1 to 80. Stored on the track as a
   number. Every unit's budget derives from it; a day's budget is the week's hours over seven.
2. **Research finds and sizes materials, nothing else.** Its brief carries the total hours as a ceiling. The count
   target is gone. Each candidate carries the minutes for the part the plan would use and, when that is not the
   whole work, which part. Research also names the topic's main areas it covered and the ones it left open.
3. **Sizes are measured where code can measure.** A book's page count from Open Library, a video's runtime from its
   page, an essay's length from the page that was read. Otherwise the model's estimate stands and is labelled
   "estimated". The basis is stored with the material and shown.
4. **The drafter decides the split.** With the top level it returns `split`: the share of time spent reading or
   watching, what the rest is spent on in the topic's own words, and one sentence of reason. Later levels are
   budgeted from it. The fixed 60% remains only as the fallback for plans that have no split.
5. **Code enforces only hard limits.** A unit's assigned minutes may not exceed its budget (existing check). A new
   fact reports a unit whose must-reading runs well past the plan's own reading share.
6. **Thin research is about coverage.** `thin` when fewer than 3 researched materials verified, or when at least as
   many of the topic's areas are open as are covered.
7. **Research caps scale with the plan's total hours** (searches/page reads): ≤10 h 3/6, ≤40 h 5/10, ≤100 h 6/12,
   above 8/16.
8. **Hours and split can change later.** In the workspace (create and adjust) the learner can edit both. Week units
   that are not locked take the new budget at once; units planned afterwards use the new values. Nothing is
   redrafted automatically.
9. **A brief that names a different number is flagged on the form** ("about 15 hours a week" against a setting of
   6), with one click to use the brief's number. The setting is what the plan uses.

## Data

| Where | Field | Notes |
|---|---|---|
| `tracks` | `hours_per_week integer not null default 6` | |
| `tracks` | `split jsonb` | `{ readingShare 0–100, practice, reason }`, null on older tracks |
| `sources` | `minutes integer`, `minutes_basis text`, `uses text` | basis `measured` or `estimated` |
| `Material` (wire) | `minutes?`, `minutesBasis?`, `uses?` | optional, so older payloads still parse |
| Requests (draft, expand, chat) | `hoursPerWeek?`, `split?` | default 6, null |
| Events | `split` after the top level; `research.done` gains `coverage` and `sizedMinutes`; `research.verified` gains `minutes`, `basis` | |

## Out of scope

Suggesting a plan length from topic and hours; per-week splits; automatic redrafting when hours change; changing the
split through the conversation (the control is direct); sizing by reading speed per learner.

## Eval

Golden v3 records may set `hoursPerWeek`. New run metrics: sized hours against total hours, and the share of
materials whose size was measured. Rubric dimension 5 (fit to the kind of topic) is where the split is judged.
