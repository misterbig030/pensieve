# Practice formats: concrete practice instead of leftover time

## Intent

Today a plan splits the learner's time into reading and "practice" (`PlanSplit`: `readingShare`, a `practice`
label, a reason). Practice is never planned: each unit shows "x h left for practice problems", which is just the
budget minus the reading (`BudgetBar`, `components/pensieve/ReadTable.tsx`). Nothing tells the learner what to do with
that time, the lesson generator is never told about it, and optional reading quietly eats it. The owner finds the
leftover number confusing and wants it gone, but not by turning every plan into reading: for interview prep, skills
and physical topics the practice is the plan.

So practice becomes assigned work. Each unit lists what to read and what to do, the two add up to the unit's budget,
and the lesson explains how to do each task and how to check it.

The owner's quality bar: practice has to be solid enough that a learner will spend 40 minutes on it. LLM-invented
exercises are not, unless they are tied to the unit's own reading or produce something checkable. Practice comes from
established sources wherever they exist.

Interview prep is the first topic to get right (the owner's own tracks are AI-infra and AI-engineer interview prep);
the design must carry to every other topic without topic-specific code.

## Goals

- Every unit's time is accounted for: reading rows plus practice rows, each with minutes, adding up to the budget.
- Practice rows say what to do, where (a found source or the unit's reading), and when it's done.
- The plan picks practice that fits the topic: coding problems, design exercises and mock rounds for an SDE loop;
  recall for history; sessions for running; labs for Git.
- Practice sources are found by research and verified like reading is.
- The picks are testable: eval briefs assert which formats a topic gets.

## Non-goals

- Grading the learner's answers or code.
- Tracking completion per practice row (check-ins stay per unit).
- Editing the practice formats from the UI in the first version (the reading share slider stays; see Later).
- Rewriting existing plans. They keep what they have; only the leftover line goes (see Existing plans).

## Anti-goals

- Topic detection in code (`if (topic.includes("interview"))`). Code acts only on the formats the model picked.
- Vague generated busywork ("reflect on branching"). A generated task has a concrete output and a done condition, and
  says it was generated.
- Practice that silently shrinks: optional reading must not eat practice time again.

## Decided with the owner

- A fixed list of practice formats lives in code; the model picks a subset per plan with a share and a focus each.
- Sources first; generation only as a grounded, labelled fallback.
- Interview prep first, extendable to all topics.
- The seven formats below (drafted against all 26 eval topics; every format is used by at least two).
- Three interview briefs are in `evals/research/golden.v3.ts` (merged in #20).
- Practice shares balance over the week: a day may be all practice (a mock day, a design day) or all reading; only
  each day's total time has to fit.

## The formats

One registry, `lib/practice.ts`, is the contract. Each entry has an id, a learner-facing label, a line for the
prompts, how a row is sized, what research looks for, and whether a row may be generated.

| Id | Label | The learner | Done when | Sized by | Research looks for | Generated allowed |
|---|---|---|---|---|---|---|
| `problem-set` | Problems | solves many small problems, each with an answer | solved and checked against the solution | problems × minutes by difficulty | curated problem lists with solutions (NeetCode, LeetCode lists, DataLemur, Rustlings, Exercism, a book's practice problems) | no |
| `recall` | Recall | answers questions or flashcards from memory, aloud or written | checked against the answers or the reading | questions × 3 min | question banks with answers, official revision questions | yes, from the unit's own reading only, answers included |
| `design-exercise` | Design | takes one open prompt, timed, then compares | compared with a worked solution or rubric | 45–60 min per prompt | design question sets with worked solutions, worked designs in the materials | yes, if paired with a rubric of what a strong answer covers |
| `lab` | Lab | follows guided steps in a real tool | the source's own check passes | the source's stated time, else steps × 5 min | interactive tutorials, course labs (Learn Git Branching, vimtutor, CS:APP labs) | no |
| `project` | Project | builds one thing across units, one milestone per unit | the milestone runs or exists | what's left of the practice time | a course's project, else none | yes: milestones of a build the plan names, each with a done condition |
| `mock` | Mock | does a full run under real conditions | scored, or recorded and reviewed | the real exam or interview length + 15 min review | official mock tests, mock-interview formats | yes for interview mocks (prompt + rubric); no for exams |
| `session` | Session | repeats a routine with one thing to notice | done and logged | the programme's prescribed length | training programmes, technique exercises, recipes | yes, if built from a found programme or the unit's reading |

The table is the starting registry; the builder may tune minutes per item. Adding a format later means one entry
here, its prompt line, its sizing, and a research objective.

## How it flows

### 1. Picking the practice (before research)

The split moves from the first drafting call to a new call before research, because research must know which practice
to look for. The call takes the brief (topic, instructions, weeks, days per week, hours, the learner's sources) and
returns:

```ts
{
  readingShare: number,              // 0–100, as today
  practice: {
    format: PracticeFormat,          // one of the registry ids; anything else fails validation
    share: number,                   // percent of the practice time; normalised to 100 in code
    focus: string,                   // what it drills, e.g. "coding rounds: arrays, graphs, DP at medium"
    reason: string,
  }[],                               // 0–4 picks; empty means the plan is all reading
  reason: string,                    // one sentence, as today
}
```

The prompt describes each format in one line and gives worked examples (an SDE loop, an MLE loop, history, Git,
Couch to 5K). Interview knowledge lives in those examples, not in code. The learner's instructions win: "no apps and
no video" or "I want to implement things myself" shape the picks.

`PlanSplit` gains `formats` (the picks). Its `practice` string stays as the label shown for practice as a whole
(today's field), now written by this call. A plan drafted against a given split (adjust, re-draft) keeps it, as
`streamPlanDraft` does today.

The drafter stops deciding the split (`decideSplit` and `topUnitListSchema`'s `split` go). Its prompt gets the
decided split instead, as later levels already do.

### 2. Research finds practice sources

Each pick becomes a research direction with the format's objective and the pick's focus ("curated coding problem
lists with solutions for: arrays, graphs, DP at medium"). In arm W it's one more worker, sharing the band's caps;
in arm A it's a step in the prompt's work order. The default arm and the caps split are the builder's call.

Candidates gain an optional `practice` field:

```ts
practice?: { format: PracticeFormat; items: number | null; perItemMinutes: number | null; answers: boolean }
```

The learner's own sources are tagged the same way: research already reads each learner link first, and the candidate
step's `learner` entries gain the same optional `practice` field, so a learner's NeetCode list is used as practice.

One source can serve both roles (a book's chapters as reading and its practice problems as practice): when the reading
and practice directions find the same URL, the merged material keeps its reading fields and gains `practice`. Reading
coverage and the thin-research notice count reading only.

`answers` says whether the source gives solutions or a rubric; a practice source without answers is kept only for
`lab`, `project` and `session`. A practice source's `minutes` is doing time (items × per-item minutes, or the
source's stated time), not reading time. Practice sources are verified by the same gate as reading (fetched, title
matched). Coverage reports a pick with no verified source as open, like an uncovered area today.

The materials list shows practice sources in their own group ("Practice") with format, item count and whether
answers are included. `sources` gains a nullable `practice` jsonb column.

### 3. Drafting assigns practice rows

Shares balance over the week, not inside each day (decided with the owner). A week's budget divides in code:
`readingBudget = budget × readingShare`, and the rest by the picks' shares into a practice budget per format. On a
week-unit plan the week is the leaf and holds all of it. On a day-unit plan, or a week split into days, the week's
reading and practice budgets are shared out over its days as whole tasks: a day may be all practice (a mock day, a
design day) or all reading, and only each day's total has to fit its own budget. A 45–60 minute design exercise or a
full mock is never cut to fit a day's share; it gets a day that has room for it. The drafter is told the week's
budgets per format and asked to place long tasks on whole days.

Leaves get a second table next to `materials`:

```ts
interface PracticeRef {
  format: PracticeFormat;
  sourceId: string | null;   // a practice source, or the unit's reading for generated recall; null for generated
  task: string;              // "NeetCode 150 · Arrays & Hashing, problems 1–6"; "Design a URL shortener"
  done: string;              // "all six pass; compare with the video solutions"
  minutes: number;
  generated: boolean;
}
```

Headings reserve practice sources the way they reserve reading, with the part in free text ("Arrays & Hashing and Two
Pointers"), so a long problem list is shared out in order across weeks. In the first version the parts are free text:
the drafter is told which parts other units hold, as it is for reading, but code does not parse problem lists, so it
cannot catch two weeks assigning the same problems or check a row's minutes against an item count. A structured item
list (an extraction step like `chapterFinder` for problem lists) is Later.

Stored in a new table `node_practice` (node id, role `covers` or `assigned`, position, format, source id nullable,
task, done, minutes, generated). It holds both a heading's practice reservations and a leaf's practice rows, so a
source reserved for reading in `node_materials` and for practice in `node_practice` never collides; generated rows
have no source, which `node_materials` would not allow.

Checks in code, extending `levelChecks`:
- over each week (the week leaf, or a week's days together), each pick's practice minutes and the `must` reading are
  within their share of the week's budget (tolerance as for reading today); a single day is checked only against its
  own total budget, so reading-only and practice-only days pass;
- a sourced row's source is in the unit's reservation; a generated row is allowed only where the registry allows it;
- generated recall cites the unit's own reading;
- `must` reading fits the reading budget, and `should` reading fits what `must` leaves of it, over the week as
  above. Optional reading no longer comes out of practice.

This replaces today's per-day reading check (a day's must-reading within the share of that day), which would refuse a
reading-heavy day next to a mock day.
Breaches retry once and are dropped, as today.

When a pick has no verified source, the drafter may generate for formats that allow it, and must not for those that
don't. If nothing can be assigned, that pick's time goes back to reading and the drafting call says so in its facts.

### 4. The lesson explains each task

`buildDailyContentPrompt` gets the practice rows. For each: what to do, where (link), how to check (the source's
answers, the rubric, the reading section), and the done condition. Generated recall questions are written here with
their answers collapsed. Citations stay limited to the unit's list.

### 5. What the learner sees

- The unit's table has two parts: Read (Must, Should) and Do (one row per practice task, with a format pill, minutes,
  a source link or a "Generated" tag, and the done line).
- The budget line reads, for example, "3 h 11 reading · 2 h 49 practice · 6 h". Nothing is "left for" anything.
- The time card shows reading and each practice format with its hours and focus, with the existing reading share
  slider.
- A split week's kept table (PR #19) keeps its practice rows too.

## Existing plans

Plans saved before this have a `split` without `formats` and no practice rows. They keep their reading; the "left
for practice" line is replaced by "x of y h reading". Nothing is migrated.

## Evals

- `ResearchGoldenRecord.labels` gains `formats?: { include?: PracticeFormat[]; exclude?: PracticeFormat[] }`.
  Labels to add: the three interview briefs (SDE: problem-set, design-exercise, mock; AI product: recall,
  design-exercise, mock; MLE: recall, design-exercise, and problem-set or mock), French Revolution (recall; no
  problem-set), Couch to 5K (session), Deep learning full time (project), SQL for data analysis (problem-set).
- `metrics.ts` records the picks, format hit and miss against labels, the share of practice rows that are sourced,
  and practice picks left open.
- A unit test pins the pick-call schema and normalisation; the drafter tests cover the budget split and the new
  checks.

## Order of work

Each step ships on its own:
1. Registry, the pick call before research, `PlanSplit.formats`, time card display, eval labels and metrics. The
   leftover line becomes "x of y h reading".
2. Research practice directions, the `practice` field on materials, the materials list group.
3. Practice rows: drafting, checks, `node_practice`, the Do table, the budget line, the kept table.
4. The lesson.

## Left to the builder

Prompt wording; the exact registry minutes; where the pick call's model comes from (the outline model is the
obvious choice); how arm W shares caps with a practice worker; table and component names; how revisions carry
practice rows (keep kept rows the model leaves out, as references do today).

## Later

Editing picks from the time card; per-task completion; answer checking; more formats (for example language
conversation partners); structured item lists for problem sets and question banks, so code can check order, overlap
and sizing as it does for book chapters.
