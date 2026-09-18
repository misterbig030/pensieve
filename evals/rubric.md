# Plan rubric — draft 1

For the W5 judge. Seven dimensions, each **pass / fail** with a one-sentence reason. They come from the failure
clusters in `evals/analysis/2026-09-16-open-coding.md`; every example below is a real output from that run.

Scope: **draft** plans. Revisions are not judged yet, because every revision failure seen so far can be checked
in code (wrong order, locked nodes moved, duplicate ids, length drift).

What the judge sees: the topic, days, working unit, instructions, source titles, and the plan as `renderTree`
text. Units marked `[not yet planned in detail]` have only a title and summary; that is by design and is never a
reason to fail. Judge a Chinese plan by the same lines; do not fail it for keeping English technical terms.

Not in this rubric because code checks them: unit counts and spans, plan length, output language, labels inside
titles, injected strings, title and summary length.

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

- **Fail** — Public speaking, 7 days. "Foundations of Effective Speaking — Explore core principles…",
  "Understanding Your Audience — Learn how to identify…". Seven days of reading about speaking; nobody speaks.
- **Pass** — 烹饪基础, 30 days. "蔬菜处理与初级刀工 — 通过处理各类蔬菜实践基础刀工", "刀工速度与效率训练 —
  通过反复练习…建立肌肉记忆". The days are things to do at a chopping board.

## 6. Source fidelity

**Pass when** sources are used in proportion to how much of the topic they cover, off-topic sources are ignored,
and the plan does not claim to follow content it has not seen (only titles and URLs are given to the model).

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

---

## Watched, not judged

These held up in every sample, so they are not rubric lines yet. Promote one if it starts failing.

- Instructions and hard constraints honoured (9 of 9).
- Titles are lessons, not tiers ("Vim Fundamentals / Intermediate / Advanced" was the only weak case).
