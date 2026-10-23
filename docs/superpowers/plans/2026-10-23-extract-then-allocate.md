# Extract Then Allocate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Research's candidates step records every credible source (no selection), the gate verifies books by published or page title, and the allocation (Opus 5.5, high effort) chooses the backbone, the parts and the plan's coverage.

**Architecture:** The candidates schema loses `backbone` and gains `pageTitle` and `foundBy`; its prompt asks for completeness with no hour cap, and code records pages read but not listed. The gate stops choosing a backbone, marks matched books `catalogued`, and tries a book's page title when its published title finds nothing; the pipeline runs the chapter finder for up to two likely backbones. The allocation receives that evidence, returns `backbone` and `coverage`, treats unmentioned researched materials as not used, and has a code-only fallback chooser. The client shows the plan's coverage and splits the dropped list by stage.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routes), AI SDK (`generateObject` via `loggedGenerateObject`), zod, vitest (`environment: node`).

**Spec:** `docs/superpowers/specs/2026-10-22-extract-then-allocate-design.md` (builds on `docs/superpowers/specs/2026-10-22-allocate-after-research-design.md`).

## Global Constraints

- No fixed share, range, floor or ceiling on any share in code or prompts beyond validity; no steering numbers or worked examples in prompts; the reading share is derived from the kept reading; the learner's own materials are never dropped; a long book is not a reason to drop it.
- Only a catalogued book (matched on Open Library) or a learner's own book may be the backbone; at most one material ends with `backbone: true`.
- The allocation runs at effort `"high"`.
- The local `DATABASE_URL` is production: no migrations, no scripts that connect, no paid evals, no real model or search calls in tests.
- Run tests with `npx vitest run <file>`; typecheck with `npx tsc --noEmit` (run `npx next typegen` first if `LayoutProps` is missing).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The allocation names as backbone an uncatalogued researched book, a dropped material, or a non-book → no backbone, and a fact (Task 3 test `refuses a backbone the gate couldn't match`).
2. The allocation mentions only some materials → the unmentioned researched ones are not used, with "not chosen" reasons; the learner's own stay (Task 3 test `drops the researched materials it did not mention`).
3. The extraction returns more than 25 candidates → the list is cut to 25 in code, keeping the order the model gave (Task 1 test `keeps at most 25 candidates`).
4. A book's published title misses on Open Library but its page title hits with the same author → verified under the catalogue's title; a page-title hit with another author → dropped (Task 2 test `falls back to the page title only when the author agrees`).
5. The allocation call fails on a long, unselected list → the fallback keeps the learner's own, the best-recommended catalogued book as backbone, the practice sources, and reading in order while it fits the hours (Task 3 test `falls back to a list that fits the hours`).

---

### Task 1: Extraction records every credible source

**Files:**
- Modify: `lib/ai/research/verify.ts` (`candidateSchema` ~L29-41, `candidateListSchema` ~L58-67)
- Modify: `lib/ai/research/agent.ts` (`buildFinalPrompt`, the candidates call `runCandidateStep` ~L370-400, `ArmResult`)
- Modify: `lib/ai/research/workers.ts` (the workers arm's candidates step and its notes)
- Modify: `lib/ai/research/verify.ts` `runGate` backbone step (~L705-712) only to stop reading `c.backbone`
- Modify: `evals/research/bench.ts` (~L109-145, 185) to compile without `candidate.backbone`
- Test: `lib/ai/research/agent.test.ts`, `lib/ai/research/workers.test.ts`, `lib/ai/research/verify.test.ts`, `evals/research/bench.test.ts`

**Interfaces:**
- Produces: `Candidate` without `backbone`, with `pageTitle?: string | null` and `foundBy?: ("backbone" | "canonical" | "current" | "practice" | "learner" | "research")[]`. `MAX_CANDIDATES = 25` exported from verify.ts. `ArmResult.reads?: { url: string; finalUrl: string | null; direction: string }[]` — every successful page read with the direction that made it (`"research"` for arm A).
- Produces: `readButNotListed(reads, candidates, learner): string[]` in `lib/ai/research/agent.ts` (or verify.ts) — facts `read but not listed: <url> (<direction>)`.

- [ ] **Step 1: Write the failing tests.**

```ts
// agent.test.ts
it("asks the candidates step to record every credible source, with no hour cap", () => {
  const prompt = buildFinalPrompt({ topic: "T", weeks: 8, hoursPerWeek: 6, sources: [] }, "notes");
  expect(prompt).not.toMatch(/must not exceed \d+ hours/);
  expect(prompt).toContain("every credible source the notes found");
  expect(prompt).toContain("Choosing what the plan uses happens later");
  expect(prompt).toContain("title as published");
  expect(prompt).toContain("pageTitle");
  expect(prompt).not.toMatch(/backbone: true/);
});
it("records pages a researcher read that the list leaves out", () => {
  const reads = [{ url: "https://github.com/mdmzfzl/NeetCode-Solutions", finalUrl: null, direction: "practice" }, { url: "https://a.example/x", finalUrl: null, direction: "canonical" }];
  expect(readButNotListed(reads, [cand("https://a.example/x")], [])).toEqual(["read but not listed: https://github.com/mdmzfzl/NeetCode-Solutions (practice)"]);
});
// verify.test.ts
it("keeps at most 25 candidates", () => { /* candidateListSchema or the arm's normaliser cuts 30 to the first 25 */ });
it("no longer reads a backbone from the candidates", () => { /* runGate with two matched books: the one with more recommending domains is backbone, whatever order */ });
```

`foundBy`: derive it in code where the notes carry the URL (the workers' notes per direction; arm A → `"research"`; a learner source → `"learner"`); the model's own `foundBy` is only a fallback. Test that a URL read by the practice worker gets `foundBy` containing `"practice"`.

- [ ] **Step 2: Run** the four files — expect FAIL.
- [ ] **Step 3: Implement.** Schema: drop `backbone`; add `pageTitle` ("for a book, the title its web page shows; null otherwise") and `foundBy`; `title` described as "for a book, its title as published, with the author; otherwise the page's own title". Cut to `MAX_CANDIDATES` in code after the call. Prompt: replace the "Choose a list that covers… must not exceed N hours" sentence with: list every credible source the notes found — pages read, and sources a researcher's notes name or recommend; a search result seen only as a snippet only when the notes recommend it; once each; at most 25, keeping the best-evidenced if more; "Choosing what the plan uses happens later, with sizes in hand, so a source left out here is lost." Remove the backbone flag and the "backbone textbook first" ordering; keep the leading-book sentence as "list every book the notes recommend, under its title as published and its author". Coverage described as "what research found". The gate's backbone step keeps its current rule minus `wantsBackbone` (Task 2 removes the gate's choice). Add `reads` to both arms' results and the read-but-not-listed facts to the candidates call's facts. Bench: replace backbone counts with "books with ≥ `BACKBONE_MIN_DOMAINS` recommending domains".
- [ ] **Step 4: Run** `npx vitest run lib/ai/research evals` and `npx tsc --noEmit` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(research): the candidates step records every credible source instead of choosing`.

---

### Task 2: The gate verifies books by either title and stops choosing a backbone

**Files:**
- Modify: `lib/ai/research/verify.ts` (`createOpenLibraryLookup().find` usage in `runGate` ~L596-635; backbone step ~L703-712)
- Modify: `lib/schemas/material.ts` (`materialSchema`: transient `catalogued`)
- Modify: `lib/ai/research/pipeline.ts` (chapter stage ~L161-184)
- Modify: `evals/research/compare.ts` / `evals/research/metrics.ts` only as needed so `backboneHit` reads the allocated backbone in compare
- Test: `lib/ai/research/verify.test.ts`, `lib/ai/research/pipeline.test.ts` (or `agent.test.ts` where pipeline tests live), `lib/schemas/material.test.ts`

**Interfaces:**
- Produces: `Material.catalogued?: boolean` — true when Open Library matched the book; optional, never required, not persisted (no column).
- Produces: `Material.foundBy?: string[]` — the candidate's `foundBy` (Task 1) carried onto its material, `["learner"]` for the learner's own; optional, not persisted.
- Produces: research's materials with no `backbone: true` set by the gate.
- Produces: the pipeline runs the chapter finder for each catalogued book with no `toc` and `recommendingDomains(url, recommendedBy).length >= BACKBONE_MIN_DOMAINS`, at most 2 (most domains first), in parallel; one `research.chapters` event each.

- [ ] **Step 1: Write the failing tests.**

```ts
it("falls back to the page title only when the author agrees", async () => {
  // books.find(published) → null; books.find(pageTitle) → match with author "Alex Xu"
  // candidate { kind: "book", title: "Coding Interview Patterns", pageTitle: "System Design · Coding · …", author: "Alex Xu" } → kept, catalogued, title = catalogue title
  // same with match author "Someone Else" → dropped "no matching book on Open Library"
});
it("marks matched books catalogued and chooses no backbone", async () => { /* two matched books → both catalogued, none backbone */ });
it("carries each candidate's foundBy onto its material", async () => { /* candidate foundBy ["practice"] → material.foundBy ["practice"]; learner source → ["learner"] */ });
it("looks for chapters for up to two likely backbones before the allocation", async () => {
  // three catalogued books without toc: 3, 2 and 1 recommending domains → finder called for the first two only
});
```

- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** In the gate's book check, when `find(title)` is null and `c.pageTitle` differs, `find(c.pageTitle, c.author)`; `pickBookMatch` already requires author overlap. Set `catalogued: true` on matched books' materials and carry `foundBy`; delete the backbone assignment (keep `BACKBONE_MIN_DOMAINS` and `recommendingDomains` exported for the pipeline and the allocation). Pipeline: replace the single-backbone chapter stage with the bounded loop above (keep the user-key rethrow and failure logging per book). Ensure `catalogued` is stripped or ignored wherever materials are saved (check `materialSchema` passes it through harmlessly; it has no column).
- [ ] **Step 4: Run** `npx vitest run lib evals` and `npx tsc --noEmit` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(research): books verify by published or page title, and the gate leaves the backbone to the allocation`.

---

### Task 3: The allocation chooses the backbone and coverage, at high effort

**Files:**
- Modify: `lib/ai/models.ts` (add `ALLOCATE_EFFORT`)
- Modify: `lib/ai/allocate.ts` (schema, prompt, `applyAllocation`, `allocatePlan`, new fallback chooser)
- Test: `lib/ai/allocate.test.ts`

**Interfaces:**
- Consumes: `Material.catalogued`, `Material.foundBy`, `recommendingDomains`, `BACKBONE_MIN_DOMAINS` (Task 2).
- Produces: `ALLOCATE_EFFORT: ReasoningEffort = "high"`. `allocationDraftSchema` gains `backbone: string | null` and `coverage: { covered: string[]; open: string[] } | null`. `Allocation` and `allocatePlan`'s result gain `coverage: Coverage | null` (null on the fallback path). `export function fallbackAllocation(input: AllocationInput): Allocation` — pure.

**Rules (each a test):**
- Effort: `allocatePlan` passes `effort: ALLOCATE_EFFORT` to `loggedGenerateObject` (assert `providerOptions.anthropic.effort === "high"` on the mocked `generateObject` call).
- Prompt per book: catalogued or not, recommending sites (count and domains), chapters with minutes, size, why, learner's own. Asks for `backbone` (an id or null) and `coverage` in words (no numbers). Still no `\d+%` and no steering words.
- Backbone: the id must be a kept book that is catalogued or the learner's own; otherwise none and fact `backbone <id> refused: <reason>`. Exactly one or zero materials end `backbone: true` (all others false, whatever research set).
- Unmentioned: a researched material with no part is dropped with reason `not used by the plan: not chosen` and a fact; a learner material with no part is kept whole.
- Coverage: `normalizeCoverage(draft.coverage)`.
- Fallback (`allocatePlan` on app-key failure or no usable split): `fallbackAllocation` keeps the learner's own; backbone = the catalogued book with the most recommending domains (ties: list order), if any; keeps practice sources; then other reading in list order while the running reading minutes (whole sizes; backbone counted first, always kept) fit the plan's total minutes; split `ALL_READING`; coverage null; a fact `fallback chose the materials`.

- [ ] **Step 1: Write the failing tests** — one per rule above, named: `runs at high effort`, `shows the model each book's evidence and asks for a backbone and coverage`, `refuses a backbone the gate couldn't match`, `keeps one backbone at most`, `drops the researched materials it did not mention`, `normalises the plan's coverage`, `falls back to a list that fits the hours`. Fixture: 48-hour plan; M1 catalogued book (3 domains, 10 chapters × 60 min), M2 uncatalogued book (600 min), M3 essay (15 min), M4 practice-only problem list (150 items), M5 learner note (30 min), M6 long course (2400 min).
- [ ] **Step 2: Run** `npx vitest run lib/ai/allocate.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per the rules.
- [ ] **Step 4: Run** the file, `npx vitest run`, `npx tsc --noEmit` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(plan): the allocation chooses the backbone and states the plan's coverage, at high effort`.

---

### Task 4: The plan's coverage and the two dropped groups reach the page

**Files:**
- Modify: `lib/planChat.ts` (`PlanDraftEvent` `allocated` gains `coverage: Coverage | null`; `applyDraftEvent`/`DraftMaterials` carry coverage)
- Modify: `lib/ai/planDraft.ts` (emit coverage in `allocated`)
- Modify: `lib/ai/research/events.ts` (`DroppedMaterial.stage?: "checks" | "plan"`)
- Modify: `lib/ai/allocate.ts` (allocation drops carry `stage: "plan"`; the gate's stay unset = checks)
- Modify: `components/pensieve/PlanWorkspace.tsx`, `components/pensieve/MaterialsList.tsx`
- Test: `lib/planChat.test.ts`, `lib/ai/planDraft.test.ts`, a `MaterialsList` static-render test if one exists (else `components/pensieve/MaterialsList.test.ts` with `renderToStaticMarkup`, as `TimeSplitCard.test.ts` does)

**Interfaces:**
- Consumes: `Allocation.coverage` (Task 3).
- Produces: `DraftMaterials.coverage: Coverage | null` and `coverageSource: "plan" | "research"`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("takes the plan's coverage from the allocated event, and research's only as what research found", () => {
  // research.done coverage R → state coverage R, source "research"; allocated coverage P → P, "plan"; allocated null → keeps R, "research"
});
it("emits the plan's coverage with the allocated materials", async () => { /* planDraft: allocated.coverage equals the allocation's */ });
it("labels research's coverage as what research found", () => {
  // MaterialsList with coverageSource "research" shows "Research found", not "Covered"; with "plan" shows "Covered" / "Not covered"
});
it("splits what was left out into rejected by checks and found but not used", () => {
  // dropped [{stage undefined}, {stage "plan"}] → two groups with those headings and their reasons
});
```

- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Event and reducer carry coverage; the workspace stores `coverage` and `coverageSource` and passes them to `MaterialsList`. `MaterialsList`: coverage chips' heading by source; the dropped `<details>` becomes two groups, "Rejected by checks" (no stage or `"checks"`) and "Found but not used" (`"plan"`), each with count and reasons, same styling.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(plan): the page shows the plan's coverage and what the plan found but didn't use`.

---

## After the tasks

Whole-branch review of these four tasks' range, one fix wave if needed, then one live draft of the SDE brief on the builder's own 3002 server with Admin mode on in a fresh tab, checking: no "read but not listed" for NeetCode or the backbone book; a catalogued backbone chosen by Allocate; the "Allocate" call logged at effort high; the plan's coverage on the page; both dropped groups.
