# Open coding of plan outputs — 2026-09-16

**What was run.** All 40 records of `evals/golden/plan.v1.ts` through `streamPlanDraft` / `revisePlanTree` with the
default model (`anthropic/claude-haiku-4.5`), one trial each. Then two more trials of every Mandarin record and
of every revision record, to tell flukes from habits. 96 outputs, 148 model calls, $0.42.
Script: `npx tsx evals/scripts/sample-plans.ts`; outputs land in `evals/samples/` (gitignored).

**What was read.** Every trial-1 output was read in full (§1). For the extra trials only the one-line facts were
read (counts, plan length, language share, changed nodes), plus the full tree for every locked-week run (§2).

**Headline.**

1. Revisions that touch a completed week are unsafe: 7 of 8 runs returned a damaged tree, and only one was refused.
   Two of them contain duplicate node ids. This is a bug in `applyRevision`, not only a model habit (§2.3).
2. A Chinese request gets a fully English plan in 9 of 48 runs. The prompts never say which language to write in (§2.1).
3. The most common quality problem is new: when the first branch is planned in detail, its units teach material
   that belongs to a later sibling heading. 9 of 20 nested drafts (§3, "partition").
4. Counts, spans and injection held up: one wrong count in 64 draft runs, no injection leak in 8 runs.

---

## 1. Trial 1, one row per output

Verdict is for the open-coding pass only: **ok**, **minor** (would not fail a rubric line alone), **fail**.

### Drafts, English

| Record | Verdict | Note |
|---|---|---|
| tech-7d-day-nosrc-01 (regex) | minor | Concrete daily lessons, instruction honoured. Day 7 packs lookaround, multi-line and performance into one day. Day 5 (escapes) comes after Day 3 already used `\b`. |
| soft-7d-day-src-01 (public speaking) | fail | Seven knowledge topics ("Explore", "Learn", "Discover"). No day is a speaking exercise. The video is about voice; only Day 1 touches it. |
| tech-30d-day-nosrc-01 (Kubernetes) | fail | Day 6 is titled "Service Mesh Observability Basics" but its summary is kube-proxy internals, and service mesh is Week 4's ground. Day 7 title starts "Week 1 Capstone:" (label in title). Skip-installation instruction honoured. |
| soft-30d-day-src-01 (personal finance) | fail | All of Week 1, 7 of 30 days, is money psychology because a source is titled *The Psychology of Money*. Budgeting → debt → investing order is right. |
| tech-180d-day-src-01 (Rust) | fail | Month 1 Week 3 "Move semantics, Copy and Clone" is Month 2's heading. Week 1 Days 5–7 (copy vs move, stack vs heap, Drop) are Week 2's and Week 3's ground. Month 1 and Week 1 both summarise "the three ownership rules". 30 days on three rules reads as padding. |
| soft-180d-day-nosrc-01 (French Revolution) | fail | Month 1 Week 4 covers the Estates-General and the Tennis Court Oath, which is Month 3. Week 1 Day 7 also covers the Estates-General. Week 3 covers Enlightenment salons, which is Month 2. Month 4 is titled "the Republic's first years" but describes the constitutional monarchy. No Thermidor, Directory or Napoleon anywhere. |
| tech-180d-week-src-01 (ML) | fail | Month 1 Week 3 "Evaluation metrics and train-test splits" is Month 3's heading. Week summaries do describe a week's ground. Python/statistics instruction honoured. |
| soft-180d-week-nosrc-01 (Spanish) | minor | Week 1 is a near copy of Month 1's summary. Week 3 calls ser and estar "regular present-tense verbs"; they are irregular. Months are organised by situation, grammar appears once. |
| exam-90d-day-nosrc-01 (driving theory) | fail | Week 1 Days 4–6 (traffic lights, parking signs, horn use) are exactly Week 3's summary. Ends with mock tests, as it should. |
| body-30d-week-nosrc-01 (Couch to 5K) | fail | No week says what a session is (run/walk intervals, minutes, sessions per week). Week 4 has the learner running "multiple 5K distances" on day 23–30 from the couch, with no caveat. |
| creative-14d-day-nosrc-01 (watercolor) | minor | Progressive and distinct overall. Day 4 (washes, glazing), Day 6 (glazing) and Day 7 (washes) overlap. Animals on Day 12 and a scene "with figures" on Day 14 are too much for a beginner's two weeks. |
| tech-30d-day-offtopic-01 (SQL) | minor | Stays on topic, ignores both sources. Day 3 and Day 4 both teach ROW_NUMBER. |
| tech-7d-day-inject-01 (Git) | ok | No leak, 7 units. |
| soft-30d-day-inject-01 (cooking) | ok | No leak, counts exact. Hands-on days. |
| soft-30d-day-constraint-01 (meditation) | minor | Constraint honoured (no apps, no video, ten minutes, sitting). Week 4 says "consolidate ten days of learning"; it is 22. |
| tech-3d-day-nosrc-01 (Vim) | minor | Three distinct days, but titled "Vim Fundamentals / Intermediate / Advanced": generic tiers rather than lessons. |

### Drafts, Mandarin

| Record | Verdict | Note |
|---|---|---|
| tech-7d-day-nosrc-01-zh | ok | Chinese, concrete. Day 7 packs optimisation, Unicode and three languages' dialects. |
| soft-7d-day-src-01-zh | minor | One practice day of seven (Day 7, record and review). Day 4 says "根据参考视频核心观点" — the model only sees the video's title. |
| tech-30d-day-nosrc-01-zh | fail | Week 1 Days 4–6 (kube-proxy, CoreDNS, NodePort/LoadBalancer) are Week 2's summary almost word for word. The Week 1 and Week 2 headings overlap too. 52% CJK because of legitimate English terms (Pod, Service, CNI). |
| soft-30d-day-src-01-zh | fail | Week 2 is investing, Week 3 is budgeting, emergency fund and debt: dependency order reversed. Week 1 again entirely psychology. |
| tech-180d-day-src-01-zh | fail | **Entirely English.** Also Week 1 Days 3–7 teach moves, Copy, clone and borrowing, which are Weeks 2–4. |
| soft-180d-day-nosrc-01-zh (明朝) | minor | Chronological apart from a thematic culture month between the mid-Ming crisis and the fall. Week 1 Days 5–6 overlap Week 2. Day 7 and Week 4 are both "significance and evaluation" filler. |
| tech-180d-week-src-01-zh | minor | Chinese. Week summaries run past 100 characters. Overfitting appears in Week 1 and again as Month 3. |
| soft-180d-week-nosrc-01-zh (Spanish) | fail | **Entirely English**, for a Chinese speaker. Month 5 "professional engagement" and Month 6 "near-native comprehension" are outside travel Spanish. |
| exam-90d-day-nosrc-01-zh (科目一) | fail | Month 2 is practical driving ("汽车操作、驾驶姿势"), which is 科目二/三, not the theory exam. No mock-test phase at the end. Days 3 and 4 both classify road markings. |
| body-30d-week-nosrc-01-zh | minor | Names run/walk alternation, still no session detail. Interval and speed work in Week 3 of a beginner plan. |
| creative-14d-day-nosrc-01-zh | minor | Good progression from materials to still life to landscape. Portraits on Day 11 are ambitious. |
| tech-30d-day-offtopic-01-zh | fail | **Entirely English.** Week 1 Days 4–6 (frames, aggregates, LAG/LEAD) are the summaries of Week 2 and Week 3. |
| tech-7d-day-inject-01-zh | ok | No leak. |
| soft-30d-day-inject-01-zh | ok | No leak. |
| soft-30d-day-constraint-01-zh | ok | Constraint honoured. |
| tech-3d-day-nosrc-01-zh | ok | Chinese, three distinct days. |

### Revisions

| Record | Verdict | Note |
|---|---|---|
| rev-swap-weeks-01 | ok | Weeks 3 and 4 swapped, everything else identical. |
| rev-move-day-01 | fail | Asked: Day 3 before Day 2. Got: Day 3 and Day 1 swapped (order 3, 2, 1). |
| rev-locked-week-01 | fail | **Duplicate ids.** A new 8-day "Week 1" holds the seven completed days plus one new day, and the original Week 1 follows as Week 2 with the same seven ids. Plan is 31 days. |
| rev-shrink-month-01 | ok | Month 6 is 14 days, total 164, nothing else moved. |
| rev-swap-weeks-01-zh | fail | Asked: swap Weeks 3 and 4. Got: Weeks 2 and 4 swapped, so GPUs and quantization now come last. |
| rev-move-day-01-zh | ok | Correct. |
| rev-locked-week-01-zh | fail | Week 1 intact and not refused, but Week 2 was expanded into six days nobody asked for and the plan shrank to 29 days. A summary contains garbled text ("SM、warp 与张量核心"). |
| rev-shrink-month-01-zh | ok | Correct. |

---

## 2. Extra trials (facts only)

### 2.1 Output language, Mandarin drafts, 3 trials each

| Record | Trials fully English |
|---|---|
| soft-180d-week-nosrc-01-zh (旅行西班牙语) | 3 of 3 |
| tech-180d-day-src-01-zh (Rust) | 2 of 3 |
| tech-30d-day-offtopic-01-zh (SQL) | 2 of 3 |
| soft-180d-day-nosrc-01-zh (明朝历史) | 1 of 3 |
| body-30d-week-nosrc-01-zh (跑 5 公里) | 1 of 3 |
| the other 11 | 0 of 3 |

9 of 48 runs. A run is English or Chinese throughout, never mixed by level, because later calls see the tree from
the first call. The topic's script does not predict it: 旅行西班牙语 has no Latin letters and fails every time.
Cause: neither `buildUnitsPrompt` nor `buildRevisionPrompt` mentions output language.

For Task 4: legitimate Chinese technical plans measure 52–60% CJK (Kubernetes) and English ones 0–7%, so the
planned 60% threshold would fail good outputs. Anything between 25% and 40% separates the two groups.

### 2.2 Counts and injection

- Unit counts and spans: 63 of 64 draft runs exact. `creative-14d-day-nosrc-01-zh` trial 3 returned 6 units for 14
  days, and `reconcileSpans` turned that into a 6-day plan without an error.
- Injection: 0 leaks in 8 runs (2 Mandarin records × 3 trials, 2 English × 1), checked by searching every output for the payload.

### 2.3 Revisions, all trials

| Record | Correct | What went wrong |
|---|---|---|
| rev-swap-weeks-01 | 3 of 3 | |
| rev-swap-weeks-01-zh | 0 of 5 | Always swaps Weeks 2 and 4 |
| rev-move-day-01 | 0 of 3 | Always puts Day 3 first |
| rev-move-day-01-zh | 5 of 5 | |
| rev-shrink-month-01 (+zh) | 8 of 8 | |
| rev-locked-week-01 (+zh) | 1 of 8 acceptable | see below |

The eight locked-week runs:

| Run | Outcome |
|---|---|
| en-1 | Duplicate ids: the seven completed days appear under two weeks. 31 days. |
| en-4 | Completed Week 1 moved to Day 15–21, behind two new GPU weeks. 37 days. Ids `w3`, `w4` now carry different weeks' content. |
| en-5 | Completed Week 1 moved to Day 8–14. |
| zh-1, zh-3 | Week 1 in place. Week 2 expanded unasked, plan 29 days. |
| zh-4 | Same, plan 28 days. |
| zh-2 | `LockedNodeError` — the only acceptable outcome. |
| zh-5 | Duplicate ids: Week 1 appears twice at the top level. |

`applyRevision` only checks that every locked node still exists somewhere. It does not check that a ref is used
once, that locked nodes keep their position, or that the plan length is unchanged when nobody asked to change it.
All three are cheap to check in code, and `replacePlanTree` would be handed these trees today.

---

## 3. Failure modes

Counts are from the 32 trial-1 drafts unless stated. "Nested" means the 20 drafts that have headings.

| # | Failure mode | Count | Examples | Becomes |
|---|---|---|---|---|
| 1 | **Partition.** Planned units teach what a later sibling heading says it will teach, or two units at one level overlap, or the first child restates its parent. | 9 of 20 nested (clear); 4 more within one level | Kubernetes zh Days 4–6 = Week 2; driving Days 4–6 = Week 3; Rust Month 1 Week 3 = Month 2 | Rubric: partition |
| 2 | **Fit to the kind of topic.** Skills planned as reading, training with no load, exams with no mocks. | 5 | Public speaking: no practice day; Couch to 5K: no session detail; 科目一: no mock phase | Rubric: fit |
| 3 | **Pacing.** Ambition does not fit the days or the level; filler units. | 5 | 5K from the couch by day 23; portraits in a beginner's fortnight; "near-native" travel Spanish; 30 days on three ownership rules | Rubric: pacing |
| 4 | **Accuracy.** A statement a subject expert would mark wrong. | 4 | ser/estar "regular"; "ten days of learning" in a 30-day plan; "Republic's first years" describing the monarchy; garbled GPU terms | Rubric: accuracy |
| 5 | **Coverage and scope.** A major part missing, or material outside the topic. | 3 | French Revolution without Thermidor/Directory; 科目一 Month 2 is the practical test; travel Spanish Month 5 | Rubric: coverage |
| 6 | **Source fidelity.** A source's title bends the plan out of proportion, or the plan claims to follow content it never saw. | 3 | A week of psychology ×2; "根据参考视频核心观点" | Rubric: source fidelity |
| 7 | **Progression.** Order breaks a dependency or chronology. | 2 clear, 2 minor | Investing before budgeting (finance zh); borrowing on Day 7 before moves in Week 2 (Rust zh) | Rubric: progression |
| 8 | Output language (Mandarin in, English out) | 9 of 48 runs | §2.1 | Deterministic check + regression |
| 9 | Revision does the wrong edit | 8 of 16 runs on two records | §2.3 | Deterministic check (expected order) + regression |
| 10 | Locked content moved, duplicated, or plan length drifts | 7 of 8 runs | §2.3 | Deterministic checks + regression + code fix |
| 11 | Wrong unit count hidden by `reconcileSpans` | 1 of 64 runs | §2.2 | Deterministic check + regression |
| 12 | Label inside a title | 1 | "Week 1 Capstone: …" | Already check 5 |

Held up, so not rubric lines for now: instructions and hard constraints (9 of 9 honoured), injection (0 of 8),
off-topic sources (ignored in all 4 runs).

Against the provisional four: coverage, progression and source fidelity survive. "Depth" did not show up as one
thing; it split into fit and pacing. Partition is new and is the largest cluster. Both tree-specific candidates
from the plan were confirmed, and they turned out to be the same failure seen from two sides.

Why partition fails: when a branch is expanded, the prompt shows the sibling headings, but nothing tells the
model that their summaries are reserved ground. That is a prompt fix to try once the judge can measure it.

---

## 4. What this changes

- **Regression records:** `evals/golden/plan.v2.ts` (modes 8–11).
- **Task 4 checks to add:** unique node ids; locked nodes keep `start`/`end`; plan length unchanged unless
  `expect.totalDays` says otherwise; expected order for revise records (`expect.topOrder` / `expect.leafOrder`);
  CJK threshold 30%, not 60%.
- **Code fixes outside the eval work:** harden `applyRevision` (mode 10); state the output language in both
  prompts (mode 8); decide whether a short unit list should be an error rather than a shorter plan (mode 11).
- **Rubric:** `evals/rubric.md`, seven binary dimensions for drafts. Revisions need no judge yet: every failure
  seen was checkable in code.
