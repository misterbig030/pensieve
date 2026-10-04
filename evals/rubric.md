# Plan rubric — draft 3

For the W5 judge. Eight dimensions, each **pass / fail** with a one-sentence reason. Dimensions 1–7 come from the
failure clusters in `evals/analysis/2026-09-16-open-coding.md`; every example there is a real output from that run,
made before plans carried materials. Dimension 8 comes with the research build
(`docs/superpowers/specs/2026-09-28-research-materials-design.md`).

Scope: **draft** plans. Revisions are not judged yet, because every revision failure seen so far can be checked
in code (wrong order, locked nodes moved, duplicate ids, length drift).

What the judge sees: the topic, days, working unit, instructions, the materials list as the model saw it
(`renderMaterials`: id, kind, title, author, year, `why` line, and whether it is the learner's own or research found
it), and the plan as `renderTree` text with each unit's material references after its summary (`covers M1 (ch. 1–2)`
on a heading, `reads M1 must 90 min (ch. 1); M3 should 20 min` on a leaf), and the plan's time split: the share of
study time for reading or watching, what the rest is spent on, and the drafter's one-sentence reason. Units marked `[not yet planned in detail]`
have only a title and summary; that is by design and is never a reason to fail. Judge a Chinese plan by the same
lines; do not fail it for keeping English technical terms.

Not in this rubric because code checks them: unit counts and spans, plan length, output language, labels inside
titles, injected strings, title and summary length, and the materials checks in `lib/materials.ts` (`levelFacts`:
unknown material ids, leaves without a must or over budget, must-reading well past the plan's own reading share,
backbone chapters out of order or not reserved).

---

## 1. Partition

**Pass when** every unit has its own ground: no unit teaches what a sibling or a later heading's summary says it
will teach, and a first child does not simply restate its parent.

- **Fail** — Kubernetes 网络, 30 days. Week 1 Day 4 "kube-proxy 与包转发", Day 5 "DNS 服务发现与 CoreDNS", Day 6
  "Service 类型与端口管理", while Week 2 is "Service 类型与服务发现 — … 掌握 kube-proxy 工作机制和 DNS 服务发现".
  Week 1 has already taught Week 2.
- **Pass** — Cooking fundamentals, 30 days. Week 1's days are equipment, knives, cuts, mise en place, safety,
  measuring; heat, proteins and sauces are left to Weeks 2–4 as their headings promise.

## 2. Progression

**Pass when** the order respects what depends on what: prerequisites first, chronology for history, easier
before harder for skills. A thematic unit inside a chronological plan is fine if it does not break a dependency.

- **Fail** — 个人理财入门, 30 days. Week 2 is index funds and asset allocation; Week 3 is budgeting, the emergency
  fund and debt. Investing is planned before there is money to invest.
- **Pass** — Personal finance basics, 30 days (English run). Budgeting → emergency savings and debt → investing.

## 3. Coverage and scope

**Pass when** the plan covers what a knowledgeable teacher would consider the core of the topic *as asked*, with
no major part missing and no large block outside it.

- **Fail** — 机动车驾驶证科目一考试, 90 days. Month 2 is "驾驶技能与操作规范 — 汽车操作、驾驶姿势、视野检查":
  that is the practical test, not the theory exam the learner asked about.
- **Pass** — SQL window functions, 30 days. OVER and PARTITION BY, ranking, offsets, frames, running aggregates,
  performance: the whole topic and nothing else, despite two off-topic sources.

## 4. Pacing

**Pass when** the ambition fits the days and the learner's level: no outcome that the time cannot deliver, no
unit that is filler ("significance and evaluation", "integration") standing in for content.

- **Fail** — Couch to 5K, 30 days. Week 4 (Day 23–30): "Complete multiple 5K distances with confidence". From
  the couch in three weeks, with no caveat that the usual programme is nine.
- **Pass** — Meditation for beginners, 30 days, ten minutes a day. Posture, breath, the wandering mind, a second
  anchor, a fixed time, restlessness, review: each day is small enough for ten minutes.

## 5. Fit to the kind of topic

**Pass when** the units are the right kind of work. A skill needs practice units, training needs stated load
(what a session is, how many), an exam needs timed mocks near the end, a knowledge topic needs neither.

Since the study-hours build the drafter states this as a time split, and the split is judged here: the reading
share and the named practice must suit the topic and the learner's instructions. Mostly reading is right for a
knowledge topic and wrong for a skill; "building" as the practice is wrong where there is nothing to build. A
sensible split that the units then ignore is still a fail.

- **Fail** — Public speaking, 7 days. "Foundations of Effective Speaking — Explore core principles…",
  "Understanding Your Audience — Learn how to identify…". Seven days of reading about speaking; nobody speaks.
- **Pass** — 烹饪基础, 30 days. "蔬菜处理与初级刀工 — 通过处理各类蔬菜实践基础刀工", "刀工速度与效率训练 —
  通过反复练习…建立肌肉记忆". The days are things to do at a chopping board.
- **Pass** — The French Revolution, 30 days. Split: 75% reading, the rest on writing summaries, "history requires
  sustained reading to build chronological and causal understanding". Weeks read two or three chapters and end in
  a written summary.
- **Pass** — Couch to 5K, 7 days at 3 hours a week. Split: 20% reading, the rest on running sessions.

## 6. Source fidelity

**Pass when** materials are used in proportion to how much of the topic they cover, off-topic materials are
ignored, and no unit claims content the model has not seen. The model sees each material's id, kind, title, author,
year and `why` line, never the page text; a researched material's title and `why` come from the page and the pages
that recommended it, a learner's own source has only what the learner typed. So a unit may say what a material is
for ("Ch. 4 on serving") and may not invent what it says inside.

- **Fail** — Personal finance basics, 30 days, sources *The Psychology of Money* and a Bogleheads link. All seven
  days of Week 1 are money psychology: one source title took a quarter of the plan.
- **Pass** — SQL window functions with "Beginner's guide to watercolor" and "Sourdough basics" attached. Neither
  appears anywhere in the plan.

## 7. Accuracy

**Pass when** a subject expert would find no wrong statement in the titles and summaries. Vague is not wrong;
this line is for claims that are false. Use a judge model stronger than the generator, and treat a fail here as a
flag for a human to confirm.

- **Fail** — Spanish for travel. "Introduce regular present-tense verbs (ser, estar, hablar, necesitar)": ser and
  estar are the standard examples of *irregular* verbs.
- **Pass** — Rust ownership and borrowing. "one owner per value, ownership transfer on move, and drop on scope
  exit" states the three rules correctly.

## 8. Materials fit

Scored only on plans whose leaves have Read tables (the drafting eval with the learner's materials, and the research
eval in `evals/research/`). Leaves with no Read table are not scored here; the code checks count them.

**Pass when**, for every leaf that has a Read table, every `must` row is about the leaf's topic as its title and
summary state it (a `should` row may be adjacent), and where a row is the backbone and its note names chapters,
those chapters cover the leaf's topic.

**Fail when** any leaf has a `must` row that teaches something else, or a backbone chapter that does not match the
leaf's ground.

What the judge gets for this line: the leaf's label, title and summary; its rows as `tier · title · minutes · note`;
each material's `why` line and kind; for the backbone, its title and author. Never fetched page text.

- **Pass** — Week 3 "Evaluation methodology" reads *AI Engineering* (must, ch. 3) and *Your AI Product Needs Evals*
  (must, whole essay).
- **Fail** — Week 3 "Evaluation methodology" reads *AI Engineering* (must, ch. 7 on finetuning).
- **Fail** — Day 4 "Window functions: ROW_NUMBER and RANK" has a must row for a video on database indexing.

Why it exists: accuracy, coverage and source fidelity judge the plan's text; this line judges whether the reading
behind each unit is the right reading.

---

## Watched, not judged

These held up in every sample, so they are not rubric lines yet. Promote one if it starts failing.

- Instructions and hard constraints honoured (9 of 9).
- Titles are lessons, not tiers ("Vim Fundamentals / Intermediate / Advanced" was the only weak case).
