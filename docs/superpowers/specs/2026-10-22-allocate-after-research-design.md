# Allocate after research: the model divides the plan's time with the materials in hand

Status: draft for approval. Builds on the practice-formats design (`2026-10-21-practice-formats-design.md`, merged as
PR #21) and replaces its "pick before research" step.

## Why

Today a quick Haiku call (`lib/ai/practicePick.ts`, "Practice · pick") decides, before any research, how the plan's
time divides: a reading share and a share per practice format. Everything downstream is then held to numbers chosen
blind:

- Research capped its reading list at hours × reading share (`readingHours`, `lib/ai/research/agent.ts`). On an SDE
  interview plan (8 weeks × 6 h, 25 % reading → 12 h) the candidates step dropped both backbone books it had found
  (Xu's *System Design Interview* Vol. 1 ≈ 11.5 h, DDIA ≈ 26 h) rather than take part of one.
- With the cap at all study hours instead, research listed ≈ 31 h of reading for 12 h of reading time; no set of weeks
  could hold it, so the weeks split and its retry both breached.
- The pick prompt steers the share with a worked example ("an SDE interview loop: … reading is a small share").
- Review findings on PR #21 that come from the same root: S1 (a pick with no source folds into reading only at leaves;
  headings and research still use the raw share), S2 (block formats such as a 75-min mock or 50-min design exercise
  can't fit a small weekly share, and the retry pushes the drafter to cut them), S4 (the drafter never sees a practice
  source's size, so practice rows are guesses).

The owner's view: the split is a judgement the model should make, with the materials in front of it, and the model's
call may well be better than the owner's. Asked how they'd divide the SDE plan given Xu's book, NeetCode's 150 solved
problems, the System Design Primer and mock replays, the owner answered roughly: the whole book, then of the rest about
half LeetCode, 40 % system design and the rest mocks, with behavioral prep inside the mocks. Those numbers are an
illustration of the kind of reasoning wanted, **not** values to put anywhere in code or prompts.

## Goals

1. After research, one strong model call ("allocation") sees every material with its size and what it holds, plus the
   learner's goal and instructions, and decides:
   - which part of each material the plan uses (a book's chapters, a subset of a problem list), and its minutes;
   - the reading share and each practice format's share, which follow from those parts;
   - a short reason, shown on the time card as the split's reason is today.
2. The weeks and days share out exactly the allocated parts, using the sizes the allocation fixed.
3. The draft runs straight through: pick nothing up front, research, allocate, draft. No pause for approval.
4. Fixes that the new flow makes possible are folded in: S1, S2, S4, keeping the leading book, and not counting a
   practice-only source's runtime or length as reading.

## Non-goals

- Changing how research verifies sources (the gate's title check, Open Library, answers rule) beyond what's listed.
- A new UI for editing the allocation per material. The existing slider, hours and days pickers stay as they are.
- Re-running the allocation when the learner changes hours, days or the slider after drafting.
- Migrating saved plans. Old plans keep their saved split and materials and behave as today.

## Anti-goals (would be a failure even if it works)

- Any fixed share, range, floor or ceiling on the reading share or a format's share, in code or in a prompt, beyond
  validity (0–100, shares summing to 100). No clamp like "within ±20 points of a prior". The owner was explicit.
- Worked examples or wording that steer the model toward particular numbers ("reading is a small share",
  "interviews are mostly practice"). Examples, if any, show what to weigh, never what to choose.
- The share simply becoming "whatever research found": the allocation is asked to choose the parts the plan needs, not
  to add up the list.
- The leading book dropped because it is long.

## The flow

```
brief ──► research (practice kinds decided by the practice researcher) ──► gate ──► ALLOCATION (Opus 5.5) ──► weeks ──► days
                                                                                     │
                                                                                     └► split + per-material parts, reason
```

### 1. No pick before research

- `pickPractice` and its "Practice · pick" call are removed from the draft path (`streamPlanDraft`,
  `streamResearchedPlanDraft` in `lib/ai/planDraft.ts`; `evals/research/compare.ts`).
- The research brief no longer carries a split. Research must work with no picks.

### 2. Research

- **The practice researcher decides the kinds.** The workers arm always adds a practice worker (today it is added only
  when there are picks). Its brief lists every format in `PRACTICE_REGISTRY` with its `research` line and asks it to
  look for the kinds this topic calls for, one search per kind it chooses, and to skip formats the topic doesn't need.
  Its budget: the per-kind rule from the last fix needs a kind count up front; use a fixed allowance instead (builder's
  call, e.g. as if four kinds), so the budget doesn't depend on a decision not yet made.
- Arm A (`createAgentArm`) gets the same: its work order's practice step lists all formats and lets it choose.
- **The candidates step** (`buildFinalPrompt`):
  - reading cap back to all study hours (`briefHours`), not `readingHours`; `readingHours` is removed or unused;
  - `practice` field guidance lists every registry format, not the picks;
  - materials are listed at their **whole** size (`uses` null, `minutes` the whole work) wherever the notes allow:
    choosing the part is the allocation's job, and it can only choose well from the whole;
  - when the notes name a leading book, it is listed first even when the whole book runs past the time available;
    leaving the book out is not a way to meet the cap;
  - "open" coverage for practice names kinds the topic needs that nothing serves (today it names unmet picks).
- **The gate** (`runGate`, `lib/ai/research/verify.ts`): a candidate with `practice` set and `minutes` null keeps
  `minutes` null. It never falls back to the page's runtime or word count (the NeetCode course video was sized at its
  39 h runtime and counted as reading). Measured sizes still apply to reading candidates as today.
- Research step 5 and the "drawn by script" note keep their current wording (fixed in PR #21) apart from dropping
  the reading-share clause from step 5.

### 3. Allocation (new)

A new model call after research, `allocatePlan` (new module, e.g. `lib/ai/allocate.ts`), label "Allocate".

**Model.** A new model role `allocate` in `lib/ai/resolve.ts` (`ModelSet`, `DEFAULT_MODEL_IDS`) defaulting to
`anthropic/claude-opus-5.5`, resolved with the learner's own key the same way the other roles are. It is logged as the
other calls are (model-call panel, generation log, cost in the finish event).

**Input.**
- The brief: topic, instructions, weeks, days per week, hours per week, total hours.
- Every material (learner's and researched), each with: id, kind, title, author, whether it is the backbone, `why`,
  reading minutes and basis (measured/estimated), its chapter list with per-chapter minutes when there is one (`toc`),
  and its practice role: format, items, minutes per item, total doing minutes, answers.
- The practice formats from the registry, each with what the learner does, how it is sized (per item or a fixed block
  such as the 75-min mock), and whether it can be written without a source (`generated`).
- What it must weigh, in plain words, with no target numbers: the learner's goal and instructions first; that reading
  and practice both count; that a book followed in order is worth more than scattered essays; that a block format needs
  whole blocks, so a few full mocks beat many fragments; that a format nothing serves and that can't be written gets no
  time.

**Output** (zod schema, normalised in code):
- `readingShare` 0–100 and `practice` (two or three words), as `PlanSplit` today;
- `picks`: the formats used, each with share (summing to 100 over picks), focus and reason — the existing
  `PracticePick` shape — so the rest of the app reads it unchanged;
- `reason`: one or two sentences shown on the time card;
- `parts`: per material id, what the plan uses:
  - reading: `uses` (e.g. "ch. 5–9", "chapters on replication and partitioning") and `minutes` for that part; for a
    material with a chapter list, the chapter positions kept;
  - practice: the number of items kept (e.g. 75 of 150) or blocks, and a short `uses` ("the core patterns", "Blind 75
    subset"), from which doing minutes follow (items × minutes per item, or blocks × block size);
  - `drop: true` for a material the plan won't use.

**Code after the call** (no judgement, only validity and arithmetic):
- **The reading share is derived from the reading parts, not taken from the model.** `readingShare` = the kept
  reading parts' minutes over the plan's total minutes, rounded, at most 100. The model's own `readingShare` is kept
  only as a fact on the call. This is the owner's framing ("the 11.5 h will all go in, and the rest…"): reading is
  what the chosen reading takes, and practice is the rest. Every budget (`practiceBudgets`, `weekBudgets`,
  `levelChecks`, prompts) keeps reading `readingShare` from the split, as today, so nothing downstream changes how it
  computes; it just gets a share that matches the materials.
- **Practice shares are the model's.** Within practice time, the formats' shares are its judgement and govern each
  format's time. Item counts (75 of 150) say what to work through in that time. When a per-item format's kept items ×
  minutes per item don't match its time, that is a fact, not an error; the drafter shares the kept items out over
  the format's time. *(My call.)*
- shares rounded and normalised to sum to 100; unknown formats and unknown material ids dropped; a format with no
  serving material whose `generated` is `never` is dropped and its share given back proportionally (same as
  `draftedSplit`);
- **Dropping.** The learner's own materials are never dropped (the existing rule "the learner's own are always part
  of it"); the model may still give one a small part. A researched material, the backbone included, may be dropped
  when the model says why (for example the learner asked for no textbooks); length alone is not a reason the prompt
  offers. A dropped material leaves the plan's list and appears in the existing dropped list as "not used by the
  plan: <reason>". *(My call.)*
- **Totals kept.** When a practice source's items are cut, the whole count is kept as `practice.totalItems` (the
  `practice` column is jsonb, so no migration), so "75 of 150" still renders on later expands. A reading part
  overwrites `uses`/`minutes`; the whole reading size is not kept on saved plans, since nothing re-allocates them.
  *(My call.)*
- each material's `uses`/`minutes` (and `practice.items`/`practice.minutes`) updated to its allocated part; a reading
  part's minutes never exceed the whole material's; a kept chapter set must be valid positions;
- the material's signature is over url, fetched title and verification time only, so editing the part keeps it
  verified;
- facts recorded on the call (as other calls do): the split, and the reading minutes allocated against the reading
  share of the hours. A mismatch is a fact, not a breach; the drafter works from the allocation.

**Fallback.** If the call fails on the app's key, or returns nothing usable: keep the materials as research sized them
and use the all-reading split, as the pick does today (PR #21's S5 behaviour). A refusal on the learner's own key
propagates for the key guard; an aborted request stops. The request's abort signal is passed.

**Events.** The `split` event now comes after research. A new event (or `research.done` re-sent) carries the
materials with their allocated parts, so the materials list and the time card show the parts the plan uses. The time
card shows the allocation's reason.

### 4. Drafting from the allocation

- The materials list in the outline and day prompts shows each material's allocated part and size, and for practice
  sources the items kept, minutes per item, total doing minutes and answers (S4). Example rendering:
  `M3 [repo · practice: Problems · 75 of 150 problems · about 10 min each · answers] "NeetCode-Solutions" …`.
- The practice rules per format state how the format is sized (per item, or a fixed block of N min) so rows are sized
  from the source, not guessed (S4).
- **Block formats (S2).** A block format (one with `fixedMinutes`, today mock and design-exercise) is budgeted over
  the plan rather than per week: the plan's total for that format is its share of all practice time, and weeks are
  free to carry whole blocks unevenly (a mock in weeks 6 and 8, none earlier) as long as the plan-to-date total stays
  within the format's total. The weekly per-format breach doesn't apply to block formats; the weekly total practice
  budget still does. In a week with no block, that format's weekly slice goes to the week's other practice formats;
  in a week that holds a block, the others give way. The week's practice total is unchanged either way, so no time
  is left unplanned (PR #21's rule). Per-item formats otherwise keep today's weekly budgets. *(My call.)*
- **No-source folding at every level (S1).** Wherever a share is read for budgets and checks — `levelChecks` heading
  reservations, `mayShare`, leaf budgets, prompts — it comes from the drafted split (`draftedSplit`), so a format that
  can't be assigned is reading everywhere, not only in leaves. With the allocation dropping such formats up front this
  should rarely trigger, but the checks must agree when it does (e.g. a learner-edited split).
- The weeks split's reading budget per week comes from `readingShare`, which is now derived from the allocated
  reading parts, so the reading fits by construction; a breach there is a real error, not the normal case.
- **Sharing out the parts is guidance plus facts, not new breaches.** The prompts say to share out exactly the
  allocated parts; a top level that leaves an allocated part unreserved, or reserves outside a kept chapter set, is
  recorded as a fact (like `chapterGaps` today). No new breach kinds, so no new retries or row drops. *(My call.)*
- Weeks drafted later (expand, revision, chat) budget from the saved split as today; its `readingShare` is the
  derived one.

### 5. What stays

- `PlanSplit`'s shape, its persistence on the track, the slider and hours/days pickers, `activePicks` and the
  "can't leave time unplanned" rules from PR #21.
- Plans saved before this change: their split and materials as saved; nothing re-allocates them.
- Revision, chat and expand use the saved split and materials as today.

## Constraints

- Next.js 16 in this repo has breaking changes; read `node_modules/next/dist/docs/` before touching routes.
- AI SDK: other calls use `generateObject` via `loggedGenerateObject`; follow that pattern (it is deprecated in favour
  of `generateText` with an output setting, so either is acceptable if consistent with the codebase at the time).
- The local `DATABASE_URL` is production. This design needs no migration (the split and material fields already
  exist); if the builder finds one is needed, stop and ask.
- No paid eval runs without the owner's go-ahead. Live checks are a normal draft on the builder's own 3001 server.
- Tests: vitest, `environment: node`. Every rule above that is code (normalising, folding, block budgeting, the gate's
  null minutes, the fallback) gets a unit test; prompts get tests that they carry the inputs and carry no target
  numbers (e.g. no "%" or "small share" in the allocation prompt's guidance).

## Decided in conversation

- The allocation is the model's judgement; no numbers of the owner's (or anyone's) go into prompts or code.
- The model may shrink a book to chapters, or take a subset of a problem list; it decides which.
- Behavioral preparation belongs inside mock practice for interview topics; that is the model's call per topic, not a
  rule (no separate recall track is forced or forbidden).
- The draft runs straight through with no approval pause.
- The allocation runs on Opus 5.5.
- The up-front pick call is removed; the practice researcher decides which kinds of practice to look for.

## Calls made after the builder check

Marked *(My call.)* above, for the owner to check while reading:
1. Practice shares within practice time are the model's; item counts are what to work through, and a mismatch is a
   fact.
2. Learner materials are never dropped; researched ones (backbone included) may be, with a stated reason, and show in
   the dropped list.
3. A cut problem list keeps its whole count as `practice.totalItems`; reading parts overwrite `uses`/`minutes`.
4. In weeks without a block, the block format's slice goes to the other practice formats that week.
5. Sharing out the allocated parts is checked by facts only, not new breaches.

Answered from the conversation: the reading share is derived from the chosen reading parts (the owner's "the 11.5 h
will all go in, and the rest…"); research lists materials at whole size so the allocation chooses parts.

## Left to the builder

- Module and function names, the allocation prompt's wording (within the anti-goals), and the exact output schema
  field names, as long as the rest of the app keeps reading `PlanSplit` and `Material`.
- The practice worker's fixed research allowance.
- Whether the updated materials travel as a new event or a second `research.done`.
- How a kept chapter set is stored (a `uses` string plus the drafter honouring it, or explicit positions).
- The exact block-format budgeting arithmetic, within the rule above.
