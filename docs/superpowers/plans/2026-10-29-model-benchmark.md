# Model Benchmark (framework + allocate task) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `benchmarks/` framework that scores gateway models against the Anthropic baseline on one stage at a time,
with the `allocate` task as its first task, proven on the `sde` topic.

**Architecture:** Pure modules (scoring, statistics, criteria) under `benchmarks/`, tested with vitest; one task module
that calls the app's own `allocatePlan` on frozen fixtures captured from draft-eval runs; a judge module with a file
cache; a CLI that runs, re-scores and calibrates. One app change makes reasoning effort reach non-Anthropic models.

**Tech Stack:** TypeScript, AI SDK 7 (`ai`, `@ai-sdk/gateway`), vitest, `npx tsx` for the CLI.

**Spec:** `docs/superpowers/specs/2026-10-29-model-benchmark-design.md`

**Scope of this plan:** the framework, provider parity and the `allocate` task. `outline`, `research` and `draft` tasks
are later plans that reuse everything here; nothing in this plan builds them.

## Global Constraints

- Every contestant and judge call goes through the app's gateway key (`appModel(id)`); the benchmark never reads or
  writes the database. *(Spec: "Always on the app's gateway key. No database reads or writes.")*
- Import `evals/draft/env.ts` first in the CLI, as `evals/draft/run.ts` does.
- Every saved file passes through `scrubSecrets` from `evals/draft/record.ts`.
- `benchmarks/results/` and `benchmarks/cache/` are gitignored; `benchmarks/fixtures/` and `benchmarks/calibration/`
  are committed.
- Contestant and judge models must be ids in `AVAILABLE_MODELS` (`lib/ai/models.ts`), so every call has a price.
- Cost of a call is its `ModelCall.costUsd` (the app's `estimateCostUsd`).
- Weights are integers from −10 to +10. Sample score = Σ weights of met criteria ÷ Σ positive weights of applicable
  criteria; it may be negative; a sample that failed the gate scores 0.
- Defaults: `--epochs 3`, `--max-usd 10`, `--margin 0.05`, concurrency 4 for `allocate`, `pass^k` with k = 3 and a
  sample counted as passing when its gate completed and its score ≥ 0.7.
- Judge: `anthropic/claude-opus-5.5` at `high`. Second judge: `openai/gpt-5.4` at `high`, on every fifth sample of
  each contestant in (fixture, epoch) order, starting with the first.
- A judge criterion is **checked** once the owner graded it on ≥ 10 calibration items and the judge agreed on ≥ 8;
  otherwise every judged number shows the label `unchecked`.
- Verdicts: **qualifies** when Δ's 95% low end > −margin, completion ≥ 0.95, cost per sample < baseline's, and the
  contestant is not judge-dependent; **worse** when Δ's high end < −margin or completion < 0.90; else **inconclusive**.
  The baseline's own verdict is `baseline`.
- Allocation's time limit in the benchmark is `ALLOCATE_TIMEOUT_MS` (90 000 ms, `lib/ai/planDraft.ts`).

## Review Focus

1. A contestant naming a model not in `AVAILABLE_MODELS`: the CLI refuses before any call, naming the model (Task 4).
2. A draft-eval folder with no `research.done` event, or one with no materials (a run that died in research):
   capture refuses with the folder named and writes nothing (Task 6).
3. A judge answer that omits a criterion or invents an id: invented ids are ignored, an omitted criterion is not met
   with the evidence `judge gave no verdict` (Task 8).
4. The cap reached mid-run: no new sample starts, finished samples are saved and summarized, unjudged ones are marked
   so `--rescore` can judge them later (Task 12).
5. A contestant whose samples all failed the gate or went void: its row shows completion 0 (or `n/a` when all void),
   no `NaN`, and the verdict `worse` or `inconclusive` (Task 5 and Task 11).

---

### Task 1: Reasoning effort reaches every provider

The app sends effort only as `providerOptions.anthropic.effort`, which Gemini and GPT ignore. AI SDK 7 has a portable
top-level `reasoning` call setting (`node_modules/ai/docs/03-ai-sdk-core/26-reasoning.mdx`) that `generateObject`,
`streamObject` and `ToolLoopAgent` accept. Anthropic models keep exactly what they get today; other models get
`reasoning`.

**Files:**
- Modify: `lib/ai/logged.ts` (replace `effortOptions`)
- Modify: `lib/ai/planDraft.ts:184`, `lib/ai/research/agent.ts:313`, `lib/ai/research/structureFinder.ts:46-50,477,483`
- Test: `lib/ai/logged.test.ts`, `lib/ai/research/structureFinder.test.ts`

**Interfaces:**
- Produces: `effortSettings(effort: ReasoningEffort, model: AiModelId | LanguageModel): { providerOptions: { anthropic: { effort: ReasoningEffort } } } | { reasoning: ReasoningEffort }`
- Produces: `isAnthropicModel(model: AiModelId | LanguageModel): boolean` — true when the id (a string, or an
  instance's `modelId`) starts with `anthropic/` or `claude-`.
- Changes: `answerStepOptions(effort, modelId)` returns `undefined` for a non-Anthropic model.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/ai/logged.test.ts
it("sends Anthropic models their effort as a provider option, as before", () => {
  expect(effortSettings("high", "anthropic/claude-opus-5.5")).toEqual({ providerOptions: { anthropic: { effort: "high" } } });
});
it("sends other providers the portable reasoning setting", () => {
  expect(effortSettings("medium", "google/gemini-3-flash")).toEqual({ reasoning: "medium" });
  expect(effortSettings("high", "openai/gpt-5.4-mini")).toEqual({ reasoning: "high" });
});
it("treats a direct Anthropic instance (a user's key) as Anthropic", () => {
  const instance = { modelId: "claude-sonnet-5-5", provider: "anthropic.messages" } as unknown as LanguageModel;
  expect(effortSettings("low", instance)).toEqual({ providerOptions: { anthropic: { effort: "low" } } });
});
it("records the effort on the log row whatever the provider", async () => {
  // existing loggedGenerateObject test pattern with a mocked generateObject: call with model "openai/gpt-5.4",
  // effort "high"; expect the mock to have received { reasoning: "high" } and no providerOptions, and the row effort "high".
});

// lib/ai/research/structureFinder.test.ts
it("sends no Anthropic options on the forced step for other providers", () => {
  expect(answerStepOptions("medium", "google/gemini-3-flash")).toBeUndefined();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run lib/ai/logged.test.ts lib/ai/research/structureFinder.test.ts`
Expected: FAIL, `effortSettings is not exported`.

- [ ] **Step 3: Implement**

`effortSettings` and `isAnthropicModel` in `lib/ai/logged.ts`; remove `effortOptions`. Each call site spreads the
result in place of `providerOptions: effortOptions(...)`, passing the gateway id in scope (`opts.model` in
`loggedGenerateObject`, `input.model.id` in `streamUnits`, the model passed to the agent in `agent.ts` and
`structureFinder.ts`). `answerStepOptions` builds from `effortSettings` for Anthropic models and keeps its
`NARROWS_FORCED_TOOL` branch unchanged.

- [ ] **Step 4: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass; existing Anthropic tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/ai
git commit -m "fix(ai): reasoning effort reaches non-Anthropic models through the portable setting"
```

### Task 2: `allocatePlan` takes an effort and says when it fell back

**Files:**
- Modify: `lib/ai/allocate.ts:688-735`
- Test: `lib/ai/allocate.test.ts`

**Interfaces:**
- Changes: `allocatePlan(input: AllocationInput & { model; log?; signal?; timeoutMs?; effort?: ReasoningEffort })`
  returns `{ split; materials; dropped; coverage; costUsd; fallback: boolean }`. `effort` defaults to
  `ALLOCATE_EFFORT`. `fallback` is true on both fallback paths (too little time, failed call).

- [ ] **Step 1: Write the failing tests** — in the file's existing mocked-call style:
  `it("runs at the effort it is given")` expects the mocked `loggedGenerateObject` to receive `effort: "medium"`;
  `it("says it fell back when the call fails")` expects `fallback: true`; `it("says it did not fall back on a usable answer")` expects `fallback: false`; `it("says it fell back with too little time")` with `timeoutMs: 1000` expects `fallback: true`.
- [ ] **Step 2: Run** `npx vitest run lib/ai/allocate.test.ts` — Expected: FAIL on `fallback` undefined.
- [ ] **Step 3: Implement** the two fields; `streamPlanDraft` ignores `fallback`.
- [ ] **Step 4: Run** `npx vitest run lib/ai && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(allocate): take an effort and report a fallback"`

### Task 3: The eval's matching helpers become shareable

**Files:**
- Modify: `evals/draft/checks.ts` (export helpers; extract the practice-time logic)
- Test: `evals/draft/checks.test.ts`

**Interfaces:**
- Produces (exported, unchanged behaviour): `titleMatches(label, title)`, `bookMatches(label, m: Material)`,
  `authorMatches(label, author: string | null)`, `isNamedList(m: Material, names: string[])`,
  `servedMinutes(materials: Material[], format: PracticeFormat)`.
- Produces: `practiceTimeFindings(split: PlanSplit, materials: Material[], request: { weeks: number; hoursPerWeek?: number }): { unserved: string[]; short: string[]; notes: string[] }` —
  `unserved`: picked formats with `generated === "never"` and no serving material; `short`: served formats under half
  their share; `notes` as today. `checkPracticeTime` becomes `verdict(5, name, [...unserved, ...short], notes)`.

- [ ] **Step 1: Write the failing test** — `practiceTimeFindings` on a split with `problem-set` 60% and one serving
  material giving 10 min of a 600-min share returns `short` with one entry and empty `unserved`; with no serving
  material returns one `unserved` entry.
- [ ] **Step 2: Run** `npx vitest run evals/draft/checks.test.ts` — Expected: FAIL, not exported.
- [ ] **Step 3: Implement** the export and extraction.
- [ ] **Step 4: Run** `npx vitest run evals/draft` — Expected: all existing check tests still pass.
- [ ] **Step 5: Commit** `git commit -am "refactor(eval): share the matching helpers and practice-time findings"`

### Task 4: Benchmark types, contestants and the score formula

**Files:**
- Create: `benchmarks/types.ts`, `benchmarks/contestants.ts`, `benchmarks/score.ts`
- Test: `benchmarks/score.test.ts`, `benchmarks/contestants.test.ts`

**Interfaces:**
- Produces in `types.ts`:

```ts
export type Role = "allocate" | "outline" | "research";
export interface RoleModel { model: AiModelId; effort: ReasoningEffort }
export interface Contestant { name: string; roles: Partial<Record<Role, RoleModel>> }
export type Group = "materials" | "structure" | "practice" | "quality";
interface CriterionBase { id: string; group: Group; weight: number; text: string }
export interface CodeCriterion<O, C> extends CriterionBase {
  grader: "code";
  applies?: (ctx: C) => boolean;
  check: (output: O, ctx: C) => { met: boolean; evidence: string };
}
export interface JudgeCriterion extends CriterionBase { grader: "judge"; dimension: string }
export type Criterion<O, C> = CodeCriterion<O, C> | JudgeCriterion;
export interface CriterionResult { id: string; met: boolean; evidence: string; grader: "code" | "judge"; judge?: AiModelId }
export type Gate = { status: "completed" } | { status: "failed"; reason: string } | { status: "void"; reason: string };
export interface Sample<O = unknown> {
  task: string; fixture: string; contestant: string; epoch: number;
  gate: Gate; output: O | null; calls: ModelCall[]; costUsd: number; ms: number;
  results: CriterionResult[];          // code results always; judge results once judged
  judged: boolean;                     // false when the cap stopped judging
  secondJudge?: CriterionResult[];     // only on the second judge's samples
}
```

- Produces in `contestants.ts`: `BASELINE: Contestant` (name `baseline`, allocate = `DEFAULT_ALLOCATE_MODEL` at
  `ALLOCATE_EFFORT`, outline and research likewise from `lib/ai/models.ts`); `CONTESTANTS: Record<string, Contestant>`
  with `baseline`, `sonnet-5.5`, `haiku-4.5`, `gemini-3-flash`, `gemini-3.1-pro`, `gpt-5.4-mini`, `gpt-5.4`, each
  giving its model to every role at the baseline's effort for that role; `contestantsFor(names: string[]): Contestant[]`
  — always puts `baseline` first, throws `Unknown contestant "<name>"; known: …` or `Model "<id>" has no price in AVAILABLE_MODELS`.
  Keeping contestants to `AVAILABLE_MODELS` is how the spec's "supports tool calls and structured output" rule is
  met: every model there does; adding one to that list is where the check happens.
- Produces in `score.ts`:
  `sampleScore(sample: Pick<Sample, "gate" | "results">, criteria: CriterionBase-like[], filter?: (c) => boolean): number | null` —
  0 when the gate failed, null when void; otherwise the formula over criteria present in `results` (and passing `filter`).
  `codeOnlyScore(sample, criteria)` = `sampleScore` with `grader === "code"`.
  `groupScores(sample, criteria): Record<string, number | null>` — keys are the four groups plus
  `quality.<dimension>` for each judge dimension; null where a group has no positive weight among the results.

- [ ] **Step 1: Write the failing tests**

```ts
it("is met weight over positive weight", () => {
  // criteria a(+5) b(+3) c(−5); met: a, c → (5 − 5) / 8 = 0
  expect(sampleScore(completed([met("a"), unmet("b"), met("c")]), crit)).toBe(0);
});
it("can go below zero", () => { /* met: c only → −5 / 8 */ expect(sampleScore(completed([unmet("a"), unmet("b"), met("c")]), crit)).toBe(-0.625); });
it("scores a failed gate 0 and a void sample null", () => { /* … */ });
it("leaves out criteria that did not apply", () => { /* results lack b → a met = 5 / 5 = 1 */ });
it("scores groups and judge dimensions apart", () => { /* expect keys materials, quality.coverage, … */ });
it("puts baseline first and refuses an unknown or unpriced model", () => {
  expect(contestantsFor(["gpt-5.4-mini"]).map((c) => c.name)).toEqual(["baseline", "gpt-5.4-mini"]);
  expect(() => contestantsFor(["nope"])).toThrow('Unknown contestant "nope"');
});
```

- [ ] **Step 2: Run** `npx vitest run benchmarks` — Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** `npx vitest run benchmarks` — Expected: PASS.
- [ ] **Step 5: Commit** `git add benchmarks && git commit -m "feat(bench): types, contestants and the score formula"`

### Task 5: Statistics and the verdict

**Files:**
- Create: `benchmarks/stats.ts`
- Test: `benchmarks/stats.test.ts`

**Interfaces:**
- Produces:
  - `interface Interval { mean: number; low: number; high: number; n: number }`
  - `tCritical(df: number): number` — two-sided 95%: a table for df 1–30 (df 1 = 12.706, 2 = 4.303, 3 = 3.182,
    4 = 2.776, 5 = 2.571, 8 = 2.306, 10 = 2.228, 20 = 2.086, 30 = 2.042), 1.96 above 30.
  - `interval(values: number[]): Interval | null` — mean ± t(n−1)·sd/√n; null for no values; one value gives
    `{ mean, low: -Infinity, high: Infinity, n: 1 }`.
  - `qualityInterval(byFixture: Map<string, number[]>): (Interval & { oneFixture: boolean }) | null` — with ≥ 2
    fixtures, the interval over fixture means (clustered by fixture); with one, over its epochs.
  - `pairedDelta(contestant: Map<string, number[]>, baseline: Map<string, number[]>): (Interval & { oneFixture: boolean }) | null` —
    fixtures both have; ≥ 2: interval over per-fixture differences of means; one: difference of means with
    se = √(s₁²/n₁ + s₂²/n₂) and df = min(n₁, n₂) − 1.
  - `passHatK(byFixture: Map<string, { n: number; c: number }>, k = 3): number | null` — mean over fixtures with
    n ≥ k of C(c, k) ÷ C(n, k).
  - `verdictOf(x: { delta: Interval | null; completion: number | null; costUsd: number; baselineCostUsd: number; margin: number; judgeDependent: boolean }): "qualifies" | "worse" | "inconclusive"` — rules in Global Constraints; a null delta or completion is `inconclusive` unless completion < 0.90.
  - `paretoFrontier(points: { name: string; quality: number; costUsd: number }[]): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(interval([0.6, 0.7, 0.8])).toMatchObject({ mean: 0.7, n: 3 });
expect(interval([0.6, 0.7, 0.8])!.low).toBeCloseTo(0.4516, 3);   // 4.303 × 0.1/√3
expect(passHatK(new Map([["f1", { n: 5, c: 4 }]]))).toBeCloseTo(0.4);  // C(4,3)/C(5,3)
expect(passHatK(new Map([["f1", { n: 3, c: 2 }]]))).toBe(0);
expect(passHatK(new Map([["f1", { n: 2, c: 2 }]]))).toBeNull();
expect(verdictOf({ delta: { mean: 0, low: -0.03, high: 0.03, n: 3 }, completion: 1, costUsd: 0.1, baselineCostUsd: 0.5, margin: 0.05, judgeDependent: false })).toBe("qualifies");
expect(verdictOf({ delta: { mean: -0.2, low: -0.3, high: -0.1, n: 3 }, completion: 1, costUsd: 0.1, baselineCostUsd: 0.5, margin: 0.05, judgeDependent: false })).toBe("worse");
expect(verdictOf({ delta: { mean: 0, low: -0.03, high: 0.03, n: 3 }, completion: 0.8, costUsd: 0.1, baselineCostUsd: 0.5, margin: 0.05, judgeDependent: false })).toBe("worse");
expect(verdictOf({ delta: { mean: 0, low: -0.2, high: 0.2, n: 3 }, completion: 1, costUsd: 0.1, baselineCostUsd: 0.5, margin: 0.05, judgeDependent: false })).toBe("inconclusive");
expect(verdictOf({ delta: { mean: 0, low: -0.03, high: 0.03, n: 3 }, completion: 1, costUsd: 0.1, baselineCostUsd: 0.5, margin: 0.05, judgeDependent: true })).toBe("inconclusive");
expect(verdictOf({ delta: null, completion: 0, costUsd: 0, baselineCostUsd: 0.5, margin: 0.05, judgeDependent: false })).toBe("worse");
expect(paretoFrontier([{ name: "a", quality: 0.9, costUsd: 1 }, { name: "b", quality: 0.8, costUsd: 0.2 }, { name: "c", quality: 0.7, costUsd: 0.5 }])).toEqual(["a", "b"]);
// pairedDelta with two fixtures: contestant [0.6,0.6],[0.8,0.8] vs baseline [0.7,0.7],[0.7,0.7] → mean 0, n 2
```

- [ ] **Step 2: Run** `npx vitest run benchmarks/stats.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `benchmarks/stats.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): intervals, paired deltas, pass^k and the verdict"`

### Task 6: Fixtures from draft-eval runs

**Files:**
- Create: `benchmarks/fixtures.ts`
- Test: `benchmarks/fixtures.test.ts` (writes to a temp dir)

**Interfaces:**
- Consumes: `readRun(dir)` from `evals/draft/record.ts`.
- Produces:

```ts
export interface AllocateFixture {
  id: string;                 // "<topic>-<n>", n the next free number under the fixtures root
  topic: string;              // a DRAFT_TOPICS key
  sourceRun: string;          // basename of the eval folder
  commit: string;
  input: AllocationInput;     // request fields (hoursPerWeek defaulted with DEFAULT_HOURS_PER_WEEK) + research.done's materials
  baseline: { inputTokens: number; outputTokens: number; ms: number } | null;  // the run's "Allocate" call, null if it fell back
}
export function captureFixture(runDir: string, root?: string): AllocateFixture   // writes <root>/<id>/allocate.json; root defaults to "benchmarks/fixtures"
export function loadFixture(id: string, root?: string): AllocateFixture
```

- [ ] **Step 1: Write the failing tests** — from a hand-built record written with `writeRun` into a temp dir:
  `it("freezes research's materials as the allocation input")` checks `input.materials` equals the `research.done`
  materials and `input.hoursPerWeek` is the request's; `it("numbers fixtures per topic")` captures two folders and
  expects ids `sde-1`, `sde-2`; `it("refuses a run with no research.done")` and `it("refuses a run whose research found nothing")`
  expect a throw naming the folder and no file written; `it("refuses a folder already captured")` matches on `sourceRun`.
- [ ] **Step 2: Run** `npx vitest run benchmarks/fixtures.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `benchmarks/fixtures.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): capture allocate fixtures from draft-eval runs"`

### Task 7: The allocate task: one sample and its code criteria

**Files:**
- Create: `benchmarks/tasks/allocate.ts`
- Test: `benchmarks/tasks/allocate.test.ts`

**Interfaces:**
- Consumes: `allocatePlan` (Task 2), `AllocateFixture` (Task 6), helpers (Task 3), types (Task 4).
- Produces:

```ts
export type AllocateOutput = { split: PlanSplit; materials: Material[]; dropped: DroppedMaterial[]; coverage: Coverage | null };
export interface AllocateCtx { fixture: AllocateFixture; topic: DraftTopic | undefined }
export const ALLOCATE_CRITERIA: Criterion<AllocateOutput, AllocateCtx>[];
export function voidReason(events: ServiceEvent[]): string | null;
export function runAllocateSample(
  fixture: AllocateFixture,
  contestant: Contestant,
  deps?: { allocate?: typeof allocatePlan },
): Promise<Pick<Sample<AllocateOutput>, "gate" | "output" | "calls" | "costUsd" | "ms">>;
export function codeResults(output: AllocateOutput, ctx: AllocateCtx): CriterionResult[];  // applicable code criteria only
```

- The code criteria, first draft for the owner's review (ids, group, weight, met when):

| id | group | w | met when |
|---|---|---|---|
| `backbone-labelled` | materials | +5 | a kept material with `backbone` matches a label by `bookMatches` and `authorMatches` (applies when the topic has backbone labels) |
| `backbone-chosen` | materials | +2 | some kept material has `backbone: true` |
| `expected-books` | materials | +2 | ≥ 2 of the label's expected books are kept, by `titleMatches` (applies with labels) |
| `learner-dropped` | materials | −10 | met when an `origin: "learner"` input material is missing from the kept list (applies when the input has one) |
| `named-list-kept` | practice | +5 | a kept material `isNamedList(labels.practiceNames)` and has `practice.list.items.length > 0` (applies with labels) |
| `formats-served` | practice | +3 | `practiceTimeFindings(...).unserved` is empty |
| `format-minutes` | practice | +4 | `practiceTimeFindings(...).short` is empty |
| `fits-hours` | structure | +3 | kept reading minutes ≤ 1.2 × plan minutes × `readingShare` ÷ 100 (reading = materials that are not practice-only, `isPracticeOnly`) |
| `overfull` | structure | −5 | met when kept reading minutes > 1.5 × all plan minutes |
| `coverage-stated` | structure | +1 | `coverage` has at least one covered area |

- Gate: `fallback: false` → completed. `fallback: true` → void with the reason when `voidReason(serviceEvents)` gives
  one, else failed `"fallback: <last service reason or 'no time'>"`. `voidReason` returns a reason for a final
  service event with status ≥ 500, status 429, or no status and a reason that is not a timeout; null otherwise.
- `runAllocateSample` calls `allocate` with the fixture's input, `model: appModel(roleModel.model)`,
  `effort: roleModel.effort`, `timeoutMs: ALLOCATE_TIMEOUT_MS`, and a log whose `onCall` and `onService` collect calls
  and service events; `roleModel` is `contestant.roles.allocate ?? BASELINE.roles.allocate`.

- [ ] **Step 1: Write the failing tests** — with an injected `allocate`:
  `it("completes on the model's own allocation")`; `it("fails the gate on a fallback with no outside cause")`;
  `it("voids a fallback the gateway caused (503)")`; `it("does not void our own timeout")`;
  `it("passes the contestant's model and effort, and the app's time limit")` (expects `effort: "medium"`,
  `timeoutMs: 90000`, `model.id: "google/gemini-3-flash"`); one test per criterion row above on hand-built outputs,
  including `backbone-labelled` met for *Designing Data-Intensive Applications* by Martin Kleppmann and not met for an
  essay titled "System design interview questions in 2026"; `it("leaves out label criteria for a topic without labels")`.
- [ ] **Step 2: Run** `npx vitest run benchmarks/tasks` — Expected: FAIL.
- [ ] **Step 3: Implement** `benchmarks/tasks/allocate.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): the allocate task, its gate and code criteria"`

### Task 8: The judge, its criteria for allocate, and its cache

**Files:**
- Create: `benchmarks/judge.ts`
- Modify: `benchmarks/tasks/allocate.ts` (add judge criteria and `renderAllocation`)
- Test: `benchmarks/judge.test.ts`, `benchmarks/tasks/allocate.test.ts`

**Interfaces:**
- Produces in `judge.ts`:

```ts
export const JUDGE: RoleModel = { model: "anthropic/claude-opus-5.5", effort: "high" };
export const SECOND_JUDGE: RoleModel = { model: "openai/gpt-5.4", effort: "high" };
export interface JudgeCache { get(key: string): CriterionResult[] | undefined; set(key: string, results: CriterionResult[]): void }
export function fileJudgeCache(path?: string): JudgeCache;   // JSON lines at benchmarks/cache/judge.jsonl
export function judgeKey(rendered: string, dimension: string, criteria: JudgeCriterion[], judge: RoleModel): string;  // sha256 of all of it, criterion ids and texts included
export function judgeDimension(args: {
  rendered: string; dimension: string; criteria: JudgeCriterion[]; judge: RoleModel; cache: JudgeCache;
  generate?: typeof generateObject;   // tests inject
}): Promise<{ results: CriterionResult[]; costUsd: number; calls: ModelCall[] }>;
export function secondJudgeSamples<T extends Pick<Sample, "contestant" | "fixture" | "epoch">>(samples: T[]): Set<T>;
```

- `judgeDimension` sends one call with schema `{ verdicts: { id: string; met: boolean; reason: string }[] }`; the
  rendered output is the first content part of the user message with
  `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }`, the dimension's criteria (id, text, an
  instruction to judge each on its own and say why in one sentence) the second; effort via `effortSettings`. Cost from
  `estimateCostUsd`. A cache hit makes no call and costs 0.
- In `tasks/allocate.ts`: `renderAllocation(output: AllocateOutput, input: AllocationInput): string` — the request
  (topic, instructions, weeks, days, hours), the split (reading share, practice label, formats with shares, reason),
  the kept materials with `renderMaterials`, the dropped ones with reasons, and the coverage. Never a model name.
- Judge criteria for allocate, first draft for the owner's review (dimensions from `evals/rubric.md` 3, 5 and 6; the
  rubric's 8 needs plan leaves and belongs to `outline`):

| id | dimension | group | w | text |
|---|---|---|---|---|
| `cov-claims` | coverage | quality | +3 | The kept materials teach every area the coverage lists as covered. |
| `cov-core` | coverage | quality | +3 | The kept materials cover the topic's core areas for a learner at this level; nothing a subject expert would call essential is missing without being listed as open. |
| `cov-open-honest` | coverage | quality | +1 | Every area listed as open is really not covered by a kept material. |
| `fit-share` | fit | quality | +3 | The reading share suits the kind of topic and the learner's instructions. |
| `fit-formats` | fit | quality | +3 | The practice formats are the right kind of work for this topic. |
| `src-proportion` | fidelity | quality | +3 | Each kept material's minutes are in proportion to how much of the topic it covers. |
| `src-offtopic` | fidelity | quality | −5 | A kept material is off the topic. |
| `src-better-dropped` | fidelity | quality | −2 | A dropped material is clearly better for a purpose than the kept material that serves it. |

- [ ] **Step 1: Write the failing tests** — with an injected `generate`:
  `it("returns one result per criterion of the dimension")`; `it("ignores ids the judge invented")`;
  `it("marks a criterion the judge skipped as not met")` with evidence `judge gave no verdict`;
  `it("makes no call on a cache hit")`; `it("keys the cache on criterion text and judge")` (changing either text or
  judge model changes `judgeKey`); `it("picks every fifth sample of each contestant, the first included")` on
  9 samples per contestant → 2 each (the 1st and 6th in (fixture, epoch) order); `it("renders no model name")` checks
  `renderAllocation` output contains no contestant model id.
- [ ] **Step 2: Run** `npx vitest run benchmarks` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): judge by dimension with a cache, allocate's judge criteria"`

### Task 9: Budget estimate and the spend cap

**Files:**
- Create: `benchmarks/budget.ts`
- Test: `benchmarks/budget.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Estimate { contestantsUsd: number; judgingUsd: number; totalUsd: number }
export function estimateAllocateRun(args: {
  fixtures: AllocateFixture[]; contestants: Contestant[]; epochs: number;
  judgeDimensions: number;               // 3 for allocate
  renderedChars: number;                 // mean rendered length; input tokens ≈ chars / 4
}): Estimate;
export function cutAdvice(estimate: Estimate, capUsd: number, run: { epochs: number; fixtures: number; contestants: number }): string;
export class SpendCap { constructor(capUsd: number); add(usd: number): void; readonly spentUsd: number; readonly reached: boolean }
```

- Contestant estimate per sample: the fixture's baseline tokens priced at the contestant's model (`estimateCostUsd`);
  a fixture with `baseline: null` uses the mean of the others. Judging per sample: `judgeDimensions` calls of
  (renderedChars ÷ 4 + 500) input and 1 500 output tokens at the judge's price, plus the second judge on
  ⌈samples per contestant ÷ 5⌉ samples per contestant.
- `cutAdvice` names the smallest single change that fits: fewer epochs, then fewer fixtures, then fewer contestants,
  e.g. `"Estimated $12.40 over the $10.00 cap. Fits with --epochs 2 ($8.30)."`

- [ ] **Step 1: Write the failing tests** — an estimate on one fixture (10 000 in, 2 000 out) for baseline Opus 5.5
  and `gpt-5.4-mini`, 3 epochs, gives contestants = 3 × (0.04 + 0.04) + 3 × (0.0075 + 0.009) = 0.2895 (to 4 places);
  `SpendCap(10)` is reached after `add(6); add(4.01)`; `cutAdvice` picks `--epochs 2` when that fits.
- [ ] **Step 2: Run** `npx vitest run benchmarks/budget.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): cost estimate, cut advice and the spend cap"`

### Task 10: Calibration

**Files:**
- Create: `benchmarks/calibration.ts`
- Test: `benchmarks/calibration.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CalibrationFile {
  task: string; judge: AiModelId; createdAt: string;
  criteria: { id: string; text: string }[];
  items: { sample: string; rendered: string; grades: { id: string; judge: boolean; owner: boolean | null }[] }[];
}
export function pickCalibration(samples: Sample[], n?: number): Sample[];   // n = 10; completed and judged only; round-robin across contestants, then fixtures
export function writeCalibration(task: string, samples: Sample[], render: (s: Sample) => string, criteria: JudgeCriterion[], dir?: string): string;  // benchmarks/calibration/<task>-<stamp>.json
export function checkedCriteria(files: CalibrationFile[], judge: AiModelId, criteria: JudgeCriterion[]): Map<string, { graded: number; agreed: number; checked: boolean }>;
```

- `checkedCriteria` counts only grades whose file's judge is `judge` and whose criterion text equals the current text;
  `checked` when graded ≥ 10 and agreed ≥ 8.

- [ ] **Step 1: Write the failing tests** — 10 owner grades with 8 agreeing → checked; 7 agreeing → not;
  null owner grades don't count; a changed criterion text resets to 0 graded; `pickCalibration` on 3 contestants ×
  9 samples returns 10 with every contestant present.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): calibration sets and the checked label"`

### Task 11: Summaries and the report

**Files:**
- Create: `benchmarks/report.ts`
- Test: `benchmarks/report.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ContestantSummary {
  name: string; models: Partial<Record<Role, RoleModel>>;
  verdict: "baseline" | "qualifies" | "worse" | "inconclusive";
  quality: (Interval & { oneFixture: boolean }) | null; codeOnly: Interval | null; delta: (Interval & { oneFixture: boolean }) | null;
  completion: number | null; passHat3: number | null; costUsd: number; p50Ms: number; p90Ms: number;
  groups: Record<string, number | null>; criteria: Record<string, { met: number; of: number }>;
  voids: number; unjudged: number; judgeDependent: boolean;
}
export function summarize(samples: Sample[], criteria: Criterion<any, any>[], contestants: Contestant[], margin: number): ContestantSummary[];
export function renderReport(args: { task: string; summaries: ContestantSummary[]; samples: Sample[]; criteria: Criterion<any, any>[]; checked: Map<string, { graded: number; agreed: number; checked: boolean }>; run: { commit: string; fixtures: string[]; epochs: number; capUsd: number; spentUsd: number; judge: RoleModel; secondJudge: RoleModel } }): string;
export function renderChart(summaries: ContestantSummary[]): string;   // SVG: x cost per sample, y quality, frontier joined by a line
```

- `summarize`: void samples are left out of everything but `voids`; `completion` = completed ÷ non-void (null when
  all void); quality, Δ, groups from `score.ts`/`stats.ts`; `judgeDependent` per Global Constraints' second-judge rule:
  on double-judged samples, judge-only Δ against the baseline under each judge; dependent when the signs differ and
  the two Δs are more than `margin` apart. Unjudged samples count in code-only scores, not in quality.
- `renderReport` writes the five sections of the spec's "What the report shows" in that order, each judged number
  followed by ` (unchecked)` when any judge criterion behind it is not checked; links each sample file; embeds
  `![Score vs cost](chart.svg)`; notes `one fixture: the interval measures run-to-run spread only` when
  `oneFixture`; lists voids with reasons and judge disagreements.

- [ ] **Step 1: Write the failing tests** — `summarize` on hand-built samples: a contestant with all samples failed has
  completion 0 and verdict `worse`; all void → completion null, verdict `inconclusive`, no `NaN` anywhere in
  `JSON.stringify`; the baseline's verdict is `baseline`. `renderReport` contains `(unchecked)` when no calibration,
  not when every judge criterion is checked; lists met-harm criteria before the others in section 3.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): summaries, verdicts and the report"`

### Task 12: The command, rescore and the first real run

**Files:**
- Create: `benchmarks/run.ts`, `benchmarks/README.md`
- Modify: `.gitignore` (add `/benchmarks/results/` and `/benchmarks/cache/`)
- Test: `benchmarks/run.test.ts`

**Interfaces:**
- Consumes: everything above; `mapLimit` from `evals/draft/run.ts`; `scrubSecrets`.
- Produces: `runBenchmark(opts: { task: "allocate"; fixtures: string[]; contestants: string[]; epochs: number; maxUsd: number; margin: number; outDir?: string; now?: string; runSample?: typeof runAllocateSample; judge?: typeof judgeDimension; print?: (l: string) => void }): Promise<{ dir: string; summaries: ContestantSummary[] }>`,
  `rescoreBenchmark(dir: string, deps?): Promise<...>`, `calibrateBenchmark(dir: string): string`, and `main()` with the
  flags of the spec's "Running it": `--capture <dir…>`, `--task allocate`, `--fixtures a,b`, `--contestants a,b`,
  `--epochs`, `--max-usd`, `--margin`, `--rescore <dir>`, `--calibrate <dir>`.
- Order inside `runBenchmark`: resolve contestants (throws before any call), load fixtures, estimate, refuse with
  `cutAdvice` over the cap, run samples (concurrency 4) while `SpendCap` is not reached, judge each completed sample
  (three dimensions with `JUDGE`, plus `SECOND_JUDGE` on its samples) while the cap allows, mark the rest
  `judged: false`, then write `benchmarks/results/<stamp>-allocate/` = `run.json`, `samples/<contestant>-<fixture>-<epoch>.json`,
  `scores.json`, `report.md`, `chart.svg`. Prints one line per sample (`gpt-5.4-mini sde-1 #2: 0.72 · 14 s · $0.03`)
  and the report path.
- `rescoreBenchmark` recomputes code results from saved outputs and current criteria, judges what the cache lacks
  (within `--max-usd`), and rewrites `scores.json`, `report.md` and `chart.svg`.

- [ ] **Step 1: Write the failing tests** — with injected `runSample` and `judge`:
  `it("refuses over the cap before any call")`; `it("stops starting samples once the cap is reached and marks the rest unjudged")`
  (cap $1, each sample $0.30 → 4 samples started at most, report written); `it("writes the run folder and a report")`;
  `it("rescore judges only what the cache lacks")`; `it("refuses an unknown contestant before any call")`.
- [ ] **Step 2: Run** `npx vitest run benchmarks/run.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `run.ts`, the README (what a benchmark is next to the eval, the commands, the output
  files, how to grade a calibration file), and the `.gitignore` lines.
- [ ] **Step 4: Run the suite and the type check** `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(bench): the benchmark command, rescore and calibration"`
- [ ] **Step 6: Capture fixtures from real eval runs** — the owner's spend; ask before running.
  `npx tsx evals/draft/run.ts --topic sde --runs 3` (about $1–2 a run), then
  `npx tsx benchmarks/run.ts --capture evals/results/draft-<ts>-sde-1 evals/results/draft-<ts>-sde-2 evals/results/draft-<ts>-sde-3`.
  Expected: `benchmarks/fixtures/sde-1..3/allocate.json`, each with materials and a baseline token count. Commit them.
- [ ] **Step 7: First benchmark run** — ask before running.
  `npx tsx benchmarks/run.ts --task allocate --fixtures sde-1,sde-2,sde-3 --contestants baseline,gemini-3-flash,gpt-5.4-mini`
  Expected: either a refusal with cut advice (then rerun with what it suggests) or a report under
  `benchmarks/results/` with three rows, every judged number marked `(unchecked)`. Read the report and two sample
  files by hand to confirm criteria and judge reasons make sense before reporting results.
