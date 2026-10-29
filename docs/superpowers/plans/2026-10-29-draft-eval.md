# Draft Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One on-demand command runs the app's draft call N times, saves everything it emitted, and decides six criteria in code with evidence.

**Architecture:** The app gains a `service` event, reported through the existing log context (`GenerationLogContext.onService`) by the Anthropic, Open Library and search clients and the catch sites that swallow failures. The route's draft input moves into one shared builder that the eval calls too, so both run the same path. `evals/draft/` captures a run into a folder, checks it in pure functions, and renders reports; saved folders can be re-scored with no calls.

**Tech Stack:** TypeScript, AI SDK 7 (`wrapLanguageModel` middleware), vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-10-29-draft-eval-design.md`

## Global Constraints

- Same path as the app: the eval builds its draft input with the same function the route uses (Task 3); never a hand-copied input.
- Nothing written to the database by the eval: no `onLog`, and on `--key user` the key guard runs with `record` and `clear` as no-ops.
- No API key and no `OPEN_LIBRARY_CONTACT` value in any saved file.
- Results go to `evals/results/` (already gitignored).
- Nothing the learner sees changes; `service` events reach the browser only where `call` events do (admin debug).
- SDE inputs: topic "Senior software engineer interview preparation", 8 weeks, 5 days a week, 6 hours a week, granularity "day", no instructions, no materials.
- Daily minutes = hours per week × 60 ÷ days per week (72 for the SDE inputs); Week 1 day tolerance ±20%.
- Warnings: cost over $2 or time over 300 s; reading rows under 2 minutes; more than one unit per 2 minutes of a source.
- Runs one at a time by default; `--parallel 2` at most.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings (spec details settled for the build)

- Anthropic successes are already the `call` events; `service` events for Anthropic carry failures only. A middleware reports each failed attempt (`final: false`); the catch sites report a call that ended without an answer (`final: true`). Criterion 4 counts `ok: false, final: true`; recovered retries = failed attempts − final failures, per service (a warning). Open Library and search have no retries: each logical call reports once, `final: true`.
- A failed page read (`research.fetch` with `ok: false`) on a host under `openlibrary.org` counts as an Open Library failure for criterion 4. Other hosts only count toward the refusal rate.
- A model answer that fails its schema is not a service failure (the call completed); only provider errors (`providerError(error) !== null`) and timeouts are.
- The model middleware wraps the three draft models only when `log.onService` is set (admin debug and the eval), so ordinary drafts are untouched.

## Review Focus

1. A draft that throws mid-stream must still produce a saved record: an `error` event, criterion 4 failed, criteria 2, 3 and 6 failed with "Week 1 not drafted", and the round goes on to its next run. → Task 4, Task 6.
2. A chapter reserved as `{ id: "M1", chapter: 3 }` in one week and as `{ id: "M1.3" }` in another is one overlap, not two different resources. → Task 5.
3. A topic with no SDE labels gets criteria 1 and 2 as "not applicable", never failed. → Task 5.
4. Saved files never contain the values of `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY` or `OPEN_LIBRARY_CONTACT`, even when a prompt or error message carried one. → Task 4.
5. `--rescore` on a folder with a missing or unreadable file reports that run as unscorable and still writes the summary for the rest. → Task 6.

---

### Task 1: The `service` event and where it travels

**Files:**
- Create: `lib/ai/serviceEvents.ts`, `lib/ai/serviceEvents.test.ts`
- Modify: `lib/ai/logged.ts` (`GenerationLogMeta`), `lib/ai/callEvents.ts`, `lib/ai/callEvents.test.ts`

**Interfaces:**
- Produces:
  - `type ServiceName = "anthropic" | "openlibrary" | "search"`
  - `interface ServiceEvent { type: "service"; name: ServiceName; ok: boolean; final: boolean; ms: number; status?: number; reason?: string; where?: string }`
  - `type OnServiceEvent = (event: ServiceEvent) => void`; `GenerationLogMeta.onService?: OnServiceEvent`
  - `reportingModel(model: AiModelId | LanguageModel, onService: OnServiceEvent): LanguageModel` — `wrapLanguageModel` over the model (a gateway id string becomes `gateway(id)`); `wrapGenerate` and `wrapStream` time each attempt and, when it throws, report `{ name: "anthropic", ok: false, final: false, status, reason }` and rethrow. The wrapped model keeps the inner `modelId`.
  - `reportServiceFailure(log: GenerationLogContext | undefined, error: unknown, where: string): void` — reports `{ name: "anthropic", ok: false, final: true, status, reason, where }` when `providerError(error)` is non-null or the error is a timeout; otherwise nothing.
  - `withCallEvents` also interleaves `ServiceEvent`s into the stream, in order, when enabled (same queue as calls); its return type widens to `T | CallEvent | ServiceEvent`.

- [ ] **Step 1: Write the failing tests** in `lib/ai/serviceEvents.test.ts`:
  - `"reports a failed attempt and rethrows; a successful attempt reports nothing"`: a `MockLanguageModelV4` whose first `doGenerate` throws an `APICallError` (status 529) and second succeeds, wrapped by `reportingModel`, called via `generateText({ maxRetries: 1 })` → resolves; `onService` called once with `{ type: "service", name: "anthropic", ok: false, final: false, status: 529 }` (plus `ms`).
  - `"keeps the inner model id"`: `reportingModel("anthropic/claude-sonnet-5.5", fn).modelId === "anthropic/claude-sonnet-5.5"`.
  - `"reports a final failure only for a provider error or a timeout"`: `reportServiceFailure(log, apiError(400), "structure")` → one event `{ ok: false, final: true, status: 400, where: "structure" }`; a `TypeValidationError` → none; `new DOMException("x", "TimeoutError")` → one event without status; `log` undefined → no throw.
  - In `lib/ai/callEvents.test.ts`: `"streams service events in order beside call events when enabled, and none when disabled"`.
- [ ] **Step 2: Run** `npx vitest run lib/ai/serviceEvents.test.ts lib/ai/callEvents.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same tests, then `npx vitest run`, `npx tsc --noEmit` — expect PASS, no type errors.
- [ ] **Step 5: Commit** `feat(eval): a service event for calls to Anthropic, Open Library and search`.

### Task 2: Every service reports

**Files:**
- Modify: `lib/ai/research/verify.ts` (`createOpenLibraryLookup`), `lib/ai/research/pipeline.ts:236`, `lib/ai/research/vet.ts:30`, `lib/ai/research/tools.ts` (`createResearchTools`, new `reportingSearch`), `lib/ai/research/structureFinder.ts` (search tool, failure catch), and the catch sites: `lib/ai/research/itemFinder.ts:384`, `lib/ai/research/workers.ts:302`, `lib/ai/research/agent.ts:545`, `lib/ai/research/pipeline.ts:250` and `:292`, `lib/ai/research/structureFinder.ts:417` and `:538`, `lib/ai/allocate.ts:726`, `lib/ai/planDraft.ts:379` and `:478`.
- Test: `lib/ai/research/verify.test.ts`, `lib/ai/research/tools.test.ts`, `lib/ai/research/structureFinder.test.ts`

**Interfaces:**
- Consumes: Task 1's `ServiceEvent`, `OnServiceEvent`, `reportServiceFailure`.
- Produces:
  - `createOpenLibraryLookup(fetchImpl, options: { contact?; pace?; onService?: OnServiceEvent })` — each search and each editions request reports once, `name: "openlibrary"`, `final: true`; `ok: false` for a thrown fetch or a non-2xx status (with `status`), `ok: true` otherwise, including no match.
  - `reportingSearch(provider: SearchProvider, onService: OnServiceEvent | undefined): SearchProvider` — each `search` reports once, `name: "search"`, `final: true`; zero results is `ok: true`. `createResearchTools` and the structure finder wrap their provider with it from `log?.onService`.
  - Each listed catch site calls `reportServiceFailure(log, error, "<site>")` where `<site>` is a short name (`"items"`, `"worker"`, `"candidates"`, `"arm"`, `"structure"`, `"allocate"`, `"outline retry"`, `"outline level"`).

- [ ] **Step 1: Write the failing tests:**
  - verify.test: `"reports each Open Library request: a refused connection as a failure, no match as a success"` — `fetchImpl` rejecting with `TypeError("fetch failed")` → `{ name: "openlibrary", ok: false, final: true }`; a 503 → `ok: false, status: 503`; `{ docs: [] }` → `ok: true` for each of the two searches.
  - tools.test: `"reports each search: an error as a failure, no results as a success"`.
  - structureFinder.test: `"reports a structure finder's swallowed provider failure on the app's key"` — the model throws `APICallError` 500 on the app key → the finder returns no answer (unchanged) and `onService` got `{ name: "anthropic", ok: false, final: true, where: "structure" }`.
- [ ] **Step 2: Run** the three files — expect FAIL.
- [ ] **Step 3: Implement**; pass `log?.onService` into the lookup in `pipeline.ts` and `vet.ts`.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `npx eslint` on the changed files — expect PASS.
- [ ] **Step 5: Commit** `feat(eval): Open Library, search and swallowed model failures report service events`.

### Task 3: One draft input for the route and the eval

**Files:**
- Create: `lib/ai/draftRequest.ts`, `lib/ai/draftRequest.test.ts`
- Modify: `app/api/plan/draft/route.ts`

**Interfaces:**
- Consumes: Task 1's `reportingModel`.
- Produces: `researchedDraftInput(args: { request: DraftRequestBody; models: ResolvedModels; deadline: number; signal?: AbortSignal; log: GenerationLogContext; env?: Record<string, string | undefined> }): StreamResearchedDraftInput` — exactly what the route builds today (arm and structure finder on `models.research.model`, `outlineModel`, `allocateModel`, `hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK`, empty instructions as undefined, signal, deadline, log). When `log.onService` is set, the research, outline and allocate models are wrapped with `reportingModel`. `DraftRequestBody` is the route's parsed body type, exported from this module (move `bodySchema` here).

- [ ] **Step 1: Write the failing tests:** `"builds the route's draft input"` (fields above, `hoursPerWeek` defaulted to `DEFAULT_HOURS_PER_WEEK`, `instructions: ""` → undefined, `arm` and `research.structure` present); `"wraps the models only when the log reports services"` (without `onService` the outline model is the resolved one unchanged; with it, its `.model` is an object whose `modelId` equals the resolved id).
- [ ] **Step 2: Run** `npx vitest run lib/ai/draftRequest.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**, and make the route call `researchedDraftInput` inside `guardUserKey`, nothing else changed.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit` — expect PASS.
- [ ] **Step 5: Commit** `refactor(draft): the route's draft input in one shared builder`.

### Task 4: Topics and the run record

**Files:**
- Create: `evals/draft/topics.ts`, `evals/draft/record.ts`, `evals/draft/record.test.ts`

**Interfaces:**
- Produces:
  - `interface DraftTopic { id: string; request: DraftRequestBody; labels?: { backbones?: { title: string; author: string }[]; practiceNames?: string[]; expectedBooks?: string[] } }`; `DRAFT_TOPICS: Record<string, DraftTopic>` with `sde`: the Global Constraints inputs; `backbones` DDIA (Martin Kleppmann) and *System Design Interview* (Alex Xu); `practiceNames` `["neetcode", "leetcode", "blind 75"]`; `expectedBooks` DDIA, *System Design Interview*, *Cracking the Coding Interview*.
  - `interface RunRecord { meta: { topic: string; run: number; startedAt: string; commit: string; key: "app" | "user"; models: Record<string, string>; ms: number; costUsd: number; costByStage: Record<string, number> }; events: TimedEvent[]; calls: ModelCall[]; materials: { verified: Extract<ResearchEvent, { type: "research.verified" }>[]; allocated: Material[] | null; dropped: DroppedMaterial[]; coverage: Coverage | null }; split: PlanSplit | null; plan: PlanNode | null }` where `TimedEvent = (PlanDraftEvent | ServiceEvent | { type: "error"; message: string }) & { t: number }`.
  - `captureRun(stream: AsyncIterable<PlanDraftEvent>, meta): Promise<RunRecord>` — consumes the stream, timestamps events, appends `{ type: "error" }` when it throws (never rethrows), fills materials/split/plan from `allocated`, `split`, `research.*` and `finish` events.
  - `writeRun(dir: string, record: RunRecord): void` → `run.json` (meta), `events.ndjson`, `calls.json`, `materials.json`, `plan.json`; `readRun(dir: string): RunRecord` (throws a clear `Error` naming the missing file).
  - `scrubSecrets(text: string, env?: Record<string, string | undefined>): string` — replaces the values of `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `OPEN_LIBRARY_CONTACT` with `[redacted]`; `writeRun` passes every file through it.

- [ ] **Step 1: Write the failing tests:** `"captures a stream into a record, materials and plan included"`; `"records a stream that throws as an error event and returns"`; `"writes and reads a run folder back unchanged"` (to a temp dir); `"never writes a key or the contact"` (env values present in a call prompt and an error message → absent from every written file); `"names the missing file when a folder is incomplete"`.
- [ ] **Step 2: Run** `npx vitest run evals/draft/record.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit` — expect PASS.
- [ ] **Step 5: Commit** `feat(eval): draft topics and the saved run record`.

### Task 5: The checks

**Files:**
- Create: `evals/draft/checks.ts`, `evals/draft/checks.test.ts`

**Interfaces:**
- Consumes: Task 4's `RunRecord`, `DraftTopic`.
- Produces:
  - `type Verdict = { id: 1 | 2 | 3 | 4 | 5 | 6; name: string; status: "pass" | "fail" | "n/a"; evidence: string[] }`
  - `interface Warning { kind: "expected-books" | "drop-reasons" | "refusal-rate" | "sizes" | "cost-time" | "retries"; text: string }`
  - `checkRun(record: RunRecord, topic: DraftTopic): { verdicts: Verdict[]; warnings: Warning[]; passed: boolean }` — `passed` when no verdict is `"fail"`.
  - `resourceKey(ref: { id: string; chapter?: number | null }): string` — `M1` + chapter 3 and `M1.3` give the same key.
  - Criteria exactly as the spec's table and rulings above; Week 1 = the first week node's day children; when absent, criteria 2, 3 and 6 fail with evidence `"Week 1 not drafted"`; criteria 1–2 are `"n/a"` without labels.

- [ ] **Step 1: Write the failing tests**, one `describe` per criterion, each with a passing and a failing hand-built record (a small helper builds records):
  - C1: backbone *System Design Interview – An Insider's Guide* by Alex Xu → pass; *Cracking the Coding Interview* → fail with its title in evidence; no labels → n/a.
  - C2: a NeetCode list read from a fetched URL with Week 1 days naming 3 of its items → pass; days with counts only ("problems 1–4") → fail; a list whose URL was never fetched → fail; an item named on two days → fail.
  - C3: an allocated material no week reserves → fail naming it; `{id:"M1",chapter:3}` in Week 2 and `{id:"M1.3"}` in Week 4 → fail with one overlap; a whole course in Weeks 2–3 → pass; generated practice in every week → pass; a Week 1 day reading `M5.2` when Week 1 covers `M5` whole → pass.
  - C4: a final Anthropic failure → fail; failed attempts with no final failure → pass plus a `retries` warning; a failed `research.fetch` on `openlibrary.org` → fail; a 403 on `www.oreilly.com` → pass, counted in `refusal-rate`; an `error` event → fail.
  - C5: a picked `problem-set` with no serving material → fail; served at 1% of an 18% share → fail; `recall` (generated) unserved → pass.
  - C6: days of 70, 75, 60, 80, 72 min → pass; a 40-minute day → fail; `"parts M9.1–M9.10"` in a summary → fail; `M2.1` read on Days 2 and 3 → fail.
  - Warnings: two expected books of three → none; one → `expected-books`; reading rows of 1 min → `sizes`; `$2.10` → `cost-time`.
- [ ] **Step 2: Run** `npx vitest run evals/draft/checks.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**; criterion 2's "LeetCode/NeetCode" match is case-insensitive on the material title, URL, list URL and item URLs against `labels.practiceNames`; title matches for C1 and expected books normalise case, punctuation, subtitles and "volume/vol." the way `verify.ts` matching does.
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit` — expect PASS.
- [ ] **Step 5: Commit** `feat(eval): code checks for the draft criteria and warnings`.

### Task 6: Reports and the command

**Files:**
- Create: `evals/draft/report.ts`, `evals/draft/report.test.ts`, `evals/draft/run.ts`, `evals/draft/README.md`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `renderRunReport(record: RunRecord, result: ReturnType<typeof checkRun>): string` — markdown: header (topic, run, commit, key, time, cost by stage), one line per verdict with its evidence, warnings.
  - `renderSummary(rows: { dir: string; result: ReturnType<typeof checkRun> | null; error?: string; meta?: RunRecord["meta"] }[]): string` — pass counts per criterion ("2/3"), unscorable runs with their error, warning counts, median time and cost.
  - `run.ts` CLI: `--topic <id>` (required), `--runs N` (default 3), `--parallel 1|2` (default 1), `--key app|user` (default app; `user` needs `EVAL_USER_ID`), `--rescore <dir…>`. Loads `.env.local`; resolves models with `resolveModels(EVAL_USER_ID)` for `user`, the app defaults otherwise; builds input with `researchedDraftInput` (deadline `Date.now() + DRAFT_BUDGET_MS`, a log with `onCall` and `onService` and no `onLog`); on `user` wraps in `guardUserKey(…, { userId, models, record: async () => {}, clear: async () => {} })`; captures, writes `report.md`, prints one line per run (`run 1: pass 5/6 · 212 s · $1.31`) and writes `draft-<ts>-<topic>-summary.md`. `--rescore` reads each folder, re-checks, rewrites its `report.md`, writes a new summary; no calls.
  - README: how to run, flags, what each file holds, the six criteria in one line each.

- [ ] **Step 1: Write the failing tests:** `"renders a run report with every verdict and its evidence"`; `"summarises pass counts per criterion and lists an unscorable run"`; `"re-scores saved folders without calls"` (a fixture folder written by Task 4's `writeRun` in a temp dir; a second folder missing `plan.json` → listed as unscorable; the summary still written).
- [ ] **Step 2: Run** `npx vitest run evals/draft` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `npx eslint evals/draft lib/ai` — expect PASS.
- [ ] **Step 5: Commit** `feat(eval): draft eval command, reports and re-scoring`.

### Task 7: First real run

- [ ] **Step 1:** `npx tsx evals/draft/run.ts --topic sde --runs 1` (app key; about $1.3, 3–4 minutes). Expected: one folder under `evals/results/`, a printed verdict line, `report.md` with six verdicts.
- [ ] **Step 2:** Read `report.md` against `events.ndjson`: each verdict's evidence must point at real events (spot-check criterion 2's items and criterion 4's service events). A wrong verdict is a check bug: fix it in Task 5's code with a test from this record's shape, then `--rescore` the folder.
- [ ] **Step 3:** Commit any fix; record the run's verdicts, time and cost in the ledger.
