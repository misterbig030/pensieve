# Outline benchmark: which gateway models can write each kind of outline call

Status: draft for approval. Adds the `outline` task to the benchmark framework under `benchmarks/` (merged in PR #29,
designed in `2026-10-29-model-benchmark-design.md`, which still governs everything this document does not change).

## Why

Users without their own key will run on the app's gateway key, and the outliner runs Opus 5.5 at high effort for every
call. The allocate benchmark answers the question for the allocation step; this answers it for the outliner, the step
the app calls most: once for the plan's top level and again every time the learner reaches a unit that has not been
split yet.

The owner accepts a different model for different kinds of outline call *(owner's decision)*, so the benchmark gives a
verdict per kind of call, not one for the outline stage as a whole. A cheap model that writes good days but weak
top-level outlines is a useful answer.

## Goals

- For each contestant and each **call group** (below): the framework's usual row (score with a 95% interval, paired
  difference from the baseline, completion, `pass^3`, cost per sample, p50/p90 latency) and a verdict: qualifies, worse
  or inconclusive, by the framework's rule (5-point margin, `--margin` to change it).
- Every sample's prompt is built by the app's current code from frozen inputs, so a prompt change (like PR #43) reaches
  the benchmark without recapturing fixtures.
- Criteria weighted the way the owner ranked them (below).

## Non-goals

- Routing different outline calls to different models inside the app. The benchmark says which model is good enough
  for which group; wiring that up is a later change.
- The `research` and `draft` tasks, and pricing.
- Fixing the draft eval's own checks (PRs #46, #47). The top-level timeout fix (#48) is merged and the benchmark follows
  its call shapes; re-drafting (#49) is a separate flow and not benchmarked.

## Anti-goals

- A sample that calls the outliner differently from the app: it calls the app's own level function with the options the
  draft passes, changing only the model and its effort.
- One contestant's earlier output leaking into another's input. Each sample writes one level onto a frozen plan; no
  sample depends on another.
- A judge that sees the model's name or raw JSON.
- A model credited for something the app's code wrote. Where the app rewrites the model's output after the call (chapter
  rows sized from the list, ids put in words), the criterion reads what the model wrote, or says that the app did it.

## Decisions

### One sample is one outline call *(my call)*

The outliner writes a plan one level at a time: `draftLevel` in `lib/ai/planDraft.ts`, one model call per level. A
sample is one such call on a frozen input: the request, the allocated materials, the split, the plan as it stood before
the call (the levels above, already written by the baseline), the level and spans, and the parent. Only that call's
output is scored. A slip at the top level can then never cost a model points at the day level, and every contestant
sees exactly the same input.

The task is `outline`, its role is `outline`, and contestants change only that role's model and effort.

### Fixtures are rebuilt inputs, captured from draft-eval runs *(my call)*

`--capture <run folder>` (the existing command, extended) writes one `outline` fixture per outline call the run made,
next to the existing `allocate.json`:

- The run's request (`meta.request`, or the topic's), the `allocated` materials and the `split` event, as the allocate
  fixture already takes them.
- For each outline call in `calls.json` (labels `Top level · …`, `Month 1 · 4 weeks`, `Week 1 · 5 days`): the level, the
  parent's id and the tree as it stood before the call: `plan.json` with the parent's descendants removed. Spans are
  recomputed with `topSpans` / `childSpans`, as the app does.
- A run whose top-level call failed (the Nov 5 `mle` run timed out) still gives a top-level fixture: its input is only
  the allocation and the request.
- The baseline's tokens and latency for that call, for estimates.

The prompt is not stored. Each sample builds it with `buildUnitsPrompt` from the fixture, so fixtures stay valid when
the prompt changes. A fixture records the commit it was captured at; a schema change that breaks old fixtures fails
loudly at load, naming the fixture.

**Following the app's call shapes.** The capture and the sample runner call the same functions the app calls for that
plan shape. Since #48 (merged 2026-11-06), a plan with more than four week leaves at the top level is written in two
steps: one call plans the weeks as block headings (`Top level · 8 weeks in 3 blocks`, month headings of at most three
weeks), then one call per block writes its weeks (`Weeks 1–2 · 2 weeks`), all blocks at once. Each is a fixture: the
block-heading call is a top-level heading call, and a block call is week leaves inside a month. *(The owner chose to
build on #48.)*

The block headings are dropped from the finished plan, so `plan.json` does not have them. The capture rebuilds them from
the block-heading call's recorded response, parsed and post-processed as the app does, and a block call's tree is those
headings alone (blocks run in parallel, so no block sees another's weeks). A plan of four or fewer top-level week leaves
is still one call; no source run has that shape.

**Every fixture is checked against its recording** *(my call)*: at capture, the prompt `buildUnitsPrompt` builds from the
fixture must equal the prompt recorded in `calls.json` for that call, on the commit the run was recorded at. A mismatch
fails the capture and names the call. This proves the rebuilt tree, reservation and spans are what the baseline saw.

**Source runs.** On the owner's Anthropic key:

- The Nov 5 runs of eight topics added in PR #45: `csapp`, `finance`, `sqlwin`, `aieng`, `deeplearning`, `aieng-daily`,
  `ml-daily`, `frenchrev`.
- `c25k`, `mle` and `sde`, recorded again on 2026-11-06 on the #48 code (owner approved). The Nov 5 `c25k` and `mle`
  runs made one top-level call that #48 replaced, and are not used.
- The Oct 30 `sde` runs (already the allocate fixtures `sde-1`..`sde-3`) predate unit time (#42): their weeks have no
  stated time, so their outline prompts differ from today's and they give no outline fixtures.

| Call kind | Group | Fixtures from |
|---|---|---|
| Top level as days | top | `sqlwin` |
| Top level as week headings | top | `sde`, `csapp`, `finance` |
| Block headings over week leaves (#48) | top | `c25k`, `mle` |
| Top level as month headings | top | `aieng`, `deeplearning`, `aieng-daily`, `ml-daily`, `frenchrev` |
| Week headings inside a month | inner headings | `aieng-daily`, `ml-daily`, `frenchrev` |
| Week leaves inside a month | leaves | `aieng`, `deeplearning`, and each block of `c25k`, `mle` |
| Days inside a week | leaves | `sde`, `csapp`, `finance`, `aieng-daily`, `ml-daily`, `frenchrev` |

### Call groups *(my call; the owner accepted per-group verdicts)*

Verdicts are given per group: the units the app could route to one model.

| Group | Calls | Why together |
|---|---|---|
| **top** | every top-level call, headings or leaves (and #48's block headings) | once per plan, the whole plan's budgets and materials in one prompt: the hardest call |
| **inner headings** | weeks inside a month that will be split into days | middle levels, held to a parent's reservation |
| **leaves** | days, and week leaves inside a month (and #48's block contents) | the calls made most often, so the cheapest to move to a cheaper model |

A contestant can qualify for one group and not another. A group with one fixture gives no quality verdict, by the
framework's rule; completion can still make it worse.

### Criteria and weights *(ranking: owner's; weights and graders: my call)*

The criteria follow the kind of call, not its level: a **leaf** call writes the smallest units with their reading tables
and practice rows; a **heading** call writes units to be split later, with what they set aside and their time. The
owner ranked both lists; the weights follow that order (4, 3, 2, 1). Scoring is the framework's: met weights over
positive weights.

**Leaf calls**

| Weight | Criterion | Graded by |
|---|---|---|
| 4 | **Time fits.** Each unit's reading and practice fit its budget; the units together match what the parent set aside per activity. | code: `levelChecks` breaches `over-budget` (days), `over-capacity` (week leaves), `parent-miss`; at the top level also `budget-miss`, `format-total-miss` |
| 3 | **Minutes realistic for the material.** A row's minutes fit the size of what it reads or does. | code where the size is known (a resource or practice item with minutes or pages); judge otherwise. Listed chapter rows are sized by the app (`sizeChapterRows`), so for them this reads the model's own minutes before sizing. |
| 3 | **The note says where to start and stop.** A learner can open the material and find the part. For a book without a chapter list, by topic only (PR #43). | judge |
| 2 | **Picks up where the previous unit stopped.** Only what the parent set aside; listed chapters and list items in order across the units; nothing set aside left unread; a chapter on two units only if they are consecutive and each note names its part. | code: breaches `outside`, `overlap`, `whole-book`, `review-before-read`, `unread-reservation`, `practice-outside`, `practice-overlap`, plus a new order check; at the top level, the every-material check of the heading list instead of `unread-reservation`. For a book without a chapter list, judge. |
| 2 | **Title and summary match the unit's rows.** | judge |
| 1 | Practice uses only what has been read by then. | judge |
| 1 | Each task says what done looks like (`done` field). | judge |
| 1 | The unit has one focus. | judge |
| 1 | Written for the learner: no ids, no chapter or section names it was not given, no filler. | judge, except ids: by code only, read before the app puts them in words (the judge sees the rewritten text) |

**Heading calls**

| Weight | Criterion | Graded by |
|---|---|---|
| 4 | **Time fits.** Each unit's stated minutes fit its hours; at the top level, the totals per activity match the split's budgets. | code: breaches `over-capacity`, `no-time`, `budget-miss`, `format-total-miss`, `parent-miss` |
| 3 | **Title and summary match what the unit has.** A heading promising a mock with no mock minutes, or graph problems while its items are still trees, fails. | judge, given each unit's minutes and set-aside items |
| 3 | **What it sets aside fits its reading time.** | code: breach `reading-over-stated`, and the set-aside size against the unit's reading minutes where sizes are known; judge otherwise |
| 2 | **Sets aside materials in order, no gaps, no repeats.** Every allocated material is set aside somewhere (top level); listed chapters and items in order; each in one unit. | code: breaches `outside`, `overlap`, `whole-book`, plus a new order check and an every-material check |
| 2 | **Each unit builds on the ones before it.** | judge |
| 1 | Written for the learner: no ids; a book without a chapter list named by topic, never by chapter or section. | judge, except ids: by code only |

A top-level call whose units are leaves (`sqlwin`'s days) takes the leaf list with the plan-wide checks added as noted,
so it is held to the split's totals like a top-level heading call. `no-time` (a heading that states no time) counts
under the heading list's time criterion.

**Time-fit gate** *(my call)*. Besides its weight, a sample where any unit is past the app's own ceiling
(`budgetCeiling`: the breach `over-capacity` for headings and week leaves, `over-budget` for days) fails the completion
gate and scores 0. The owner put time first in both lists; a
plan that does not fit the learner's week is unusable whatever else it does well.

The judge's criteria are each judged met or not with one sentence of reason, one judge call per call kind with all its
judge criteria together and the rendered output in a cached prefix, as the allocate task does. The judge sees what the
model was given in the form the rubric already uses: the request, `renderMaterials`, the plan around the level
(`renderTree`, parent marked), what the parent set aside, the budgets, and the level as written. It never sees the
contestant's name.

### Completion gate and time limit *(my call)*

The framework's gate applies: schema-valid output, no error, within the time limit. The time limit for a sample is the
time the source run had left when that call started, at least `STEP_MIN_MS`: the draft's deadline is the app's own
limit for these calls, and this is what a user on that plan would have waited. A call's start is its record's
`endedAt − latencyMs` (wall clock), and the deadline is `meta.startedAt + DRAFT_BUDGET_MS`, as `evals/draft/run.ts` sets
it. The events' `t` is not used: it is stamped when the stream is read, seconds after the call ended. (Checked on the Nov
5 `csapp` run: the top level ran 70.2–87.7 s and Week 1 started at 87.7 s, with 197 s left.) Block calls all start when
the block headings land, so they share one limit. The baseline can fail the limit too; the Nov 5 `mle` top level did.
*(This replaces the parent design's "the outline's share of the draft budget", which the app never fixed as a number.)*

A call that returns fewer or more units than asked is not a gate failure: the app reconciles spans, and the criteria
score what came back.

### Contestants and rounds

Contestants come from `benchmarks/contestants.ts`, on the outline role. Two rounds, each started only with the owner's
go-ahead and a printed estimate:

1. **Screen**: every candidate on one fixture per group, 2 epochs.
2. **Confirm**: per group, the top three from round 1 on every fixture in that group, 3 epochs.

The cap is the framework's `--max-usd`, default $10.

### Running it

```bash
npx tsx benchmarks/run.ts --capture evals/results/draft-<ts>-<topic>-1 …    # the source runs above; adds outline fixtures beside allocate.json
npx tsx benchmarks/run.ts --task outline --groups leaves --fixtures <ids> --contestants <names> --epochs 2
npx tsx benchmarks/run.ts --rescore benchmarks/results/<ts>-outline
```

`run.ts` is written for `allocate` today (`TASK = "allocate"`); it becomes task-driven, with `allocate` unchanged.
Runs use the app's gateway key, as the framework requires.

**One app change** *(my call, as the allocate task did for allocation)*: `streamUnits` hard-codes `OUTLINE_EFFORT`, so a
contestant's effort cannot reach the outline call. `DraftLevelInput["ctx"]` gets an optional effort, defaulting to
`OUTLINE_EFFORT`; the app passes none, so its behaviour does not change.

### What the report adds

The framework's report, once per group: the comparison table, score by criterion group, criteria met per contestant,
samples. A last section, **routing**, lists for each group the cheapest contestant that qualifies, or "none yet".

## Also on this branch

- The benchmarks README's Round 1 example uses `--fixtures sde-1`; it should be `sde-2`.

## Left to the builder

- Module layout (`benchmarks/tasks/outline.ts` beside `allocate.ts` is the obvious place) and how `run.ts` dispatches
  tasks.
- Fixture file names and ids (for example `aieng-daily-1/outline-month1.json`).
- The exact wording of each judge criterion, starting from the descriptions above and `evals/rubric.md`; the owner
  reviews the list before the first scored run.
- How each code criterion turns a level's breaches into met / not met (any breach of the listed kinds fails it), and
  the order check's details.
- The judge prompt, within the "what the judge sees" list above.
- Tests: fixture capture from a saved run (tree pruning, spans, block headings rebuilt, the prompt check), the gate, each code criterion on a hand-made level,
  group assignment, and a re-score of a saved sample.
