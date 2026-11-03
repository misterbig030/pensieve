# Outline Decides Unit Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The top-level outline call decides each unit's minutes per activity; the even weekly split, the rules that
enforce it, and the outline retry go; every check failure is reported to the learner (conversation panel, track page)
instead of fixed; the chat can edit unit time and re-draft.

**Architecture:** A unit's time (`UnitTime`) is drafted by the model on headings, stored on `plan_nodes`, and read
through one helper (`unitBudgets`) everywhere the even split (`practiceBudgets`/`weekBudgets` over a week) is read
today, with the even split as the fallback for units without time. `levelChecks` keeps its shape but every breach is a
report, rendered as learner lines (`learnerProblems`) and saved with the node whose level it belongs to. A new
`redraftPlan` re-runs `draftLevel` for the open part of a plan; the chat and the hours/split pickers call it.

**Tech Stack:** Next.js (App Router — read `node_modules/next/dist/docs/` before touching routes), AI SDK
(`streamObject`, `streamText`, `tool`), zod, drizzle (Postgres/Neon), vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-outline-decides-unit-time-design.md`

## Global Constraints

- Code never changes the plan to make a check pass: no retry, no row dropped, trimmed or rescaled for a breach.
  (`sizeChapterRows` and `sizeItemRuns` stay: they build the plan.)
- No per-unit split is reintroduced by another name. The even split survives only as the fallback for units with no
  `time` (plans saved before this change).
- A unit's reading minutes are must-reading only; should-tier reading counts in no unit's stated reading.
- Learner-facing problem lines use material titles and chapter names, never aliases (`M1`, `M1.5`), rule names, or
  "breach". Admin `facts` keep today's wording plus `breach:` lines.
- Migrations are additive only (new nullable columns). `.env.local`'s `DATABASE_URL` is the production database: do
  not run `drizzle-kit migrate` without the user's explicit go-ahead in chat. `drizzle-kit generate` needs a TTY for
  rename prompts; an additions-only diff does not prompt.
- Tests: `npx vitest run <file>`; whole suite `npm test`; types `npx tsc --noEmit`; lint `npm run lint`.

## Review Focus

1. A track saved before this change (no `time` on any node) plans its next week exactly as today — even split budgets,
   same item runs. Test owned by Task 2 and Task 4.
2. The model leaves `time` off a heading, gives a format the split never picked, or states minutes over the unit's
   hours: the plan is kept as written and each is reported once, not thrown away. Tests owned by Task 3 and Task 5.
3. A week-granularity plan (top-level units are leaves, no heading `time`): capacity and plan format totals are judged
   from its rows, and no "no time" report fires. Test owned by Task 5.
4. Re-drafting never changes a completed unit or one ending on or before `lockBefore`, its reservations, or the items
   it holds. Test owned by Task 10.
5. Clicking through the hours picker (6 → 7 → 8) starts one re-draft, for the settled value, not three. Test owned by
   Task 12.

---

### Task 1: `UnitTime` and problems on nodes, stored and loaded

**Files:**
- Modify: `lib/schemas/plan.ts`, `lib/planTree.ts` (`PlanNode`, `makeNode`), `lib/planInput.ts`, `lib/db/schema.ts`,
  `lib/db/planQueries.ts` (`insertPlanTree`, `replacePlanTree`, `getPlanTree`, `insertChildren`), `lib/db/queries.ts`
  (`getTrackDetail`), `app/tracks/new/actions.ts` (`confirmTrackAction`), `app/tracks/[id]/actions.ts`
  (`confirmRevisionAction`)
- Create: `drizzle/0020_unit_time.sql` (+ generated meta)
- Test: `lib/planInput.test.ts`, `lib/db/planQueries.test.ts` (whichever exists; follow its fake-db pattern)

**Interfaces:**
- Produces, in `lib/schemas/plan.ts`:
  - `unitTimeSchema = z.object({ reading: z.number().int().min(0).max(30000), practice: z.record(z.enum(PRACTICE_FORMATS), z.number().int().min(0).max(30000)) })`
  - `type UnitTime = { reading: number; practice: Partial<Record<PracticeFormat, number>> }`
  - `unitTimeDraftSchema = z.object({ reading: z.number().int().min(0), practice: z.array(z.object({ format: z.enum(PRACTICE_FORMATS), minutes: z.number().int().min(0) })) })` (array: plainer JSON schema for the model)
  - `problemsSchema = z.array(z.string().min(1).max(500)).max(40)`
  - `nodeInputBase` gains `time: unitTimeSchema.optional()`, `problems: problemsSchema.optional()`
- Produces, in `lib/planTree.ts`: `PlanNode.time?: UnitTime` ("Headings: minutes per activity the outline gave this
  unit; must-reading only"); `PlanNode.problems?: string[]` ("Learner lines for the level planned inside this node; on
  the root, the top level's"). `makeNode` accepts both.
- Produces, DB: `plan_nodes.time jsonb` and `plan_nodes.problems jsonb`, `tracks.problems jsonb`, all nullable.
  `getTrackDetail(...).root.problems` comes from `tracks.problems`.
- Produces: `confirmTrackAction` / `confirmRevisionAction` input gains `problems?: string[]` (the root's), written to
  `tracks.problems`. `insertChildren(trackId, userId, parentId, children, manualSplit = false, problems: string[] = [])`
  writes `problems` onto the parent row (empty → null).

- [ ] **Step 1: Write failing round-trip tests**: `fromTreeInput(toTreeInput(root))` keeps `time` and `problems` on a
  heading; a node input without them yields `time === undefined` and `problems === undefined`; `insertChildren` with
  `["Week 3 …"]` sets the parent's `problems`; `getPlanTree` returns them.
- [ ] **Step 2: Run** `npx vitest run lib/planInput.test.ts` — Expected: FAIL (unknown keys / undefined).
- [ ] **Step 3: Implement** the schema, type, columns and mappings above. Generate the migration with
  `npx drizzle-kit generate --name unit_time` (additions only, no prompt).
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(plan): unit time and problems on plan nodes and tracks`

### Task 2: One reader for a unit's budgets, and the plan's totals

**Files:**
- Modify: `lib/materials.ts`
- Test: `lib/materials.test.ts`

**Interfaces:**
- Consumes: `PlanNode.time` (Task 1); existing `practiceBudgets`, `budgetFor`, `weeksOf`.
- Produces:
  - `interface BudgetContext { split?: PlanSplit | null; hoursPerWeek?: number; daysPerWeek: number; materials: Pick<Material, "id" | "practice" | "minutes">[] }`
  - `interface UnitBudgets { reading: number; practice: Partial<Record<PracticeFormat, number>>; stated: boolean }`
  - `unitBudgets(root: PlanNode, node: PlanNode, ctx: BudgetContext): UnitBudgets` — `node.time` when set
    (`stated: true`); else `practiceBudgets(ctx.split, budgetFor(weeksOf(root, node, ctx.daysPerWeek), ctx.hoursPerWeek) * 60, ctx.materials)` (`stated: false`, the legacy fallback).
  - `planTotals(ctx: BudgetContext & { weeks: number }): { reading: { id: string; minutes: number }[]; practice: Partial<Record<PracticeFormat, number>> }` —
    reading: each material with `minutes` set and kept for reading, in list order; practice: `practiceBudgets(ctx.split, budgetFor(ctx.weeks, ctx.hoursPerWeek) * 60, ctx.materials).practice`.

- [ ] **Step 1: Write failing tests** `unitBudgets` returns `{ reading: 150, practice: { "problem-set": 180, "design-exercise": 30 }, stated: true }` for a week with that `time`; for the 2026-11-02 split (`readingShare: 20`, problem-set 54 / design 25 / mock 13 / recall 8 after `draftedSplit`) at 6 h/week and no `time`, it equals today's `practiceBudgets(split, 360, materials)` with `stated: false`; `planTotals` for 8 weeks × 6 h gives reading `[{ id: ddia, minutes: 210 }, { id: sdi, minutes: 360 }, { id: essay, minutes: 6 }]`.
- [ ] **Step 2: Run** `npx vitest run lib/materials.test.ts -t "unitBudgets|planTotals"` — Expected: FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(materials): unitBudgets and planTotals`

### Task 3: The outline drafts each heading's time

**Files:**
- Modify: `lib/schemas/plan.ts` (`unitDraftSchema`), `lib/ai/planDraft.ts` (`nodeFor`, `applyUnitRefs`, `check` in
  `draftLevel`), `lib/ai/planPrompt.ts` (`buildUnitsPrompt`, `weekBudgetsOf`, `leafPracticeRules`, leaf material rules)
- Test: `lib/ai/planDraft.test.ts`, `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Consumes: `unitTimeDraftSchema`, `UnitTime` (Task 1); `unitBudgets`, `planTotals` (Task 2).
- Produces:
  - `unitDraftSchema.time: unitTimeDraftSchema.optional().describe("Headings only: this unit's minutes of must-reading and of each practice format")`.
  - `toUnitTime(draft: z.infer<typeof unitTimeDraftSchema>, picked: PracticeFormat[]): { time: UnitTime; unpicked: PracticeFormat[] }` in `lib/ai/planDraft.ts` — formats not in the split's picks are left out and returned.
  - `applyUnitRefs` sets `node.time` on headings when the unit has `time`; leaves never carry `time`.
  - `headingTimeRules(input: UnitsPromptInput, aliases: MaterialAliases | undefined): string | null` in `planPrompt.ts`.
    For headings only. At the top level it states `planTotals` (reading per material by alias and title, minutes per
    picked format, block formats as whole blocks); below, the parent's `unitBudgets`. Every unit line keeps its hours.
    It must say: units may weight activities differently; each unit's minutes fit its hours; across the units each
    activity adds up to its total; reading counts must-reading only.
  - Week leaves at the top level (week granularity): the unit lines state the week's hours only (no "so about N min of
    must-reading; practice: …"), and `headingTimeRules`' plan-total sentence is given for their rows instead.
  - `weekBudgetsOf(input)` is replaced by `parentBudgetsOf(input): UnitBudgets` = `unitBudgets(tree, parent, ctx)` for
    a level with a parent; the day-level rules and `leafPracticeRules` read it.

- [ ] **Step 1: Write failing tests**
  - planPrompt: a top-level 8-week heading prompt contains "3 h 30 min" for DDIA's total and the four practice formats'
    totals, and no "of must-reading" on unit lines; a day-level prompt under a week with
    `time { reading: 150, practice: { "problem-set": 180, "design-exercise": 30 } }` says the week has about 2 h 30 min
    of reading and 3 h of Problems.
  - planDraft: a fake model returning `time: { reading: 150, practice: [{ format: "problem-set", minutes: 180 }, { format: "lab", minutes: 30 }] }` on a split without `lab` yields `node.time = { reading: 150, practice: { "problem-set": 180 } }` and a fact naming `lab`.
- [ ] **Step 2: Run** `npx vitest run lib/ai/planPrompt.test.ts lib/ai/planDraft.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** — Expected: PASS (update older prompt snapshots that asserted the per-week split lines).
- [ ] **Step 5: Commit** `feat(outline): headings carry the time the outline gives them`

### Task 4: Item runs follow each unit's time

**Files:**
- Modify: `lib/materials.ts` (`sizeItemRuns`), `lib/ai/planPrompt.ts` (`leafPracticeRules`: `fitWeekToDays` input)
- Test: `lib/materials.test.ts`

**Interfaces:**
- Consumes: `unitBudgets` (Task 2).
- Produces: `sizeItemRuns` sizes each unit's run from `unitBudgets(root, unit, ctx).practice[format]` instead of
  `practiceBudgets` over its weeks; signature unchanged. `fitWeekToDays` is fed `parentBudgetsOf(input)` (via
  `weekPracticeTime` when runs are held).

- [ ] **Step 1: Write failing test**: NeetCode (52 items, ~10 min each) over weeks with Problems minutes 180, 180, 60, 0
  gets runs of sizes proportional to those minutes and none for the last week; a legacy tree without `time` gets the
  same runs as before this change (copy the current expectation).
- [ ] **Step 2: Run** `npx vitest run lib/materials.test.ts -t sizeItemRuns` — Expected: FAIL on the first case.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(materials): item runs sized by each unit's own Problems time`

### Task 5: The checks report, with the even-split rules gone and the new ones in

**Files:**
- Modify: `lib/materials.ts` (`BreachKind`, `DROPPABLE`, `dropBreaches`, `levelChecks`, `weekRule`, `LevelChecks`,
  `treeChecks`)
- Test: `lib/materials.test.ts`

**Interfaces:**
- Consumes: `unitBudgets`, `planTotals` (Task 2); `plainAliases` (existing).
- Produces:
  - `BreachKind` adds `"over-capacity" | "format-total-miss" | "parent-miss" | "reading-over-stated" | "no-time"`;
    keeps the rest. `DROPPABLE` and `dropBreaches` are deleted.
  - Removed: the heading reading check ("reserves about N min of reading against a budget…"), and `weekRule`'s
    must-reading, per-format practice, total practice breaches and its "practice short" / should-reading facts.
    `weekRule` itself goes.
  - Kept as is: the day rule (`over-budget`, day's reading+practice vs `budgetCeiling(day minutes)`), placement,
    `unread-reservation`, `budget-miss`.
  - New rules (all in `levelChecks`, slack and ceilings from the existing helpers):
    - `over-capacity`: a heading's `time` total, or a week leaf's must + practice rows, over
      `budgetCeiling(unit hours × 60)`.
    - `format-total-miss` (top level only): per picked format, the units' minutes (`time` on headings, rows on week
      leaves) vs `planTotals(...).practice[f]`, beyond `budgetMissSlack`.
    - `parent-miss`: when the parent has `time` (`stated`), the level's minutes per activity (children's `time`, or
      leaves' must-reading / practice rows) vs the parent's, beyond `budgetMissSlack`.
    - `reading-over-stated`: a heading's reserved chapter/whole minutes (`knownMinutes`) over
      `budgetCeiling(time.reading)`.
    - `no-time`: a heading with no `time` on a level drafted or revised after this change (`input.drafted === true`;
      legacy trees checked tree-wide pass `false`).
  - `LevelCheckInput.drafted?: boolean`, and `treeChecks`' options gain `drafted?: boolean` (passed to each
    `levelChecks`); `LevelChecks.problems: string[]` and `treeChecks(...).problems: string[]`.
  - `learnerProblems(breaches: Breach[], materials: NamedMaterial[], aliases: MaterialAliases): string[]` — one line per
    breach: `plainAliases` over its text, minutes ≥ 60 as "2 h 10 min", no rule names. Exact texts for the new kinds:
    - over-capacity: `${unit} plans ${t} in a week of ${h}.` (month: "in a month of")
    - format-total-miss: `${Label} adds up to ${t} across the plan; the time split gave it ${b}.`
    - parent-miss: `${unit}'s ${level}s plan ${t} of ${activity}; ${unit} gave itself ${b}.`
    - reading-over-stated: `${unit} plans ${t} of reading in a ${level} that gave itself ${b} for it.`
    - no-time: `${unit} has no time set for its activities.`

- [ ] **Step 1: Write failing tests** (on the AI-engineering fixture and a fixture built from the 2026-11-02 export's
  top level: Week 3 reserving DDIA ch. 5 + SDI ch. 6 with `time.reading 60`):
  - no breach mentions "against a budget of about 72 min"; `reading-over-stated` fires for Week 3 and its learner line
    is `Week 3 plans 2 h 34 min of reading in a week that gave itself 1 h for it.` and contains no `M1`;
  - a week with `time` totalling 420 min at 6 h/week → `over-capacity`;
  - Problems totalling 21 h vs a 26 h plan total → `format-total-miss` naming "Problems";
  - days whose must-reading sums to 300 under a week with `time.reading 150` → `parent-miss`; 160 → none;
  - a heading without `time` with `drafted: true` → `no-time`; with `drafted: false` → none;
  - a week-granularity top level (leaves with rows, no `time`) → no `no-time`, capacity from rows;
  - a 129-min chapter on one day of 72 min still breaches the day rule.
- [ ] **Step 2: Run** `npx vitest run lib/materials.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; delete tests that asserted the removed rules or `dropBreaches`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(checks): report-only checks held to each unit's own time`

### Task 6: Drafting runs once and carries its problems

**Files:**
- Modify: `lib/ai/planDraft.ts` (`draftLevel`, `streamUnits`, `streamPlanDraft`, `streamExpandNode`), `lib/planChat.ts`
  (`PlanDraftEvent`, `PlanExpandEvent`)
- Test: `lib/ai/planDraft.test.ts`

**Interfaces:**
- Consumes: `LevelChecks.problems`, `drafted` (Task 5).
- Produces:
  - `draftLevel` yields `{ type: "done"; nodes: PlanNode[]; problems: string[]; costUsd: number }`; it calls the model
    once. Deleted: the retry branch, `RETRY_HEADER`, `StreamUnitsInput.silent`, every `dropBreaches` call and the
    out-of-time drop path. `levelChecks` gets `drafted: true`.
  - `streamPlanDraft`: `root.problems` = top level's problems, each planned parent's `problems` = its level's; the
    `finish` event's `root` carries them.
  - `PlanExpandEvent` finish: `{ type: "finish"; children: PlanNode[]; problems: string[]; costUsd: number }`.

- [ ] **Step 1: Write failing tests**: a fake model whose first top-level answer breaches capacity is called **once**
  (the existing "retry" test, inverted: labels `["Top level · 8 weeks"]`), its units are kept unchanged, and
  `finish.root.problems` holds the learner line; `streamExpandNode`'s `finish` carries `problems`.
- [ ] **Step 2: Run** `npx vitest run lib/ai/planDraft.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(outline): one call per level, problems instead of retries`

### Task 7: Chat revisions see and edit unit time, and report

**Files:**
- Modify: `lib/ai/planPrompt.ts` (`renderTree`, `buildRevisionPrompt` rules), `lib/schemas/plan.ts`
  (`revisedLeafSchema`), `lib/ai/planRevision.ts` (`applyRevision`, `revisePlanTree`), `lib/ai/planChat.ts`,
  `lib/planChat.ts` (`PlanChatEvent`)
- Test: `lib/ai/planRevision.test.ts`, `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Consumes: `unitTimeDraftSchema`, `toUnitTime` (Tasks 1, 3); `treeChecks(...).problems` (Task 5).
- Produces:
  - `formatUnitTime(time: UnitTime): string` in `lib/studyTime.ts`, e.g. `"2 h 30 min reading · 3 h Problems · 30 min Design"`
    (registry labels, formats in `PRACTICE_FORMATS` order, zero entries left out). Shared with Tasks 8–9.
  - `renderTree` appends ` <time: ${formatUnitTime(node.time)}>` to a heading with `time`.
  - `revisedLeafSchema.time: unitTimeDraftSchema.optional()`; `applyRevision` sets `time` from the unit when given,
    else keeps the kept node's `time`; a new unit without `time` keeps none (reported as `no-time`).
  - `revisePlanTree` returns `{ tree, costUsd, problems }`; no `dropBreaches`; `treeChecks` runs with `drafted: true`
    for changed nodes only (`original` already tells it which rows are saved).
  - `PlanChatEvent` `revised` gains `problems: string[]`; `runPlanChat` passes them through.

- [ ] **Step 1: Write failing tests**: a revision that sets Week 3's `time.reading` to 180 changes only Week 3's
  `time`; a kept unit not mentioned keeps its `time`; a revision whose Week 2 now reads a chapter Week 1 reads keeps
  both rows and returns an overlap line in `problems`; `renderTree` shows `<time: 2 h 30 min reading · 3 h Problems>`.
- [ ] **Step 2: Run** `npx vitest run lib/ai/planRevision.test.ts lib/ai/planPrompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): revisions edit unit time and report problems`

### Task 8: The conversation panel and the plan tree show time and problems

**Files:**
- Modify: `lib/planChat.ts` (add `problemsText`), `components/pensieve/PlanWorkspace.tsx`,
  `components/pensieve/PlanTree.tsx`, `app/tracks/new/NewTrackForm.tsx` / `app/tracks/[id]/adjust/AdjustPlan.tsx`
  (pass `root.problems` to confirm)
- Test: `lib/planChat.test.ts`, `components/pensieve/PlanTree.test.ts`

**Interfaces:**
- Consumes: `formatUnitTime` (Task 7); `finish`/`revised` events with problems (Tasks 6–7).
- Produces:
  - `problemsText(problems: string[]): string` — `""` for none; otherwise
    `"A few things in this plan don't add up:\n- …\n- …\nAsk me to fix any of them, or to re-draft the plan."`
  - `PlanWorkspace`: on draft `finish`, appends `problemsText` of the root's and every node's `problems` to the
    `draftedText` message; on expand `finish`, to the "planned …" message; on chat `revised`, a `sys` message. The root's
    `problems` are sent with confirm (Task 1's input).
  - `PlanTree`: a heading with `time` shows `formatUnitTime(time)` under its title.

- [ ] **Step 1: Write failing tests**: `problemsText([])` is `""`; two lines render as above; `PlanTree` renders
  "2 h 30 min reading · 3 h Problems" for a week with that `time`.
- [ ] **Step 2: Run** `npx vitest run lib/planChat.test.ts components/pensieve/PlanTree.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workspace): show unit time and the plan's problems in the chat`

### Task 9: Weeks planned on the track page keep and show their problems

**Files:**
- Modify: `app/tracks/[id]/actions.ts` (`expandNodeAction`), `app/tracks/[id]/PlanOutline.tsx` / `OutlineRows.tsx`
- Test: `app/tracks/[id]/OutlineRows.test.ts`

**Interfaces:**
- Consumes: expand `finish.problems` (Task 6); `insertChildren(..., problems)` (Task 1); `formatUnitTime` (Task 7).
- Produces: `expandNodeAction` passes `problems` to `insertChildren`. In `PlanOutline`, a week or month row shows its
  `formatUnitTime(time)` and, when it has `problems`, the lines under it (muted, one per line); the root's `problems`
  show above the outline. (There is no separate heading page; the outline row is the week's place on the track page.)

- [ ] **Step 1: Write failing test**: an outline row for a week with `problems: ["Week 3 plans …"]` renders that line;
  a week without renders none.
- [ ] **Step 2: Run** `npx vitest run "app/tracks/[id]/OutlineRows.test.ts"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(track): a week's problems saved and shown on the track page`

### Task 10: Re-drafting the open part of a plan

**Files:**
- Create: `lib/ai/planRedraft.ts`
- Modify: `lib/ai/planDraft.ts` (`DraftLevelInput`, export `draftLevel`)
- Test: `lib/ai/planRedraft.test.ts`

**Interfaces:**
- Consumes: `draftLevel` (Task 6), `LockedNodeError` (`planRevision.ts`).
- Produces:
  - `DraftLevelInput.keep?: PlanNode[]` — top-level units before the drafted ones, kept as they are: the prompt lists
    them as fixed, their reservations and items count as taken (existing availability lines), the checks see them in
    the tree; the drafted level's spans cover only the rest of the plan.
  - `type RedraftScope = { kind: "plan" } | { kind: "level"; parentId: string | null }`
  - `interface RedraftInput { topic; instructions?; materials: Material[]; granularity; weeks; daysPerWeek; hoursPerWeek?; split?: PlanSplit | null; tree: PlanNode; lockBefore: number; scope: RedraftScope; outlineModel?: ResolvedModel; log?: GenerationLogContext; signal?: AbortSignal }`
  - `redraftPlan(input: RedraftInput): Promise<{ tree: PlanNode; problems: string[]; costUsd: number }>`:
    - `plan` or `level` with `parentId: null`: keeps top-level units that are completed or end on or before
      `lockBefore`; re-drafts the rest with `keep`; `plan` also plans the first open unit's first branch as
      `streamPlanDraft` does.
    - `level` with a heading id: re-drafts its children; throws `LockedNodeError` when any child is completed or locked.
    - Returns the new tree with `problems` set on root/parents as in Task 6, and all of them flattened.

- [ ] **Step 1: Write failing tests** (fake model): with Weeks 1–2 completed and `scope: plan`, Weeks 1–2 (titles,
  covers, item runs) are deep-equal before and after, Weeks 3–8 are the model's; `level` on Week 4 with a completed day
  throws `LockedNodeError`; problems from the re-drafted level come back flattened.
- [ ] **Step 2: Run** `npx vitest run lib/ai/planRedraft.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(outline): re-draft the open part of a plan`

### Task 11: The chat can re-draft

**Files:**
- Modify: `lib/ai/planChat.ts` (add tool), `lib/ai/planPrompt.ts` (`buildPlanChatSystemPrompt`)
- Test: `lib/ai/planChat.test.ts`

**Interfaces:**
- Consumes: `redraftPlan` (Task 10).
- Produces: tool `redraftPlan` beside `revisePlan`, input
  `z.object({ scope: z.enum(["plan", "level"]), unit: z.string().nullable().describe('The heading whose units to re-draft, by label, e.g. "Week 3"; null for the top level') })`.
  It resolves `unit` by `labelOf` over the tree (unknown label → tool error text, no change), runs `redraftPlan`, and
  emits the same `revised` event (with `problems`) as `revisePlan`. System prompt rule: requests to regenerate, redo or
  re-draft the plan or part of it call `redraftPlan`; targeted edits call `revisePlan`. Log label `Answer · redraftPlan`.

- [ ] **Step 1: Write failing test**: a fake chat model calling `redraftPlan({ scope: "level", unit: "Week 3" })` makes
  the turn yield `revised` with Week 3's new children and `problems`; `unit: "Week 99"` yields no `revised`.
- [ ] **Step 2: Run** `npx vitest run lib/ai/planChat.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): a re-draft tool`

### Task 12: Changing hours or the split re-drafts the open plan

**Files:**
- Create: `app/api/plan/redraft/route.ts`
- Modify: `components/pensieve/PlanWorkspace.tsx` (`changeHours`, `changeSplit`), `lib/planChat.ts` (request/response types)
- Test: `components/pensieve/PlanWorkspace.test.ts` (or a hook test if the logic is extracted), route test following
  `app/api/plan/chat`'s

**Interfaces:**
- Consumes: `redraftPlan` (Task 10), `problemsText` (Task 8).
- Produces:
  - `POST /api/plan/redraft`, body = the chat route's body minus `transcript`, plus `scope` (always `{ kind: "plan" }`
    from the pickers). Same auth, credit gate, model resolution and call logging as `/api/plan/chat`. Response
    `{ tree, problems, costUsd }` (JSON; or ndjson with call events if the chat route's admin call events are wanted).
  - `REDRAFT_DEBOUNCE_MS = 1500`: `changeHours` / `changeSplit` set state as today (dropping `rebudget`), then schedule
    one re-draft for the settled value; a new change within the window replaces it; while a re-draft or chat turn is
    running the input shows busy. Result: `setTree`, and a `sys` message
    `"Re-drafted the open weeks for ${hours} h a week."` (split: `"…for the new time split."`) followed by
    `problemsText(problems)`.

- [ ] **Step 1: Write failing tests**: three `changeHours` calls 6 → 7 → 8 within 1 s (fake timers) send one request
  with `hoursPerWeek: 8`; the response's tree replaces the workspace tree; the route rejects an unauthenticated call.
- [ ] **Step 2: Run** the tests — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workspace): changing hours or the split re-drafts the open plan`

### Task 13: Whole-branch verification

- [ ] **Step 1:** `npm test`, `npx tsc --noEmit`, `npm run lint` — Expected: all pass.
- [ ] **Step 2:** Ask the user before `npx drizzle-kit migrate` (production database). After approval, apply.
- [ ] **Step 3:** Live check on a worktree server at `localhost:3001` (started detached with `nohup`, never the
  user's 3000), in the user's Chrome in a fresh tab: draft the 2026-11-02 topic (senior SWE interview prep, 8 weeks,
  6 h). Expected: exactly one "Top level" outline call in the admin model-calls panel, no "(retry)"; week lines show
  their time; any problems appear in the chat reply in plain words; "re-draft week 3" in the chat replaces only Week
  3's days; changing hours to 7 re-drafts once.
- [ ] **Step 4:** Report what was and was not verified.
