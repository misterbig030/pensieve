# Study hours, sized materials and the plan's time split: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the learner state weekly hours, have research size what it finds against the total, and have the drafter decide how time divides between reading and practice.

**Architecture:** One pure module (`lib/studyTime.ts`) owns hours, totals, day budgets, the split type and the caps table. `hoursPerWeek` and `split` ride on the existing plan context through drafting, expansion, revision and chat. Research gains size fields on candidates and materials, measured in the gate where possible.

**Tech stack:** Next.js 16, Drizzle/Neon, AI SDK v7 via the gateway, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-study-hours-design.md`

## Global constraints

- Defaults keep today's behaviour: 6 hours a week, no split means the 60% fallback.
- New wire fields are optional so saved plans and older clients still parse.
- The migration is written, not applied: the local `DATABASE_URL` is production.
- Read `node_modules/next/dist/docs/` before changing Next-specific code.

---

### Task 1: `lib/studyTime.ts` and hour-aware budgets

**Files:** create `lib/studyTime.ts`, `lib/studyTime.test.ts`; modify `lib/planTree.ts` (`budgetFor(len, hoursPerWeek = 6)`), `lib/materials.ts` (`budgetMinutes(node, hoursPerWeek?)`).

**Produces:** `DEFAULT_HOURS_PER_WEEK`, `HOURS_PRESETS`, `clampHours`, `totalHours(days, h)`, `dayMinutes(h)`, `presetFor(h)`, `hoursInText(text)`, `planSplitSchema`, `PlanSplit`, `normalizeSplit(draft)`, `readingShareOf(split)`, `capsFor(totalHours)`, `rebudget(tree, h, lockBefore)`, `formatHours(minutes)`.

- [ ] Tests: totals (84 d × 6 h = 72), day minutes (6 h → 50, 30 h → 255, 1 h → 10 floor), `hoursInText` ("about 15 hours a week", "10h/week", "6 hrs per week", none), `normalizeSplit` clamps and trims, `capsFor` bands, `rebudget` skips locked weeks.
- [ ] Implement; `npx vitest run lib/studyTime.test.ts`; commit.

### Task 2: schema, migration, persistence

**Files:** `lib/db/schema.ts`, `drizzle/0008_study_hours.sql` (+ journal/snapshot via `drizzle-kit generate`), `lib/schemas/material.ts`, `lib/db/queries.ts` (`createTrackWithPlan`, `materialsToRows`, `sourceToMaterial`, new `updateTrackStudyTime`), `lib/db/materials.test.ts`.

- [ ] Add columns and optional material fields; map them both ways; test the round trip of `minutes`, `minutesBasis`, `uses`; commit. Do not run the migration.

### Task 3: research sizes materials and reports coverage

**Files:** `lib/ai/research/extract.ts` (`words`, `durationMinutes` on `PageInfo`), `verify.ts` (candidate `minutes`/`uses`, `coverage`, `BookMatch.pages`, `sizeMaterial`), `agent.ts` (brief hours, prompts, per-run caps), `pipeline.ts` (caps from hours, coverage, thin rule), `events.ts`, `evals/research/providerArm.ts`; tests beside each.

**Produces:** `ResearchBrief.hoursPerWeek?`, `Coverage { covered: string[]; open: string[] }`, `sizeMaterial(input): { minutes, basis }`, `ResearchOutcome.coverage/sizedMinutes`, `isThin(verified, coverage)`.

- [ ] Tests: ISO-8601 duration parsing, word count survives the 16k cut, book pages → minutes, essay words → measured, partial use stays estimated and is capped by the whole, thin rule, final prompt no longer says "12 to 25" and names the total hours.
- [ ] Implement; run the research tests; commit.

### Task 4: the drafter decides the split

**Files:** `lib/schemas/plan.ts` (`topUnitListSchema`), `lib/planChat.ts` (context fields, `split` event), `lib/ai/planPrompt.ts`, `lib/ai/planDraft.ts`, `lib/ai/planRevision.ts`, `lib/ai/planChat.ts`, `lib/materials.ts` (`levelFacts` share fact), routes under `app/api/plan/`, `app/tracks/[id]/actions.ts`; tests in `planPrompt.test.ts`, `planDraft.test.ts`, `materials.test.ts`.

- [ ] Tests: top-level prompt asks for the split and expansion prompts state it; budget lines use hours and share; materials render with sizes; `levelFacts` reports must-reading past the share; day budgets follow hours.
- [ ] Implement; full `npx vitest run`; `npx tsc --noEmit`; commit.

### Task 5: UI

**Files:** `components/pensieve/TrackFormFields.tsx` (time picker, brief-conflict hint), `app/tracks/new/NewTrackForm.tsx`, `app/tracks/new/actions.ts`, new `components/pensieve/TimeSplitCard.tsx`, `MaterialsList.tsx` (sizes, coverage, thin copy), `ResearchProgress.tsx` (copy, hours), `ReadTable.tsx` and `PlanTree.tsx` (practice label, hour-aware budget), `PlanWorkspace.tsx`, `ConversationRail.tsx`, adjust page and action, track and leaf pages.

- [ ] Implement against the mock; lint, typecheck, tests; verify the form and a draft in the browser; commit.

### Task 6: eval hooks and docs

**Files:** `evals/research/golden.v3.ts`, `compare.ts`, `metrics.ts` (+ test), `evals/research/README.md`, the two specs.

- [ ] Add `hoursPerWeek` to records where the brief states one, `sizedHours` and `measuredShare` metrics, README notes; commit.
