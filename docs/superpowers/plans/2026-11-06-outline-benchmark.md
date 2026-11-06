# Outline Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `outline` task to the model benchmark that scores gateway models on single outline calls, with a verdict
per call group (top, inner headings, leaves).

**Architecture:** `--capture` rebuilds each outline call of a draft-eval run as a frozen fixture by replaying the recorded
response through the app's own `draftLevel` with a mock model, and checks that the rebuilt prompt equals the recorded
one. A sample runs `draftLevel` on the fixture with the contestant's model and effort. Code criteria read typed
breaches and the model's raw units; one judge call per sample grades the rest. `run.ts` becomes task-driven, and the
report gets one section per group plus a routing section.

**Tech Stack:** TypeScript, tsx, vitest, AI SDK 7 (`streamObject`; `MockLanguageModelV4` from `ai/test`), zod.

**Spec:** `docs/superpowers/specs/2026-11-05-outline-benchmark-design.md`. The parent design
`docs/superpowers/specs/2026-10-29-model-benchmark-design.md` governs everything the spec does not change.

## Global Constraints

- The `allocate` task's behaviour, files on disk, CLI and tests stay as they are; every existing test in `benchmarks/` passes unchanged except where a task below says otherwise.
- The app's behaviour does not change: `OUTLINE_EFFORT` ("high") stays the default, and nothing in the app reads the new fields on `draftLevel`'s `done` event.
- Samples call the app's `draftLevel` with the options the draft passes, changing only the model and its effort.
- The judge never sees a contestant's name or raw JSON.
- Samples run on the app's gateway key (`appModel`); the benchmark never reads or writes the database.
- Every file written goes through `scrubSecrets`. Fixtures are committed (`benchmarks/fixtures/`); results and cache stay gitignored.
- Rounds spend money only when the owner says go. No task in this plan runs a paid round.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run tests with `VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vitest run <path>`; type-check with `npx tsc --noEmit` (run `npx next typegen` first if it reports `LayoutProps`).

## Rulings (the plan's own calls, beyond the spec)

- **A second additive app change:** `draftLevel`'s `done` event also carries `units` (the validated model output, before any code touches it) and `breaches` (the typed `levelChecks` breaches). Without them a sample could only read the learner's problem strings, and the spec's "the model's own minutes before sizing" and "ids before the app puts them in words" could not be read.
- **Criteria graded "code, judge otherwise" become two criteria**, `<id>-code` and `<id>-judge`, each with half the weight. Each applies only where its part has something to grade; a part that does not apply has no result and drops out of the sample's score.
- **The order check:** across the level's units in order, each listed material's chapters (non-review rows or covers) never go back, and each practice list's `itemFrom` never goes back.
- **Size tolerance:** a known size is "realistic" when the model's minutes are within 0.5–1.5× of it (`SIZE_TOLERANCE = [0.5, 1.5]`).
- **Judge dimensions:** one per kind of call, `leaf` and `heading`, so each sample is one judge call (as the spec asks).
- **Fixture ids:** `<run fixture id>/<slug>`, stored as `benchmarks/fixtures/<run fixture id>/outline-<slug>.json`. The slug is the label before ` · `, lower-cased, with runs of non-alphanumerics turned into `-`; `top-level` becomes `top`. Examples: `csapp-1/top`, `csapp-1/week-1`, `c25k-1/weeks-3-5`.

## Review Focus

1. A run where a level's call has no recorded response (aborted mid-stream, not in `calls.json`): capture skips it and says so, and the other calls still become fixtures.
2. A pruned tree that differs from what the baseline saw (a parent's `problems` left on, a later sibling's children kept): the prompt check fails the capture and names the call. Never write a fixture that silently differs.
3. A contestant that times out or is aborted: the gate is `failed` with "timed out after N s", never `void`; a 5xx, 429 or 401–403 is `void` (403/402/401 with `halt`).
4. A level with no materials (`aliases` undefined in `draftLevel`): `breaches` is `[]`, the code criteria that need materials do not apply, and nothing throws.
5. An old allocate `run.json` given to `--rescore` (no `groups`): it rescores exactly as today.

Each line has its test in the owning task (Tasks 2, 2, 4, 1, 5).

---

### Task 1: Outline effort and the level's units and breaches in the app

**Files:**
- Modify: `lib/ai/planDraft.ts` (`DraftLevelInput`, `streamUnits`, `draftLevel`)
- Test: `lib/ai/planDraft.test.ts`

**Interfaces:**
- Produces: `DraftLevelInput["ctx"].effort?: ReasoningEffort`, used by the outline call in place of `OUTLINE_EFFORT` (default `OUTLINE_EFFORT`), in both `effortSettings` and the logged row's `effort`.
- Produces: `draftLevel`'s done event `{ type: "done"; nodes: PlanNode[]; problems: string[]; costUsd: number; units: UnitDraft[]; breaches: Breach[] }`. `units` is `object.units` from the stream exactly as validated. `breaches` is `checks.breaches`, unfiltered (kept units' too); `[]` when `check` returns early because there are no aliases.

- [ ] **Step 1: Write the failing tests** in `planDraft.test.ts`, using the file's `mockedStreamObject` and `fakeStream`:
  - `"runs the outline call at the effort the draft is given"`: `draftLevel` with `ctx.effort: "low"` logs a call whose `effort` is `"low"`; without `effort` it is `"high"`.
  - `"returns the model's own units and the typed breaches with the level"`: a one-day level whose single unit reads a listed chapter at 999 minutes over a 60-minute day. Expect the done event's `units[0].materials[0].minutes` to be `999` (before `sizeChapterRows`), and `breaches.map((b) => b.kind)` to contain `"over-budget"`.
  - `"returns no breaches for a level without materials"`: no materials and no split formats, so `breaches` equals `[]`.
- [ ] **Step 2: Run them and see them fail.** Run `VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vitest run lib/ai/planDraft.test.ts`. Expected: the 3 new tests FAIL.
- [ ] **Step 3: Implement.** Add `effort` to `StreamUnitsInput` and pass `ctx.effort ?? OUTLINE_EFFORT` from `draftLevel`. In `check`, keep `checks.breaches` in a variable beside `problems`. Return `object.units` from `streamUnits`'s done event as it already does, and add both fields to `draftLevel`'s done.
- [ ] **Step 4: Run the file and `npx tsc --noEmit`.** Expected: all tests PASS and tsc exits 0. Callers that destructure the done event still compile.
- [ ] **Step 5: Commit** `feat(draft): let the outline call take an effort, and return the level's units and breaches`.

### Task 2: Outline fixtures captured by replaying the run

**Files:**
- Create: `benchmarks/tasks/outlineFixtures.ts`
- Modify: `benchmarks/fixtures.ts` (`captureFixture` becomes async and also writes outline fixtures), `benchmarks/run.ts` (`captureFixtures` awaits)
- Test: `benchmarks/tasks/outlineFixtures.test.ts`; update `benchmarks/fixtures.test.ts` and `benchmarks/run.test.ts` for the async capture

**Interfaces:**
- Consumes: Task 1's `done.nodes`; `readRun` from `evals/draft/record`.
- Produces:
  ```ts
  export type CallGroup = "top" | "inner" | "leaves";
  export interface OutlineFixture {
    id: string;            // "csapp-1/week-1"
    topic: string; sourceRun: string; commit: string;
    label: string;         // the recorded call label, "Week 1 · 5 days"
    group: CallGroup; leaf: boolean;
    request: { topic: string; instructions?: string; granularity: Granularity; weeks: number; daysPerWeek: number; hoursPerWeek: number };
    materials: Material[]; split: PlanSplit | null;
    level: PlanLevel; spans: number[]; tree?: PlanNode; parentId?: string;
    timeLimitMs: number;
    baseline: { inputTokens: number; outputTokens: number; ms: number };
  }
  export function callGroup(f: { parentId?: string; leaf: boolean }): CallGroup;          // no parent → top; leaf → leaves; else inner
  export function timeLimitMs(call: { endedAt: number; latencyMs: number }, startedAt: string): number; // max(STEP_MIN_MS, Date.parse(startedAt) + DRAFT_BUDGET_MS − (endedAt − latencyMs))
  export function fixtureSlug(label: string): string;
  export function levelInput(f: OutlineFixture, outlineModel: ResolvedModel, effort?: ReasoningEffort): DraftLevelInput;
  export async function captureOutline(runDir: string, runFixtureId: string): Promise<OutlineFixture[]>;
  export function loadOutlineFixture(id: string, root?: string): OutlineFixture; // parses with a zod schema of OutlineFixture; a missing file or a failed parse throws an Error naming the id
  ```

How `captureOutline` rebuilds each recorded outline call (every `calls.json` entry with `caller: "outline"` and a label other than `Allocate`, in recorded order):
- **Materials and split:** `materials.json`'s `allocated` and the `split` event.
- **Top level:** no tree. Spans come from `topSpans(weeks, daysPerWeek)` and the level from `topLevelFor(weeks)`.
- **#48 block headings** (label ends `in N blocks`): level `month`, with spans `weekLeafBlocks(weeks).map((w) => w * daysPerWeek)`.
- **#48 block call:** the tree is `layout(makeRoot(heads))`, where `heads` is the block-heading call's replayed `done.nodes`. The parent is the head at the block's position, and spans come from `childSpans(head, daysPerWeek)`.
- **Any other call:** the tree is `plan.json`'s tree with the parent's `children` set to `null` and its `problems` deleted. The parent is the node where `` `${fullLabelOf(tree, node)} · ${n} ${level}s` `` equals the label, and spans come from `childSpans(parent, daysPerWeek)`.
- **Replay:** run `draftLevel(levelInput(f, mock))`, where `mock` is a `MockLanguageModelV4` that streams the recorded `response` text and keeps the prompt it was sent. If the prompt text differs from the recorded `prompt`, throw ``Error(`${label}: the rebuilt prompt differs from the recorded one`)``. Write nothing in that case.

- [ ] **Step 1: Write the failing tests** in `outlineFixtures.test.ts`:
  - `timeLimitMs({ endedAt: 1793911743324, latencyMs: 17466 }, "2026-11-05T20:47:35.627Z")` equals `214769`, and `{ endedAt: 1793911765496, latencyMs: 22164 }` gives `197295`. A start past the deadline gives `60000` (`STEP_MIN_MS`).
  - `fixtureSlug`: `"Top level · 4 weeks"` → `"top"`, `"Top level · 8 weeks in 3 blocks"` → `"top"`, `"Week 1 · 5 days"` → `"week-1"`, `"Weeks 3–5 · 3 weeks"` → `"weeks-3-5"`.
  - `callGroup`: `{ leaf: true }` → `"top"`, `{ parentId: "x", leaf: true }` → `"leaves"`, `{ parentId: "x", leaf: false }` → `"inner"`.
  - `"captures every outline call of a saved run and checks each prompt"`: on a hand-made run folder in a temp dir (a 2-week day plan with a top-level call and a `Week 1 · 5 days` call, whose recorded prompts are `buildUnitsPrompt` of the expected inputs), expect 2 fixtures with ids `t-1/top` and `t-1/week-1`. The Week 1 fixture's tree has Week 1 with `children === null` and no `problems`, while Week 2 is kept.
  - `"refuses a run whose recorded prompt differs, naming the call"`: change one character of the recorded Week 1 prompt; expect a rejection whose message contains `"Week 1 · 5 days"`.
  - `"rebuilds #48's block headings from the recorded response"`: an 8-week week-leaf run with the block-heading call plus 3 block calls. The block fixtures' trees hold exactly the 3 headings, and their `spans` lengths are `[2, 3, 3]`.
  - `"skips a level the run did not record and captures the rest"`: `plan.json` has Week 1 days, but `calls.json` has no Week 1 call. Expect only the top fixture.
  - `"fails loudly on a fixture an older schema wrote"`: delete `timeLimitMs` from a saved fixture file; `loadOutlineFixture("t-1/top", root)` throws an error whose message contains `"t-1/top"`.
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `outlineFixtures.ts`. Then make `captureFixture` async: it builds the outline fixtures before writing anything, writes `allocate.json` and each `outline-<slug>.json` under the new run fixture folder, and returns `{ ...allocateFixture, outline: OutlineFixture[] }`. `captureFixtures` in `run.ts` awaits each and prints `` `${id} captured from ${runDir} (+${n} outline)` ``.
- [ ] **Step 4: Run** `benchmarks/tasks/outlineFixtures.test.ts`, `benchmarks/fixtures.test.ts` and `benchmarks/run.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(benchmarks): capture each outline call of a draft run as a fixture`.

### Task 3: The outline code checks

**Files:**
- Create: `benchmarks/tasks/outlineChecks.ts`
- Test: `benchmarks/tasks/outlineChecks.test.ts`

**Interfaces** (all pure; `nodes` is a level's units in order):
```ts
export const SIZE_TOLERANCE: [number, number] = [0.5, 1.5];
export function breachesOf(breaches: Breach[], kinds: BreachKind[]): Breach[];
export function orderBreaks(nodes: PlanNode[], leaf: boolean): string[];              // "M1 chapter 3 in Day 2 after chapter 4 in Day 1"
export function unreserved(nodes: PlanNode[], materials: Material[], leaf: boolean): Material[]; // allocated materials no unit reserves (headings: covers/practiceCovers ids; leaves: materials/practice ids)
export function idsInText(units: UnitDraft[]): string[];                               // /\bM\d+(?:\.i?\d+)?\b/ in title, summary, notes, task, done
export function minutesOffSize(units: UnitDraft[], materials: Material[]): { sized: number; unsized: number; off: string[] };
export function setAsideOffSize(nodes: PlanNode[], materials: Material[]): { sized: number; unsized: number; off: string[] };
```
- **`minutesOffSize`** resolves each row's id with `aliasMaterials(materials).resolve`.
  - Chapter rows are grouped per chapter, and their summed minutes are compared with `chapterAt(toc, chapter).minutes`.
  - A practice row naming one item is compared with `itemMinutes(format, item)`.
  - A row is sized when its material gives a size, and unsized otherwise.
- **`setAsideOffSize`** compares, for each heading whose chapter covers all have sizes, the summed chapter minutes with `time.reading`. A heading with any unsized cover counts as unsized.

- [ ] **Step 1: Write the failing tests**, one `describe` per function, on hand-made nodes and materials. Each has one met and one broken case:
  - `orderBreaks` finds chapter 3 after chapter 4, and item 7 after item 9.
  - `unreserved` names `M2` when only `M1` is covered.
  - `idsInText` finds `"M1.3"` in a note and ignores `"Module 1"`.
  - `minutesOffSize`: a 40-minute chapter read as 30 + 25 is fine (55 ≤ 60); read as 70 + 0 it is off, since 70 > 60. An unlisted book row counts as `unsized: 1`.
  - `setAsideOffSize`: 3 chapters of 60 minutes against `time.reading` 200 is fine; against 90 it is off.
  - `breachesOf` keeps only the asked kinds.
- [ ] **Step 2: Run and see them fail.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `outlineChecks.ts`.
- [ ] **Step 4: Run** `benchmarks/tasks/outlineChecks.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(benchmarks): add the outline task's code checks`.

### Task 4: The outline task: criteria, judge view and sample

**Files:**
- Create: `benchmarks/tasks/outline.ts`
- Test: `benchmarks/tasks/outline.test.ts`

**Interfaces:**
- Consumes: `OutlineFixture`, `levelInput` and `callGroup` (Task 2), the checks (Task 3), and `voidReason` from `tasks/allocate.ts`.
- Produces:
  ```ts
  export type OutlineOutput = { nodes: PlanNode[]; units: UnitDraft[]; breaches: Breach[]; problems: string[] };
  export interface OutlineCtx { fixture: OutlineFixture }
  export const OUTLINE_CRITERIA: Criterion<OutlineOutput, OutlineCtx>[];       // leaf and heading lists together
  export function codeResults(output: OutlineOutput, ctx: OutlineCtx): CriterionResult[];
  export function judgeCriteriaFor(output: OutlineOutput, ctx: OutlineCtx): JudgeCriterion[]; // the applicable ones of the fixture's kind
  export function renderOutline(output: OutlineOutput, fixture: OutlineFixture): string;
  export async function runOutlineSample(fixture: OutlineFixture, contestant: Contestant, deps?: { draft?: typeof draftLevel; now?: () => number }): Promise<Pick<Sample<OutlineOutput>, "gate" | "output" | "calls" | "costUsd" | "ms">>;
  ```

**Criteria.** Ids are prefixed `leaf-` or `head-`. Each criterion applies only to its kind (`ctx.fixture.leaf`). The score group is in brackets. The judge criteria's `dimension` is `leaf` or `head`.

| id | weight | grader | applies / met when |
|---|---|---|---|
| leaf-time | 4 | code [structure] | no breach of `over-budget`, `over-capacity`, `parent-miss`; at the top level (`group === "top"`) also `budget-miss`, `format-total-miss` |
| leaf-minutes-code | 1.5 | code [structure] | applies when `minutesOffSize(...).sized > 0`; met when `off` is empty |
| leaf-minutes-judge | 1.5 | judge | applies when `unsized > 0`: "Rows whose material gives no size have minutes that fit what they read or do." |
| leaf-note | 3 | judge | "Each Read row's note lets the learner open the material and find where to start and stop; a book without a chapter list is named by topic only." |
| leaf-order-code | 1 | code [materials] | no breach of `outside`, `overlap`, `whole-book`, `review-before-read`, `practice-outside`, `practice-overlap`, plus `unread-reservation` (not top), `orderBreaks` empty, and at the top level `unreserved` empty |
| leaf-order-judge | 1 | judge | applies when a level material has no `toc`: "Units reading a book without a chapter list each continue where the one before stopped." |
| leaf-title | 2 | judge | "Each unit's title and summary match its rows." |
| leaf-practice-read | 1 | judge | "Practice uses only what has been read by then." |
| leaf-done | 1 | judge | "Each practice task says what done looks like." |
| leaf-focus | 1 | judge | "Each unit has one focus." |
| leaf-words-judge | 0.5 | judge | "Written for the learner: no ids, no chapter or section names it was not given, no filler." |
| leaf-words-code | 0.5 | code [quality] | `idsInText(output.units)` empty |
| head-time | 4 | code [structure] | no breach of `over-capacity`, `no-time`, `budget-miss`, `format-total-miss`, `parent-miss` |
| head-title | 3 | judge | "Each unit's title and summary match what it has: its minutes per activity and its set-aside items." |
| head-set-aside-code | 1.5 | code [materials] | no `reading-over-stated` breach and `setAsideOffSize(...).off` empty |
| head-set-aside-judge | 1.5 | judge | applies when `unsized > 0`: "What each unit sets aside fits its reading time." |
| head-order | 2 | code [materials] | no breach of `outside`, `overlap`, `whole-book`; `orderBreaks` empty; at the top level `unreserved` empty |
| head-builds | 2 | judge | "Each unit builds on the ones before it." |
| head-words-judge | 0.5 | judge | "Written for the learner: no ids; a book without a chapter list named by topic, never by chapter or section." |
| head-words-code | 0.5 | code [quality] | `idsInText(output.units)` empty |

**The judge view (`renderOutline`)** has these sections, in order:
- The request.
- `renderMaterials(fixture.materials)`.
- `renderTree` of the fixture's tree with the level's nodes placed under the parent, with `markId` set to the parent.
- What the parent set aside: its covers, practice covers and time.
- The level's budgets: daily or weekly minutes, and the split.
- The level as written: each unit's title, summary, rows with minutes and notes, practice with task and done, and time.

It names no model.

**The sample (`runOutlineSample`).**
- **The call:** `draftLevel(levelInput(fixture, appModel(role.model), role.effort))`, where `role` is the contestant's outline role or the baseline's. It runs with `deadline = Date.now() + fixture.timeLimitMs` and `log.onCall` collecting calls.
- **Gate on a thrown error:**
  - Our deadline or an abort gives `failed` with ``timed out after ${timeLimitMs / 1000} s``.
  - An `APICallError` with status 5xx or 429 gives `void`.
  - Status 401, 402 or 403 gives `void` with `halt: true`.
  - Any other error gives `failed` with its message.
- **Time-fit gate:** a completed level with an `over-capacity` or `over-budget` breach is `failed` with ``over the time ceiling: ${breach.text}``. Its output is kept so the report can show it.
- **Cost:** the calls' `costUsd`, or the list price where a call has none.

- [ ] **Step 1: Write the failing tests** in `outline.test.ts`, on a hand-made leaf fixture and a hand-made heading fixture:
  - `codeResults` for a leaf output with an `over-budget` breach marks `leaf-time` unmet. With none, it is met, and `head-*` criteria have no result.
  - `judgeCriteriaFor` leaves out `leaf-order-judge` when every material has a toc, and includes it otherwise.
  - `renderOutline` contains the parent's `>>` mark and each unit's title, and does not contain the contestant name `"gpt-test"` or a `{"` JSON brace.
  - `runOutlineSample` with a fake `draft` that throws an abort error gives `{ status: "failed", reason: "timed out after 197.295 s" }` (with `timeLimitMs: 197295`).
  - A fake throwing `APICallError` status 503 gives `void`; status 402 gives `void` with `halt: true`.
  - A fake whose done has an `over-budget` breach gives `failed` with a reason starting `"over the time ceiling"`, and `output` is not null.
  - A fake passes `role.effort` through: the contestant `{ outline: { model: "google/gemini-3-flash", effort: "low" } }` reaches `levelInput` as `effort: "low"`.
- [ ] **Step 2: Run and see them fail.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `outline.ts`.
- [ ] **Step 4: Run** `benchmarks/tasks/outline.test.ts` and `npx tsc --noEmit`. Expected: PASS, and tsc exits 0.
- [ ] **Step 5: Commit** `feat(benchmarks): add the outline task's criteria, judge view and sample`.

### Task 5: A task-driven runner with per-group reports and routing

**Files:**
- Create: `benchmarks/task.ts`
- Modify: `benchmarks/run.ts`, `benchmarks/budget.ts`, `benchmarks/report.ts`
- Test: `benchmarks/run.test.ts`, `benchmarks/budget.test.ts`, `benchmarks/report.test.ts`

**Interfaces:**
```ts
// benchmarks/task.ts
export interface BenchTask<F extends { id: string }, O, C> {
  name: "allocate" | "outline";
  role: Role;                                   // whose model the contestant changes
  criteria: Criterion<O, C>[];
  loadFixture(id: string, root: string): F;
  ctxFor(fixture: F): C;
  runSample(fixture: F, contestant: Contestant): Promise<Pick<Sample<O>, "gate" | "output" | "calls" | "costUsd" | "estimatedCostUsd" | "ms">>;
  codeResults(output: O, ctx: C): CriterionResult[];
  judgeCriteria(output: O, ctx: C): JudgeCriterion[];  // allocate: all of its judge criteria
  render(output: O, fixture: F): string;
  baseline(fixture: F): { inputTokens: number; outputTokens: number } | null;
  groupOf?(fixture: F): string;                 // outline: the call group; allocate: none
}
export const TASKS: { allocate: BenchTask<AllocateFixture, AllocateOutput, AllocateCtx>; outline: BenchTask<OutlineFixture, OutlineOutput, OutlineCtx> };
// benchmarks/budget.ts
export function estimateRun(args: { baselines: ({ inputTokens: number; outputTokens: number } | null)[]; role: Role; contestants: Contestant[]; epochs: number; judgeDimensions: number; renderedChars: number }): Estimate;
// estimateAllocateRun stays, now a wrapper over estimateRun with role "allocate".
// benchmarks/report.ts
export function renderRouting(groups: Record<string, ContestantSummary[]>): string;  // "## Routing", one line per group: the cheapest qualifying contestant, or "none yet"
```
Changes in `run.ts`:
- `TASK` and every `ALLOCATE_*` reference become `task.*`.
- `RunOptions.task` widens to `"allocate" | "outline"`, and gains `groups?: CallGroup[]`, which filters the outline fixtures.
- `judgeSample` judges `task.judgeCriteria(...)`, grouped by dimension. `judged` is true when every applicable judge criterion has a result.
- With `groupOf`:
  - `scores.json` becomes `{ task, margin, groups: { [group]: ContestantSummary[] } }`.
  - `report.md` holds one `renderReport` section per group, under `## Group: <group>`, then `renderRouting`.
  - A chart is written per group as `chart-<group>.svg`.
- Without `groupOf`, the outputs are exactly today's.
- `run.json` records `task`, and `--rescore` and `--calibrate` pick the task from it. A `run.json` without `task` means `allocate`.
- The CLI gets `--task outline` and `--groups top,inner,leaves`. The outline fixture ids look like `csapp-1/top`.

- [ ] **Step 1: Write the failing tests:**
  - In `run.test.ts`: `"runs the outline task with a fake sample and writes one report section per group plus routing"`. Use two fake outline fixtures, one `top` and one `leaves`, and a fake judge. Expect `report.md` to contain `## Group: top`, `## Group: leaves` and `## Routing`, and `scores.json` to have `groups.top` and `groups.leaves`.
  - In `run.test.ts`: `"rescores a saved allocate run that has no task in run.json"` produces the same `scores.json` as today's rescore test.
  - In `run.test.ts`: `"filters outline fixtures by --groups"`: with `groups: ["leaves"]`, only the leaves fixture's samples are run.
  - In `budget.test.ts`: `estimateRun` with role `outline` prices the contestant's outline model, and `estimateAllocateRun`'s existing expectations still hold.
  - In `report.test.ts`: `renderRouting({ top: [], leaves: [<a qualifying cheap summary>, <a qualifying dearer one>] })` names the cheap one for `leaves` and `none yet` for `top`.
- [ ] **Step 2: Run them and see them fail.** Run `VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vitest run benchmarks`. Expected: the new tests FAIL and the old ones PASS.
- [ ] **Step 3: Implement** `task.ts`, then refactor `run.ts` onto it, then add `estimateRun` and `renderRouting`.
- [ ] **Step 4: Run** `VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vitest run benchmarks` and `npx tsc --noEmit`. Expected: every test PASSES, and tsc exits 0.
- [ ] **Step 5: Commit** `feat(benchmarks): run any task, with per-group reports and routing for outline`.

### Task 6: Capture the real fixtures and document the task

**Files:**
- Create: `benchmarks/fixtures/<topic>-<n>/allocate.json` and `outline-*.json` for the 11 source runs
- Modify: `benchmarks/README.md`

- [ ] **Step 1: Capture** the 11 source runs named in the spec, from `evals/results/`:
  - The Nov 5 `-1` folders of `csapp`, `finance`, `sqlwin`, `aieng`, `deeplearning`, `aieng-daily`, `ml-daily` and `frenchrev`.
  - `draft-2026-11-06T00-35-48-135Z-{sde,c25k,mle}-1`.

  Run `npx tsx benchmarks/run.ts --capture <the 11 folders>`. Expected: 11 lines `<id> captured from … (+N outline)` and no `refused`. If one is refused for a prompt mismatch, stop and report it; don't edit the fixture.
- [ ] **Step 2: Check the call kinds.** List the fixtures by group and compare them with the spec's table:
  - `top` should come from all 11 runs.
  - `inner` should come from `aieng-daily`, `ml-daily` and `frenchrev`.
  - `leaves` should be the days of `sde`, `csapp`, `finance`, `aieng-daily`, `ml-daily` and `frenchrev`, the week leaves of `aieng` and `deeplearning`, and the 3 blocks each of `c25k` and `mle`.
- [ ] **Step 3: Update the README** (`benchmarks/README.md`). Add an "Outline task" section covering:
  - what one sample is;
  - the three groups;
  - capture, including the prompt check;
  - `--task outline --groups`;
  - the per-group report and routing.

  Also change the Round 1 example's `--fixtures sde-1` to `sde-2`.
- [ ] **Step 4: Run** `VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vitest run benchmarks lib/ai/planDraft.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(benchmarks): capture outline fixtures from eleven draft runs` (the fixtures and the README).
