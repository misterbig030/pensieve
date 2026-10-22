# Practice Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "left for practice" remainder with assigned practice: a fixed set of formats picked per plan before research, sourced by research, assigned as rows next to the reading, balanced over the week, and explained in the lesson.

**Architecture:** A registry in `lib/practice.ts` is the contract. A new model call picks formats and the reading share before research (`lib/ai/practicePick.ts`); the split carries the picks to research (a practice direction), the drafter (practice rows and reservations, checked over the week) and the lesson. Practice rows live in a new `node_practice` table so generated rows need no source.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before Next-specific code), TypeScript, zod, AI SDK (`generateObject`/`streamObject`), Drizzle on Neon Postgres, vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-practice-formats-design.md`

## Global Constraints

- Format ids, exactly: `problem-set`, `recall`, `design-exercise`, `lab`, `project`, `mock`, `session`. Labels: Problems, Recall, Design, Lab, Project, Mock, Session.
- A split has 0–4 picks; pick shares are normalised to sum to 100. No picks means the plan is all reading.
- Code never branches on the topic. Only the picks drive behaviour.
- Generation rules per format: `problem-set` and `lab` never; `recall` only from the unit's own reading, with answers; `design-exercise` only with a rubric; `project` milestones of a build the plan names, each with a done condition; `mock` for interviews with prompt and rubric, never for exams; `session` only built from a found programme or the unit's reading. Every generated row says so (`generated: true`).
- Practice shares and must-reading balance over a week; a single day is checked only against its own total budget.
- Tolerance as today: `SHARE_TOLERANCE` (1.25) and the existing +10 min slack in `levelChecks`.
- Existing plans are not migrated. A split without `formats` and a unit without practice rows keep working; the only change they see is the budget line ("x of y h reading" instead of "left for practice").
- Migrations are additive. The local `DATABASE_URL` is the production database: generate migrations freely, but ask the owner before every `npx drizzle-kit migrate`.
- Copy: no "left for" anywhere. The budget line reads like "3 h 11 reading · 2 h 49 practice · 6 h".
- Live checks run on Claude's own dev server at localhost:3001 from a worktree, in the owner's Chrome; leave it running afterwards.

## Review Focus

1. The pick call returns junk: duplicate formats, an unknown format, more than four picks, shares summing to 63 or 140. Expected: normalised to valid picks summing to 100, unknown dropped (Task 1).
2. Contradictory splits: `readingShare` 100 with picks, or no picks with `readingShare` 60. Expected: picks dropped at 100; reading becomes 100 with no picks (Task 2).
3. A pick with no verified source and a format that may not be generated (e.g. `problem-set` for a niche topic). Expected: no rows for it, its minutes go back to reading, and a fact says so (Task 12).
4. A task longer than any day can hold (3 h a week over 7 days is about 25 min a day; a 60-min mock). Expected: the day's total breaches `over-budget`, so the retry moves or drops it (Task 13).
5. The learner removes a material in adjust mode that practice rows and practice reservations use. Expected: those rows and reservations go too, as reading refs do (Task 11).

---

## Phase A: picking practice before research (ships alone)

### Task 1: The practice registry and pick normalisation

**Files:**
- Create: `lib/practice.ts`
- Test: `lib/practice.test.ts`

**Interfaces:**
- Produces:
  - `PRACTICE_FORMATS` (the seven ids, as const) and `type PracticeFormat`.
  - `interface PracticeFormatSpec { id: PracticeFormat; label: string; prompt: string; doneWhen: string; perItemMinutes: number | null; fixedMinutes: number | null; research: string; generated: "never" | "from-reading" | "with-rubric" | "milestones" | "interview-only" | "from-programme"; needsAnswers: boolean }`.
  - `PRACTICE_REGISTRY: Record<PracticeFormat, PracticeFormatSpec>`, values from the spec's table: `problem-set` 10 min per problem (medium), needsAnswers; `recall` 3 per question, needsAnswers; `design-exercise` fixed 50, needsAnswers (worked solution or rubric); `lab` per-item 5 per step, no answers; `project` none (gets the remainder), no answers; `mock` fixed 75 (a 60-min round + 15 min review), needsAnswers; `session` none (programme length), no answers.
  - `lib/practice.ts` imports `PlanSplit` from `lib/studyTime.ts` as a type only (`import type`), since `studyTime.ts` imports the pick schemas from here.
  - `practicePickSchema = z.object({ format: z.enum(PRACTICE_FORMATS), share: z.number().int().min(1).max(100), focus: z.string().trim().min(1).max(160), reason: z.string().trim().max(300) })`, `type PracticePick`.
  - `practicePickDraftSchema` (looser: `share: z.number()`, strings unbounded, `format: z.string()`), `type PracticePickDraft`.
  - `normalizePicks(drafts: PracticePickDraft[] | null | undefined): PracticePick[]`.

- [ ] **Step 1: Write the failing tests** in `lib/practice.test.ts`:
  - `it("keeps known formats, drops unknown ones and duplicates, and caps the picks at four")`: input with `problem-set`, `quiz` (unknown), `problem-set` again, `mock`, `design-exercise`, `recall`, `lab` → formats `["problem-set", "mock", "design-exercise", "recall"]`.
  - `it("normalises shares to sum to 100")`: shares 40, 40, 60 → 29, 29, 42 (largest remainder; total exactly 100); a single pick → 100; a share of 0 or negative → the pick dropped.
  - `it("clips focus and reason, and drops a pick with no focus")`.
  - `it("lists every format in the registry with a label, a research line and a generation rule")`: `PRACTICE_FORMATS.every((f) => PRACTICE_REGISTRY[f].label && PRACTICE_REGISTRY[f].research)`.
- [ ] **Step 2: Run** `VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vitest run lib/practice.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `lib/practice.ts` as above. Shares: drop ≤0, scale to 100 with the largest-remainder method so the rounded shares sum to exactly 100.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(practice): the practice format registry and pick normalisation`.

### Task 2: The split carries the picks

**Files:**
- Modify: `lib/studyTime.ts` (`planSplitSchema`, `planSplitDraftSchema`, `normalizeSplit`)
- Test: `lib/studyTime.test.ts`

**Interfaces:**
- Consumes: `practicePickSchema`, `practicePickDraftSchema`, `normalizePicks` (Task 1).
- Produces:
  - `planSplitSchema` gains `formats: z.array(practicePickSchema).max(4).optional()`. `PlanSplit.formats` absent on plans saved before this.
  - `planSplitDraftSchema` gains `picks: z.array(practicePickDraftSchema).describe(...)`; `practice` (the label) stays.
  - `normalizeSplit(draft)` returns `formats` too. Contradictions: `readingShare >= 100` → `formats: []`; no valid picks → `readingShare: 100`.
  - `practiceLabelOf(split: PlanSplit): string` — `split.practice`, or the joined pick labels when present ("problems, design and mocks").

- [ ] **Step 1: Write the failing tests** in `lib/studyTime.test.ts`: `it("carries normalised picks")`; `it("drops picks at 100% reading and reads 100% when no pick survives")`; `it("parses a split saved before picks existed")` (`planSplitSchema.parse({ readingShare: 60, practice: "practice problems", reason: "r" })` has no `formats`).
- [ ] **Step 2: Run** `npx vitest run lib/studyTime.test.ts` (with the env var). Expected: FAIL.
- [ ] **Step 3: Implement** the schema changes and `practiceLabelOf`.
- [ ] **Step 4: Run** it. Expected: PASS. Also run `npx tsc --noEmit -p .` and fix callers that construct a `PlanSplit` (none should break: `formats` is optional).
- [ ] **Step 5: Commit** `feat(practice): the plan's split carries its practice picks`.

### Task 3: The pick call

**Files:**
- Create: `lib/ai/practicePick.ts`
- Test: `lib/ai/practicePick.test.ts` (mock `ai` as `lib/ai/planRevision.test.ts` does: `vi.mock("ai", () => ({ generateObject: vi.fn() }))`)

**Interfaces:**
- Consumes: `PRACTICE_REGISTRY` (Task 1), `planSplitDraftSchema`, `normalizeSplit` (Task 2), `loggedGenerateObject` (`lib/ai/logged.ts`), `ResolvedModel`.
- Produces:
  - `interface PracticePickInput { topic: string; instructions?: string; weeks: number; daysPerWeek: number; hoursPerWeek?: number; sources: SourceInput[] }`.
  - `buildPracticePickPrompt(input: PracticePickInput): string`.
  - `pickPractice(input: PracticePickInput & { model: ResolvedModel; log?: GenerationLogContext }): Promise<{ split: PlanSplit; costUsd: number }>`. Label `"Practice · pick"`, caller `"outline"`. When the model returns no usable split, it returns `{ readingShare: 100, practice: "reading", reason: "", formats: [] }` and the facts say so.

- [ ] **Step 1: Write the failing tests:**
  - `it("lists every format with its line and gives the worked examples")`: the prompt contains each `PRACTICE_REGISTRY[f].prompt`, and the examples "an SDE interview loop", "an MLE interview loop", "a history topic", "Git", "Couch to 5K".
  - `it("puts the learner's instructions above the examples")`: with instructions "No apps and no video", the prompt contains them and the line `The learner's instructions win over the examples.`
  - `it("returns the normalised split")`: the mocked `generateObject` returns `{ readingShare: 30, practice: "interview practice", reason: "r", picks: [{ format: "problem-set", share: 50, focus: "arrays", reason: "x" }, { format: "mock", share: 50, focus: "behavioral", reason: "y" }] }` → `split.formats` has those two at 50/50.
  - `it("falls back to all reading when the model returns nothing usable")`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** The prompt: the brief (topic, instructions, length in weeks, days and hours), one line per format from the registry, the worked examples, "pick 0 to 4", "readingShare is the percent of time spent reading or watching", and that the examples are guidance not rules. Wording is the builder's.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(practice): a call that picks the plan's practice before research`.

### Task 4: Pick before research; the drafter stops deciding the split

**Files:**
- Modify: `lib/ai/planDraft.ts` (`streamPlanDraft`, `streamResearchedPlanDraft`, `streamUnits`, `draftLevel`), `lib/schemas/plan.ts` (remove `topUnitListSchema`), `lib/ai/planPrompt.ts` (remove the `decideSplit` branches, around lines 236, 269–270, 338, 376), `lib/ai/research/agent.ts` (`ResearchBrief` gains `split?: PlanSplit`), `evals/research/compare.ts`, `evals/scripts/sample-plans.ts`
- Test: `lib/ai/planDraft.test.ts`, `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Consumes: `pickPractice` (Task 3).
- Produces:
  - `streamPlanDraft(input)`: when `input.split` is absent it calls `pickPractice` first and yields `{ type: "split", split }` before any node; it never asks the drafter for a split.
  - `streamResearchedPlanDraft(input)`: picks first (yielding `split`), then runs research with `brief.split`, then drafts with that split.
  - `UnitsPromptInput.decideSplit` and `StreamUnitsInput.wantSplit` are removed.

- [ ] **Step 1: Update the tests:** in `planDraft.test.ts`, replace the "streamPlanDraft and the time split" block with `it("picks the practice first and announces the split before any unit")` (first `generateObject`/`streamObject` mock is the pick call; first yielded event is `split`) and `it("keeps a split it is given and makes no pick call")`. In `planPrompt.test.ts`, drop the "asks the top level of a new plan to decide the split" test.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** The outline model makes the pick call (`input.outlineModel ?? appModel(DEFAULT_OUTLINE_MODEL)`). `evals/scripts/sample-plans.ts` drafts without research, so `streamPlanDraft`'s own pick covers it. `evals/research/compare.ts` runs research itself before drafting: call `pickPractice` before `researchMaterials`, put the split in the brief, and pass it to `streamPlanDraft`.
- [ ] **Step 4: Run** `npx vitest run` (whole suite) and `npx tsc --noEmit -p .`. Expected: PASS, no type errors except the pre-existing `app/layout.tsx` `LayoutProps`.
- [ ] **Step 5: Commit** `feat(practice): pick the practice before research; the drafter no longer decides the split`.

### Task 5: Show the picks; drop the leftover line

**Files:**
- Modify: `components/pensieve/TimeSplitCard.tsx`, `components/pensieve/ReadTable.tsx` (`BudgetBar`), `components/pensieve/PlanWorkspace.tsx` (the drafted message around line 784 uses `practiceLabelOf`)
- Test: `components/pensieve/ReadTable.test.ts`, `lib/practice.test.ts`

**Interfaces:**
- Consumes: `PlanSplit.formats`, `PRACTICE_REGISTRY`, `practiceLabelOf`.
- Produces:
  - `formatHours(split: PlanSplit, totalHours: number): { format: PracticeFormat; label: string; hours: number; focus: string }[]` in `lib/practice.ts`.
  - `budgetLine(input: { readingMinutes: number; practiceMinutes: number; budgetMinutes: number }): string` in `components/pensieve/ReadTable.tsx`.

- [ ] **Step 1: Write the failing tests:** `budgetLine` gives `"3 h 11 reading · 2 h 49 practice · 6 h"` for 191/169/360, and `"3 h 11 of 6 h reading"` when practice is 0 (plans without practice rows); `formatHours` splits 24 practice hours 50/30/20 into 12/7/5 (rounded, summing to the practice hours).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `BudgetBar` drops "Leaves … for …" and "… left for …" and uses `budgetLine`. `TimeSplitCard`: when `split.formats` has picks, the practice part of the bar is one segment per pick and the legend lists "Problems · about 12 h — arrays, graphs, DP"; splits without picks render as today.
- [ ] **Step 4: Run** the tests, then a live check: draft a new 2-week "Senior SDE interview" plan on localhost:3001 (unsaved), read the time card and a week's budget line with `get_page_text`. Expected: picks with hours and focus; no "left for".
- [ ] **Step 5: Commit** `feat(practice): show the picks on the time card; the budget line drops "left for"`.

### Task 6: Eval labels and metrics for the picks

**Files:**
- Modify: `evals/research/golden.v3.ts`, `evals/research/metrics.ts`, `evals/research/compare.ts`
- Test: `evals/research/metrics.test.ts`

**Interfaces:**
- Produces:
  - `labels.formats?: { include?: PracticeFormat[]; exclude?: PracticeFormat[] }` on `ResearchGoldenRecord`.
  - `formatHit(picks: PracticePick[], labels?: { include?: PracticeFormat[]; exclude?: PracticeFormat[] }): { missing: PracticeFormat[]; unwanted: PracticeFormat[] } | null` in `metrics.ts`; `RunMetrics` gains `picks: PracticeFormat[]` and `formatHit`.

- [ ] **Step 1: Write the failing test:** `formatHit` with include `["problem-set", "mock"]`, exclude `["session"]` against picks `problem-set, session` → `{ missing: ["mock"], unwanted: ["session"] }`; no labels → `null`.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement**, and add labels: `int-56d-nosrc-sde-01` include `problem-set, design-exercise, mock`; `int-42d-nosrc-aiproduct-01` include `recall, design-exercise, mock`; `int-56d-nosrc-mle-01` include `recall, design-exercise`; `soft-30d-nosrc-frenchrev-01` include `recall`, exclude `problem-set`; `soft-56d-nosrc-5k-01` include `session`; `tech-84d-nosrc-fulltime-01` include `project`; `tech-28d-nosrc-casual-01` include `problem-set`. `compare.ts` prints picks and the hit per run.
- [ ] **Step 4: Run** `npx vitest run evals`. Expected: PASS. Then ask the owner before spending on `npx tsx evals/research/compare.ts --records int-56d-nosrc-sde-01,int-42d-nosrc-aiproduct-01,int-56d-nosrc-mle-01 --arms A --runs 1`.
- [ ] **Step 5: Commit** `evals: expected practice formats per brief, and a format hit metric`.

## Phase B: research finds practice sources (ships alone)

### Task 7: Materials carry a practice role

**Files:**
- Modify: `lib/schemas/material.ts` (`materialSchema`), `lib/db/schema.ts` (`sources.practice jsonb`), `lib/db/queries.ts` (`materialsToRows`, `sourceToMaterial`), `lib/ai/research/verify.ts` (`candidateSchema`, `learnerNoteSchema`, the gate's learner and candidate paths and same-URL merge)
- Create: `drizzle/0013_*.sql` via `npx drizzle-kit generate --name source_practice`
- Test: `lib/ai/research/verify.test.ts`, `lib/db/materials.test.ts`

**Interfaces:**
- Produces:
  - `materialPracticeSchema = z.object({ format: z.enum(PRACTICE_FORMATS), items: z.number().int().min(1).max(5000).nullable(), perItemMinutes: z.number().int().min(1).max(600).nullable(), minutes: z.number().int().min(1).max(60000).nullable(), answers: z.boolean() })`; `Material.practice?: MaterialPractice | null`. `minutes` here is doing time; `Material.minutes` stays reading time (null for a practice-only source).
  - `practiceDraftSchema` (format string, items, perItemMinutes, answers) on `candidateSchema.practice` and `learnerNoteSchema.practice`, both optional.
  - `normalizePractice(draft, registry = PRACTICE_REGISTRY): MaterialPractice | null` in `verify.ts`: unknown format → null; `needsAnswers` format with `answers: false` → null (and a practice-only candidate is then dropped with reason "practice without answers"); `minutes = items × (perItemMinutes ?? registry per-item)` when items are known, else the registry's fixed minutes, else null.

- [ ] **Step 1: Write the failing tests:** `normalizePractice` cases above; a gate test where the reading and practice directions both propose one URL (a book with exercises) → one material with reading fields and `practice`; a learner link tagged `problem-set` keeps its tag; a DB round trip keeps `practice` (`createTrackWithPlan` then `getTrackDetail`).
- [ ] **Step 2: Run** `npx vitest run lib/ai/research/verify.test.ts lib/db/materials.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then `npx drizzle-kit generate --name source_practice` (additive: `ALTER TABLE "sources" ADD COLUMN "practice" jsonb`). Do not migrate yet.
- [ ] **Step 4: Run** the tests (they use the test database from `lib/db/testDb.ts`). Expected: PASS. Ask the owner, then `npx drizzle-kit migrate`.
- [ ] **Step 5: Commit** `feat(practice): materials can serve as practice, found by research or tagged on the learner's own links`.

### Task 8: A practice direction in research

**Files:**
- Modify: `lib/ai/research/events.ts` (`WorkerDirection` adds `"practice"`), `lib/ai/research/workers.ts` (`splitCaps`, a `PRACTICE_BRIEF`, `buildWorkerInstructions`), `lib/ai/research/agent.ts` (`buildResearchInstructions` work order, `buildFinalPrompt`'s candidate and coverage lines)
- Test: `lib/ai/research/workers.test.ts`, `lib/ai/research/agent.test.ts`

**Interfaces:**
- Consumes: `ResearchBrief.split` (Task 4), `PRACTICE_REGISTRY`.
- Produces:
  - `splitCaps(caps: ResearchCaps, practice: boolean): WorkerPlan[]` — with `practice`, a `practice` worker gets 2 steps, `max(1, floor(searches / 4))` searches and `max(2, floor(fetches / 4))` reads, taken from canonical and current; without it, today's split exactly.
  - `PRACTICE_BRIEF(picks: PracticePick[]): string[]` — objective lists each pick as `registry.research + " for: " + pick.focus`; boundaries: only practice sources, prefer ones with answers.
  - Arm A: the work order gains "6. Practice" listing the same lines when picks exist; the first line no longer says the split is decided later.
  - `buildFinalPrompt`: candidates may carry `practice` (format, items, minutes per item, answers); a pick with no candidate goes in `coverage.open` as `practice: <label>`.

- [ ] **Step 1: Write the failing tests:** `splitCaps(RESEARCH_CAPS, true)` includes a `practice` worker and the searches still sum to the band's; `splitCaps(caps, false)` equals today's output; `buildWorkerInstructions` for the practice worker contains each pick's focus; arm A's instructions contain "Practice" only when the brief's split has picks; the final prompt's coverage line mentions `practice:` for open picks.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(practice): research looks for practice sources for each pick`.

### Task 9: The materials list shows practice

**Files:**
- Modify: `components/pensieve/MaterialsList.tsx`
- Test: `components/pensieve/MaterialsList.test.ts` (create; pure helpers only)

**Interfaces:**
- Produces: `practiceTag(p: MaterialPractice): string` ("Problems · 150 problems · answers included") and `materialTotals(materials: Material[]): { readingMinutes: number; practiceMinutes: number }`.

- [ ] **Step 1: Write the failing tests** for both helpers (a practice-only bank counts only practice minutes; a book with exercises counts both).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Practice-only materials (reading `minutes` null and `practice` set) render in a "Practice" group after the kind groups; dual-role ones stay in their kind group with the tag. The header total reads "≈ 5 h 35 of reading + 9 h of practice".
- [ ] **Step 4: Run** the tests; live-check a new "MLE interview" draft on 3001 for the Practice group. Expected: PASS; the group lists at least one source or the coverage notice names the open pick.
- [ ] **Step 5: Commit** `feat(practice): the materials list shows practice sources`.

## Phase C: practice rows (ships alone)

### Task 10: Practice rows and week budgets in the model

**Files:**
- Modify: `lib/schemas/material.ts`, `lib/planTree.ts` (`PlanNode`, `makeNode`, `NewNodeInput`), `lib/practice.ts`
- Test: `lib/practice.test.ts`, `lib/planTree.test.ts`

**Interfaces:**
- Produces:
  - `practiceRefSchema = z.object({ format: z.enum(PRACTICE_FORMATS), id: z.string().min(1).max(64).nullable(), task: z.string().trim().min(1).max(300), done: z.string().trim().min(1).max(300), minutes: z.number().int().min(1).max(600), generated: z.boolean() })`, `type PracticeRef`. `id` is a material id (a practice source, or the unit's reading for generated recall) or null.
  - `practiceCoverSchema = z.object({ format: z.enum(PRACTICE_FORMATS), id: z.string().min(1).max(64), note: z.string().max(300).nullable(), task: z.string().max(300).optional(), minutes: z.number().int().min(1).max(600).optional() })`, `type PracticeCover` — a heading's reservation; `task`/`minutes` are kept when a week leaf is split (as PR #19 keeps a Read table).
  - The spec calls a practice row's source `sourceId`; in the tree it is `id`, like reading refs, so `remapTreeRefs` maps short ids to uuids for both.
  - `PlanNode.practice?: PracticeRef[]` (leaves), `PlanNode.practiceCovers?: PracticeCover[]` (headings).
  - `weekBudgets(split: PlanSplit | null | undefined, weekMinutes: number): { reading: number; practice: Partial<Record<PracticeFormat, number>> }` — no split or no picks → all reading.

- [ ] **Step 1: Write the failing tests:** `weekBudgets` for 600 min at 30% reading with picks 50/30/20 → reading 180, practice 210/126/84; no picks → reading 600; `makeNode` keeps `practice` and `practiceCovers` only when non-empty.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(practice): practice rows, reservations and week budgets in the plan model`.

### Task 11: Storing practice

**Files:**
- Modify: `lib/db/schema.ts` (`nodePractice` table), `lib/db/planQueries.ts` (`rowsToTree`, `getTrackNodeMaterials`'s sibling `getTrackNodePractice`, `flattenTree`, `insertPlanTree`, `replacePlanTree`, `insertChildren`), `lib/db/queries.ts` (`getTrackDetail`), `lib/schemas/plan.ts` (`nodeInputBase` gains `practice`, `practiceCovers`), `lib/planInput.ts`, `lib/materials.ts` (`remapTreeRefs`, `removeMaterialRefs`)
- Create: `drizzle/0014_*.sql` via `npx drizzle-kit generate --name node_practice`
- Test: `lib/db/materials.test.ts`, `lib/materials.test.ts`

**Interfaces:**
- Produces: table `node_practice` (`id` uuid pk, `node_id` → plan_nodes cascade, `role` `covers|assigned`, `position` int, `format` text, `source_id` → sources cascade, nullable, `task` text, `done` text nullable, `note` text nullable, `minutes` int nullable, `generated` boolean default false); index on `node_id`.
  - `insertChildren(..., manualSplit)`: a split week's `assigned` practice rows become `covers` with `task` and `minutes` kept.

- [ ] **Step 1: Write the failing tests:** save and load a week leaf with two practice rows (one sourced, one generated) and a heading with a practice reservation; split that week into 3 days and see the rows become reservations with task and minutes; `replacePlanTree` re-save keeps them; `removeMaterialRefs(root, sourceId)` drops sourced practice rows and reservations but keeps generated rows with `id: null` (Review Focus 5); `remapTreeRefs` maps practice ids.
- [ ] **Step 2: Run** `npx vitest run lib/db/materials.test.ts lib/materials.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then `npx drizzle-kit generate --name node_practice`.
- [ ] **Step 4: Run.** Expected: PASS. Ask the owner, then `npx drizzle-kit migrate`.
- [ ] **Step 5: Commit** `feat(practice): store practice rows and reservations`.

### Task 12: Drafting practice rows

**Files:**
- Modify: `lib/schemas/plan.ts` (`unitDraftSchema` gains `practice` and `practiceCovers` drafts), `lib/ai/planPrompt.ts` (`leafMaterialRules`, `headingMaterialRules`, `renderRefs`, the unit list lines), `lib/materials.ts` (`resolvePracticeRefs`, `resolvePracticeCovers`), `lib/ai/planDraft.ts` (`applyUnitRefs`, `nodeFor`, the split conversion in `streamExpandNode`), `components/pensieve/PlanWorkspace.tsx` (`splitWeek`)
- Test: `lib/ai/planPrompt.test.ts`, `lib/materials.test.ts`, `lib/ai/planDraft.test.ts`

**Interfaces:**
- Consumes: `weekBudgets` (Task 10), `PRACTICE_REGISTRY`, `MaterialAliases`.
- Produces:
  - `practiceRefDraftSchema = z.object({ format: z.string(), id: z.string().nullable().optional(), task: z.string(), done: z.string(), minutes: z.number() })`, `practiceCoverDraftSchema = z.object({ format: z.string(), id: z.string(), note: z.string().optional() })`.
  - `resolvePracticeCovers(drafts: PracticeCoverDraft[] | undefined, aliases: MaterialAliases, split: PlanSplit | null | undefined): { refs: PracticeCover[]; unknown: string[] }` — a cover whose format is not a pick, or whose material has no `practice` role, is dropped into `unknown`.
  - `resolvePracticeRefs(drafts: PracticeRefDraft[] | undefined, aliases: MaterialAliases, split: PlanSplit | null | undefined): { refs: PracticeRef[]; unknown: string[]; refused: string[] }` — a row whose format is not a pick is refused; a row with no id is `generated: true` and refused unless the format's rule allows generation; a `recall` row generated from reading must name a reading id of the unit.
  - Prompts: a leaf level gets the week's practice budget per pick (from `weekBudgets` of the parent week, or the week leaf itself), the pick's focus, the sources reserved for it, and the rule "place a task longer than half a day's budget on a day of its own". A heading level gets each pick's practice sources to reserve in order, with the part in the note.

- [ ] **Step 1: Write the failing tests:** `resolvePracticeRefs` refuses a `problem-set` row with no id, accepts a generated `recall` row whose id is the unit's reading, refuses a format that is not picked; the units prompt for the days of a split week lists each pick's week minutes and the half-a-day rule; a pick with no source and `generated: "never"` gets no line asking for rows and a fact `"no source for <label>: its time goes to reading"` (Review Focus 3).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** When a pick can't be assigned, `weekBudgets` is called with that pick removed so its share goes back to reading.
- [ ] **Step 4: Run** the three files and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(practice): the drafter assigns practice rows and reservations`.

### Task 13: Checks over the week

**Files:**
- Modify: `lib/materials.ts` (`levelChecks`, `treeChecks`, `BreachKind`, `DROPPABLE`, `dropBreaches`)
- Test: `lib/materials.test.ts`

**Interfaces:**
- Produces:
  - `BreachKind` gains `"practice-outside"` (a sourced row not in the reservation; droppable) and `"practice-generated"` (generated where the registry forbids; droppable).
  - `LevelCheckInput.split?: PlanSplit | null` (replaces the use of `readingShare` alone).
  - Day levels under a week: each day's must + should + practice ≤ its budget × tolerance + 10 (`over-budget`); over the week's days, must ≤ the reading budget × tolerance + 10 and each pick's minutes ≤ its share × tolerance + 10 (`over-budget`, named for the week); under-assignment is a fact, not a breach. Week leaves: the same week rule on the leaf. Should-reading fits what must leaves of the reading budget (fact when over).
  - The per-day must-share check is removed for day levels.

- [ ] **Step 1: Write the failing tests:** a week of five days where day 1 is all reading and day 3 is a 75-min mock day passes; the same week with must-reading over the week's reading budget breaches once, naming the week; a 60-min mock on a 25-min day breaches `over-budget` for that day (Review Focus 4); a sourced practice row outside the reservation is `practice-outside` and `dropBreaches` removes it.
- [ ] **Step 2: Run** `npx vitest run lib/materials.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and pass `split` from `draftLevel` and `revisePlanTree` into the checks.
- [ ] **Step 4: Run** the full suite. Expected: PASS (update existing per-day share expectations that this replaces).
- [ ] **Step 5: Commit** `feat(practice): practice and reading checked over the week`.

### Task 14: Revisions keep practice

**Files:**
- Modify: `lib/schemas/plan.ts` (`revisedLeafSchema` gains `practice`, `practiceCovers` drafts), `lib/ai/planRevision.ts` (`applyRevision`), `lib/ai/planPrompt.ts` (`buildRevisionPrompt` rule line)
- Test: `lib/ai/planRevision.test.ts`

- [ ] **Step 1: Write the failing tests:** a kept leaf whose practice the model leaves out keeps it; one the model rewrites takes the new rows through `resolvePracticeRefs`; a kept split week's practice reservations keep `task` and `minutes` when the model writes them back with ids only (as `keepCoverTiers` does for reading).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(practice): revisions keep and edit practice rows`.

### Task 15: The Do table

**Files:**
- Modify: `components/pensieve/ReadTable.tsx` (`ReadTable`, `BudgetBar`), `components/pensieve/PlanTree.tsx` (`LeafChip`, `GroupCard` kept table), `app/tracks/[id]/nodes/[nodeId]/page.tsx`, `app/tracks/[id]/nodes/[nodeId]/LeafView.tsx`
- Test: `components/pensieve/ReadTable.test.ts`

**Interfaces:**
- Produces: `practiceRowsFor(refs: PracticeRef[] | undefined, byId: ReadonlyMap<string, Material>): PracticeRow[]` with `{ format, label, task, done, minutes, material: Material | null, generated, key }`; `ReadTable` takes `practice?: PracticeRow[]` and renders a "Do" section after Must/Should: format pill, task, minutes, the source link or a "Generated" tag, and the done line. `BudgetBar` passes practice minutes to `budgetLine`.

- [ ] **Step 1: Write the failing tests** for `practiceRowsFor` (a generated row has `material: null` and `generated: true`; an unknown id is dropped).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Day chips show one line per practice task under the reading lines; a split week's card shows its practice reservations next to its kept Read table.
- [ ] **Step 4: Run** the tests, then a live check on 3001: a new 2-week "Senior SDE interview" draft (unsaved), split Week 1 into 5 days; read the week card and two days with `get_page_text`. Expected: Do rows with sources or Generated tags; the budget line "… reading · … practice · …"; at least one day holds a design exercise or mock on its own.
- [ ] **Step 5: Commit** `feat(practice): the Do table and practice on day and week cards`.

### Task 16: The lesson explains each task

**Files:**
- Modify: `lib/ai/dailyContent.ts` (`LessonMaterial` stays; add `LessonPractice` and a section in `buildDailyContentPrompt`), `app/tracks/[id]/nodes/[nodeId]/actions.ts` (pass the unit's practice rows)
- Test: `lib/ai/dailyContent.test.ts`

**Interfaces:**
- Produces: `interface LessonPractice { format: PracticeFormat; label: string; task: string; done: string; minutes: number; source: { title: string; url: string } | null; generated: boolean }`; `buildDailyContentPrompt` input gains `practice?: LessonPractice[]`.

- [ ] **Step 1: Write the failing tests:** the prompt lists each task with its done line and link; a generated recall task asks for the questions with answers in a collapsed `<details>` block; a unit without practice gives the same prompt as today (snapshot of the existing test input unchanged); citations still only allow the unit's list.
- [ ] **Step 2: Run** `npx vitest run lib/ai/dailyContent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Live check on 3001: open a saved test track's day with practice and generate its lesson (ask the owner before saving a plan to the shared database).
- [ ] **Step 5: Commit** `feat(practice): the lesson explains how to do and check each task`.

---

Each phase ends with `npx vitest run`, `npx tsc --noEmit -p .` and `npx eslint app components lib evals` clean, and its own PR.
