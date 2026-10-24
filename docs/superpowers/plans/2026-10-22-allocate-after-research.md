# Allocate After Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the before-research practice pick with an after-research allocation call (Opus 5.5) that chooses each material's part and the plan's split, and make drafting follow it.

**Architecture:** Research no longer receives a split: the practice researcher chooses the kinds of practice and the candidates step lists materials at whole size. A new `lib/ai/allocate.ts` asks the `allocate` model role to choose parts and practice shares; pure code applies the parts to the materials and derives the reading share from them. `streamPlanDraft` allocates when no split is given, emits the allocated materials and split, then drafts as today. Checks fold no-source picks into reading at every level (S1), budget block formats over the week's practice total (S2), and the prompts show practice sizes (S4).

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routes), React, AI SDK (`generateObject` via `loggedGenerateObject`), zod, vitest (`environment: node`).

**Spec:** `docs/superpowers/specs/2026-10-22-allocate-after-research-design.md`

## Global Constraints

- No fixed share, range, floor or ceiling on any share in code or prompts beyond validity (0–100, shares summing to 100). No worked example that steers numbers ("reading is a small share").
- The allocation model role is `allocate`, default `anthropic/claude-opus-5.5`, resolved with the learner's key like the other roles.
- The reading share is derived in code from the kept reading parts; the model's own reading share is only a fact.
- The learner's own materials are never dropped.
- The local `DATABASE_URL` is production: no migrations (none are needed: `sources.practice` is jsonb), no scripts that connect, no paid evals.
- Run tests with `npx vitest run <file>`; typecheck with `npx tsc --noEmit` (run `npx next typegen` first if `LayoutProps` is missing).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The allocation names ids not on the list, repeats an id, or marks a learner material `drop: true` → unknown ids ignored, first part per id wins, learner material kept (Task 3 test `ignores unknown and repeated ids and never drops the learner's own`).
2. The kept reading parts exceed the plan's hours → reading share 100, practice cleared, a fact says so (Task 3 test `caps the reading share at 100 when the reading parts fill the plan`).
3. A kept chapter set has out-of-range or no valid positions → invalid positions ignored; none valid means the book is kept whole (Task 3 test `keeps a book whole when no kept chapter is valid`).
4. A plan with no materials at all (no research, no learner sources) → allocation still returns a valid split, with only formats that can be written without a source (Task 3 test `allocates a plan with no materials`).
5. A saved plan (split given) is expanded or drafted again → no allocation call is made and its split and materials are used as saved (Task 5 test `does not allocate when a split is given`).

---

### Task 1: The `allocate` model role

**Files:**
- Modify: `lib/ai/models.ts` (next to `DEFAULT_RESEARCH_MODEL`)
- Modify: `lib/ai/resolve.ts:19-31,65-79`
- Test: `lib/ai/resolve.test.ts`

**Interfaces:**
- Produces: `DEFAULT_ALLOCATE_MODEL: AiModelId = "anthropic/claude-opus-5.5"`; `ModelSet.allocate: ResolvedModel`; `DEFAULT_MODEL_IDS.allocate`; `resolveWith(...)` returns `allocate`.

- [ ] **Step 1: Write the failing test** in `lib/ai/resolve.test.ts`:

```ts
it("resolves the allocate role to Opus 5.5, on the learner's Anthropic key when they have one", () => {
  expect(DEFAULT_MODEL_IDS.allocate).toBe("anthropic/claude-opus-5.5");
  expect(resolveWith({}).allocate).toEqual({ model: "anthropic/claude-opus-5.5", id: "anthropic/claude-opus-5.5", keyOwner: "app" });
  expect(resolveWith({ anthropic: "sk-ant-test" }).allocate).toMatchObject({ id: "anthropic/claude-opus-5.5", keyOwner: "user" });
});
```

- [ ] **Step 2: Run** `npx vitest run lib/ai/resolve.test.ts` — expect FAIL (`allocate` undefined).
- [ ] **Step 3: Implement** the constant, the `ModelSet` field, the default and the `resolveWith` entry. Fix any other `ModelSet` literal the typecheck flags (tests, route fakes) by adding `allocate`.
- [ ] **Step 4: Run** the test and `npx tsc --noEmit` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(models): an allocate role, Opus 5.5 by default`.

---

### Task 2: Practice sizes reach the drafter (S4)

**Files:**
- Modify: `lib/schemas/material.ts:76-84` (`materialPracticeSchema`)
- Modify: `lib/ai/planPrompt.ts` (`renderMaterials` ~L200, `leafPracticeRules` ~L386)
- Modify: `components/pensieve/MaterialsList.tsx:296`
- Test: `lib/ai/planPrompt.test.ts`, `lib/schemas/material.test.ts` (create if absent)

**Interfaces:**
- Produces: `MaterialPractice.totalItems?: number | null` — the whole count when `items` was cut; absent or null when not cut.
- Produces: `practiceTag(p: MaterialPractice): string` in `lib/ai/planPrompt.ts`, exported, e.g. `"practice: Problems · 75 of 150 problems · about 10 min each · answers"`.

- [ ] **Step 1: Write the failing tests.**

```ts
// lib/schemas/material.test.ts
it("keeps a practice source's whole count when its items were cut", () => {
  const p = { format: "problem-set", items: 75, totalItems: 150, perItemMinutes: 10, minutes: 750, answers: true };
  expect(materialPracticeSchema.parse(p).totalItems).toBe(150);
  expect(materialPracticeSchema.parse({ ...p, totalItems: undefined }).totalItems).toBeUndefined();
});

// lib/ai/planPrompt.test.ts
it("shows a practice source's size, per-item time and answers", () => {
  const p = { format: "problem-set" as const, items: 75, totalItems: 150, perItemMinutes: 10, minutes: 750, answers: true };
  expect(practiceTag(p)).toBe("practice: Problems · 75 of 150 problems · about 10 min each · answers");
  expect(practiceTag({ ...p, totalItems: null })).toBe("practice: Problems · 75 problems · about 10 min each · answers");
  expect(practiceTag({ format: "mock", items: null, perItemMinutes: null, minutes: null, answers: true })).toBe("practice: Mock · answers");
});
it("tells the drafter how each format is sized", () => {
  // Use the existing leaf-prompt fixture with problem-set and mock picks.
  expect(prompt).toContain("Problems is sized per problem, about 10 min each");
  expect(prompt).toContain("Mock is one block of about 75 min");
});
```

The unit noun per format: problem-set "problems", recall "questions", lab "steps"; other formats have no count noun and show only what they have. Take the per-item and block minutes from `PRACTICE_REGISTRY` (`perItemMinutes`, `fixedMinutes`); the mock's block is whatever the registry says (75 today).

- [ ] **Step 2: Run** both files — expect FAIL.
- [ ] **Step 3: Implement.** Add `totalItems: z.number().int().min(1).max(5000).nullable().optional()`. `renderMaterials` uses `practiceTag(m.practice)` in place of the bare label. `leafPracticeRules` appends to each pick's line its sizing sentence (`"<Label> is sized per <noun>, about N min each."` or `"<Label> is one block of about N min."`). `MaterialsList` shows `"75 of 150"` when `totalItems` is set.
- [ ] **Step 4: Run** the files and the prompt tests that snapshot lines (`npx vitest run lib/ai`) — fix expectations that now include the sizes.
- [ ] **Step 5: Commit** `feat(practice): the drafter sees a practice source's size and how its format is sized`.

---

### Task 3: The allocation module

**Files:**
- Create: `lib/ai/allocate.ts`
- Test: `lib/ai/allocate.test.ts`

**Interfaces:**
- Consumes: `normalizePicks`, `PRACTICE_REGISTRY`, `PRACTICE_FORMATS` (`lib/practice.ts`); `normalizeSplit`, `PlanSplit`, `totalHours` (`lib/studyTime.ts`); `isPracticeOnly`, `pickSources` (`lib/materials.ts`); `loggedGenerateObject`, `GenerationLogContext` (`./logged`); `providerError`; `ResolvedModel`; `renderMaterials`/`practiceTag` (Task 2) or an equivalent renderer; `DroppedMaterial` (`lib/ai/research/events.ts`).
- Produces:
  - `export const ALL_READING: PlanSplit` (moved from `practicePick.ts`, same value).
  - `export interface AllocationInput { topic: string; instructions?: string; weeks: number; daysPerWeek: number; hoursPerWeek: number; materials: Material[] }`
  - `export const allocationDraftSchema` (zod) with `readingShare: number`, `practice: string`, `reason: string`, `picks: PracticePickDraft[]`, `parts: { id: string; uses: string | null; minutes: number | null; chapters: number[] | null; items: number | null; drop: boolean; dropReason: string | null }[]`.
  - `export function buildAllocationPrompt(input: AllocationInput): string`
  - `export function applyAllocation(draft: AllocationDraft, input: AllocationInput): { split: PlanSplit; materials: Material[]; dropped: DroppedMaterial[]; facts: string[] }` — pure.
  - `export async function allocatePlan(input: AllocationInput & { model: ResolvedModel; log?: GenerationLogContext; signal?: AbortSignal }): Promise<{ split: PlanSplit; materials: Material[]; dropped: DroppedMaterial[]; costUsd: number }>` — label `"Allocate"`, caller `"outline"`.

**`applyAllocation` rules** (each one a test below):
- Parts: the first part per known id wins; unknown ids are ignored.
- `drop: true` removes a researched material and adds `{ title, url, reason: "not used by the plan: <dropReason or 'no reason given'>" }` to `dropped`. A learner material is never removed; its part, if any, still applies.
- Reading part, with `chapters` and a `toc`: keep the valid 1-based positions (deduped, in order), filter `toc.chapters` to them, set `minutes` to their sum (where sized) and `uses` to the kept chapter numbers as `"ch. 5–9"` / `"ch. 1–4, 7"`. No valid position → the material is kept whole, unchanged.
- Reading part without chapters: `minutes` = `min(part.minutes, material.minutes)` when both are set; `uses` = `part.uses` clipped to 120.
- Practice part: `items` in 1..`practice.items` (when the whole count is known) sets `practice.items`, keeps the whole in `practice.totalItems`, and recomputes `practice.minutes` = items × `perItemMinutes` (registry default when the source has none). Out of range → unchanged.
- Reading share = round(sum of `minutes` over kept materials that are not `isPracticeOnly`, over the plan's total minutes × 100), at most 100.
- Picks: `normalizePicks(draft.picks)`, then drop every pick that `pickSources(split, keptMaterials)` marks unassignable (no kept serving material and the format can't be written: `generated` `"never"`, or `"from-reading"` with nothing kept to read); reshare the rest to 100 with `normalizePicks`'s rounding. `split = normalizeSplit({ readingShare, practice, reason, picks })` (it clears picks at 100 and forces 100 with none); null → `ALL_READING`.
- Facts: `model reading <model's>% → <derived>% from the parts`, `reading parts <h> h of <total> h`, a line per dropped material, and a line per per-item pick whose kept items × minutes differ from its time by more than 25 %.

**Prompt rules** (tests below): it lists the brief, every material with its size, chapters (with per-chapter minutes) and practice tag, and every registry format with what the learner does, how it's sized and whether it can be written without a source. It says what to weigh in words — the learner's goal and instructions first; reading and practice both count; a book followed in order beats scattered pieces; a block format needs whole blocks; a format nothing serves and that can't be written gets no time; the learner's own materials stay — and contains no target number.

- [ ] **Step 1: Write the failing tests** (`lib/ai/allocate.test.ts`, mocking `ai`'s `generateObject` as `practicePick.test.ts` does). Fixture: a 48-hour plan (8 weeks × 6 h, 5 days) with `M1` a backbone book with a 10-chapter `toc` (60 min each), `M2` a researched essay (15 min), `M3` a practice-only problem list (150 items, 10 min each, answers), `M4` a learner note (30 min).

```ts
it("derives the reading share from the kept parts, not the model's number", () => {
  const out = applyAllocation(draft({ readingShare: 70, parts: [{ id: "M1", chapters: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, { id: "M2", drop: true, dropReason: "covered by the book" }] }), input);
  expect(out.split.readingShare).toBe(22); // (600 + 30) / 2880
  expect(out.facts).toContain("model reading 70% → 22% from the parts");
  expect(out.dropped).toEqual([{ title: "Essay", url: "https://e.example/a", reason: "not used by the plan: covered by the book" }]);
});
it("keeps only the chosen chapters and sizes the book from them", () => {
  const m1 = applyAllocation(draft({ parts: [{ id: "M1", chapters: [5, 6, 7, 9] }] }), input).materials.find((m) => m.id === "M1")!;
  expect(m1.toc!.chapters.map((c) => c.n)).toEqual([5, 6, 7, 9]);
  expect(m1.minutes).toBe(240);
  expect(m1.uses).toBe("ch. 5–7, 9");
});
it("keeps a book whole when no kept chapter is valid", () => {
  const m1 = applyAllocation(draft({ parts: [{ id: "M1", chapters: [0, 42] }] }), input).materials.find((m) => m.id === "M1")!;
  expect(m1.toc!.chapters).toHaveLength(10);
});
it("cuts a problem list and keeps its whole count", () => {
  const m3 = applyAllocation(draft({ parts: [{ id: "M3", items: 75 }] }), input).materials.find((m) => m.id === "M3")!;
  expect(m3.practice).toMatchObject({ items: 75, totalItems: 150, minutes: 750 });
});
it("ignores unknown and repeated ids and never drops the learner's own", () => {
  const out = applyAllocation(draft({ parts: [{ id: "M9", drop: true }, { id: "M4", drop: true }, { id: "M2", minutes: 5 }, { id: "M2", minutes: 1 }] }), input);
  expect(out.materials.map((m) => m.id)).toContain("M4");
  expect(out.materials.find((m) => m.id === "M2")!.minutes).toBe(5);
});
it("caps the reading share at 100 when the reading parts fill the plan", () => {
  const big = { ...input, weeks: 1, hoursPerWeek: 3 }; // 180 min against 600 + 45 of reading
  const out = applyAllocation(draft({ picks: [pick("problem-set", 100)] }), big);
  expect(out.split.readingShare).toBe(100);
  expect(out.split.formats).toEqual([]);
});
it("drops a pick nothing serves and that can't be written, and reshares the rest", () => {
  const out = applyAllocation(draft({ picks: [pick("lab", 50), pick("problem-set", 30), pick("mock", 20)] }), input);
  expect(out.split.formats!.map((p) => [p.format, p.share])).toEqual([["problem-set", 60], ["mock", 40]]);
});
it("allocates a plan with no materials", () => {
  const out = applyAllocation(draft({ picks: [pick("problem-set", 50), pick("mock", 50)], parts: [] }), { ...input, materials: [] });
  expect(out.split.readingShare).toBe(0);
  expect(out.split.formats!.map((p) => p.format)).toEqual(["mock"]);
});
it("gives the model the materials and formats to weigh, and no target numbers", () => {
  const prompt = buildAllocationPrompt(input);
  for (const s of ["M1", "M3", "150 problems", "about 10 min each", "one block of about 75 min", "the learner's own"]) expect(prompt).toContain(s);
  expect(prompt).not.toMatch(/\d+\s*%/);
  expect(prompt).not.toMatch(/small share|mostly practice|mostly reading/i);
});
it("falls back to all reading with the materials unchanged when the call fails on the app's key", async () => { /* reject generateObject; expect ALL_READING, materials === input.materials, costUsd 0 */ });
it("lets a refusal on the learner's own key through, and stops when the request is gone", async () => { /* APICallError + keyOwner user → rejects; aborted signal → rejects; abortSignal passed */ });
it("logs the call as Allocate with its facts", async () => { /* onCall label "Allocate", facts include the derived share */ });
```

`draft(...)` fills defaults (`readingShare: 30, practice: "interview practice", reason: "r", picks: [pick("problem-set", 60), pick("mock", 40)], parts: []`; a part defaults to `{ uses: null, minutes: null, chapters: null, items: null, drop: false, dropReason: null }`); `pick(format, share)` = `{ format, share, focus: "f", reason: "" }`. Adjust the expected numbers only if the fixture's sizes force it, and say so in the report.

- [ ] **Step 2: Run** `npx vitest run lib/ai/allocate.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `lib/ai/allocate.ts` per the rules above. The fallback and key handling follow `pickPractice` in `lib/ai/practicePick.ts` exactly (catch; rethrow when `signal.aborted` or user-key `providerError`; else `console.error` and fall back).
- [ ] **Step 4: Run** the file — expect PASS.
- [ ] **Step 5: Commit** `feat(plan): the allocation call chooses each material's part and the plan's split`.

---

### Task 4: Research without a split

**Files:**
- Modify: `lib/ai/research/agent.ts` (`ResearchBrief.split`, `readingHours`, `picksOf`, `practiceLines`, `buildResearchInstructions`, `practiceFieldLines`, `buildFinalPrompt`)
- Modify: `lib/ai/research/workers.ts` (`createWorkersArm` L274-276, `PRACTICE_BRIEF`)
- Modify: `lib/ai/research/verify.ts` (gate size step ~L650)
- Modify: `evals/research/providerArm.ts:77`
- Test: `lib/ai/research/agent.test.ts`, `workers.test.ts`, `verify.test.ts`, `evals/research/providerArm.test.ts`

**Interfaces:**
- Produces: `ResearchBrief` without `split`. `export const PRACTICE_RESEARCH_KINDS = 4` (workers.ts) — the practice worker's fixed allowance. `practiceLines(): string[]` — one line per registry format: `- <Label> (<format id>): <research line>`.
- Removes: `readingHours`, `picksOf`.

- [ ] **Step 1: Write the failing tests.**

```ts
// agent.test.ts
it("caps the candidates' minutes at all study hours again and lists materials whole", () => {
  const prompt = buildFinalPrompt({ topic: "T", weeks: 8, hoursPerWeek: 6, sources: [] }, "notes");
  expect(prompt).toContain("must not exceed 48 hours");
  expect(prompt).toContain("list each material at its whole size");
  expect(prompt).toContain("When the notes name a leading book, list it first even when the whole book runs past the time");
  for (const f of PRACTICE_FORMATS) expect(prompt).toContain(`${f} (${PRACTICE_REGISTRY[f].label})`);
});
it("always asks arm A for practice, of the kinds the topic calls for", () => {
  const text = buildResearchInstructions(caps);
  expect(text).toContain("6. Practice");
  expect(text).toContain("the kinds of practice this topic calls for");
  expect(text).toContain("divides between reading and practice is decided after research");
  expect(text).toContain("a list that takes longer than that to get through is too long");
});
// workers.test.ts
it("always runs a practice worker with the fixed allowance", () => {
  // splitCaps(capsFor(48), PRACTICE_RESEARCH_KINDS) → practice [4, 5, 3]
  // buildWorkerInstructions(practice) lists every registry format and says to skip kinds the topic doesn't need
});
// verify.test.ts (runGate)
it("leaves a practice-only source unsized instead of taking its runtime", async () => {
  // candidate: kind video, minutes null, practice problem-set with answers; page durationMinutes 2340
  // expect material.minutes == null and isPracticeOnly(material)
});
```

Replace existing tests that pass `split`/`picks` into research or assert `readingHours` (delete those; keep their intent where it still holds).

- [ ] **Step 2: Run** the four test files — expect FAIL.
- [ ] **Step 3: Implement.** Drop `split` from `ResearchBrief` and its users. Arm A's intro: "How the learner's time divides between reading and practice is decided after research, from what you find; you also look for the practice sources." Step 5 back to the total-time wording. Step 6 always, with "the kinds of practice this topic calls for, skipping kinds it doesn't need" and `practiceLines()`. `practiceFieldLines()` takes no picks and lists every format. Candidates: cap `briefHours(brief)`; "list each material at its whole size (uses null, minutes the whole work): which part the plan uses is decided after research"; the leading-book line; practice coverage: "a kind of practice the topic needs that nothing serves goes in "open" as "practice: <label>"". Workers: always `splitCaps(caps, PRACTICE_RESEARCH_KINDS)`; `PRACTICE_BRIEF` lists `practiceLines()` with the same choose-and-skip sentence and "one search for each kind you choose". Gate: when the candidate has `practice` and `minutes == null`, `size = { minutes: null, minutesBasis: null, uses }`.
- [ ] **Step 4: Run** `npx vitest run lib/ai/research evals` — expect PASS.
- [ ] **Step 5: Commit** `feat(research): research finds practice of the kinds the topic needs and lists materials whole`.

---

### Task 5: The draft allocates after research

**Files:**
- Modify: `lib/ai/planDraft.ts` (`StreamPlanDraftInput`, `streamPlanDraft` L340-362, `streamResearchedPlanDraft` L464-494)
- Modify: `lib/planChat.ts:66-73` (`PlanDraftEvent`)
- Modify: `app/api/plan/draft/route.ts` (pass `allocateModel: models.allocate`)
- Modify: `evals/research/compare.ts:21,90`, `evals/scripts/sample-plans.ts` if it relies on the pick
- Delete: `lib/ai/practicePick.ts`, `lib/ai/practicePick.test.ts`
- Test: `lib/ai/planDraft.test.ts`

**Interfaces:**
- Consumes: `allocatePlan`, `ALL_READING` (Task 3); `ModelSet.allocate`, `DEFAULT_ALLOCATE_MODEL` (Task 1); `ResearchBrief` without split (Task 4).
- Produces: `StreamPlanDraftInput.allocateModel?: ResolvedModel`, `StreamPlanDraftInput.signal?: AbortSignal`, `StreamResearchedDraftInput.allocateModel?: ResolvedModel`. New event `{ type: "allocated"; materials: Material[]; dropped: DroppedMaterial[] }` in `PlanDraftEvent`, emitted right before `{ type: "split" }`.

- [ ] **Step 1: Write the failing tests** (replace `respondPick`/`PICK_LABEL` helpers with an allocation response helper):

```ts
it("allocates after research, then sends the allocated materials and the split before any node", async () => {
  // research offline with M1..; generateObject → allocation keeping M1 ch. 1–3
  // events in order: research.done, allocated (M1.toc 3 chapters), split, node…, finish
  // the outline prompt (first streamObject call) contains "ch. 1–3"
});
it("does not allocate when a split is given", async () => {
  // streamPlanDraft({ ..., split: savedSplit }) → generateObject not called, no allocated/split events
});
it("passes the allocate model and the request's signal to the allocation", async () => { /* calls[0][0] model & abortSignal */ });
it("drafts an all-reading plan when the allocation fails on the app's key", async () => { /* first event split = ALL_READING */ });
it("lets a refusal on the learner's own key propagate before any node", async () => { /* rejects, no node events */ });
it("counts the allocation's cost in the finish event", async () => { /* finish.costUsd includes it */ });
```

- [ ] **Step 2: Run** `npx vitest run lib/ai/planDraft.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** `streamPlanDraft`: when `input.split` is absent, `allocatePlan({ topic, instructions, weeks, daysPerWeek, hoursPerWeek: input.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK, materials: input.materials, model: input.allocateModel ?? appModel(DEFAULT_ALLOCATE_MODEL), log, signal })`; yield `allocated` then `split`; draft with the allocated materials. `streamResearchedPlanDraft`: no pick; research with the split-free brief; then `streamPlanDraft({ ...input, materials: outcome.materials })` (it allocates). Route passes `allocateModel: models.allocate`. Evals: drop `pickPractice`; let `streamPlanDraft` allocate. Delete the pick module and its test.
- [ ] **Step 4: Run** `npx vitest run` (all) and `npx tsc --noEmit` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(plan): drafts allocate after research instead of picking practice first`.

---

### Task 6: Checks follow the drafted split and budget blocks over the week (S1, S2)

**Files:**
- Modify: `lib/materials.ts` (`levelChecks` L516 `share`, `weekRule` L593-617)
- Modify: `lib/ai/planPrompt.ts` (`leafPracticeRules`: block formats line)
- Test: `lib/materials.test.ts`, `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Consumes: `draftedSplit`, `practiceBudgets` (existing).
- Produces: `export function isBlockFormat(f: PracticeFormat): boolean` in `lib/practice.ts` (`fixedMinutes !== null`).

**Block rule for `weekRule`:** let `blockBudget` = sum of the week's budgets for block formats, `blockUsed` = minutes assigned to block formats. Per-item formats' budgets are scaled by `(perItemBudget + blockBudget − blockUsed) / perItemBudget` (shareOut over their shares; never below 0). Block formats get no per-format breach or "short" fact. The week's total practice (all formats) breaches above `budgetCeiling(total practice budget)`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("holds headings to the drafted reading share when a pick has no source", () => {
  // split readingShare 15, picks problem-set 45 / design 25 / mock 15 / recall 15; materials with no problem list.
  // A month heading reserving ~700 min of reading over 4 weeks at 6 h: no "reserves about … of reading" breach.
});
it("lets a week hold a whole mock and gives a week without one its time for other practice", () => {
  // 6 h week, reading 15 %, problem-set 45 / design 25 / mock 15 / recall 15.
  // Week A: one 75-min mock + problems within the reduced budget → no breach.
  // Week B: no mock, problems use the mock's slice too → no breach, no "Mock … short" fact.
  // Week C: practice total above the ceiling → one total-practice breach.
});
it("tells the drafter a block format is placed whole over the plan", () => {
  expect(prompt).toContain("Mock comes in whole blocks: place one where a week has room, not a part of one each week");
});
```

- [ ] **Step 2: Run** both files — expect FAIL.
- [ ] **Step 3: Implement.** `share = readingShareOf(input.split ? draftedSplit(input.split, input.materials) : null) ?? MUST_SHARE`. Add `isBlockFormat` and the block rule. Add the prompt line for each block pick.
- [ ] **Step 4: Run** `npx vitest run lib` — expect PASS; update existing expectations that relied on per-week mock budgets, saying which in the report.
- [ ] **Step 5: Commit** `fix(practice): checks use the drafted split everywhere and budget whole blocks over the week`.

---

### Task 7: The workspace shows the allocation

**Files:**
- Modify: `components/pensieve/PlanWorkspace.tsx` (`readNdjson` handler ~L196-235)
- Modify: `components/pensieve/TimeSplitCard.tsx` only if the reason isn't already shown on a new plan
- Test: `components/pensieve/PlanWorkspace.test.ts` if a handler test exists; otherwise extract the event-to-state step as `applyDraftEvent` in `lib/planChat.ts` and test it there.

**Interfaces:**
- Consumes: the `allocated` event (Task 5).

- [ ] **Step 1: Write the failing test** that an `allocated` event replaces the materials with its list and appends its `dropped` to the existing dropped list (research's drops stay).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement:** on `allocated`, set `researched` and `setMaterials(event.materials)`, `setDropped((d) => [...d, ...event.dropped])`. The split event is unchanged.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(plan): the workspace shows the allocated parts and what the plan won't use`.

---

## After the tasks

Whole-branch review, then a live draft on the builder's own 3001 server (from this worktree) for the SDE interview brief, checking: an "Allocate" call on Opus 5.5 in the model panel; a backbone book kept with a part; a problem list with "N of M"; no "reserves about … of reading" breach at the top level; no NeetCode-video runtime counted as reading.
