# Rubric dimension: Materials fit

Add this dimension to the rubric the judges score (`evals/rubric.md`). It is binary, like the others, and is scored
per plan from the plan tree and its materials list as `compare.ts` writes them.

**Question.** Do each leaf's assigned materials teach that leaf's topic, and do the backbone chapters named in its
notes match what the leaf covers?

**Pass** when both hold for every leaf that has a Read table:

- every `must` row is about the leaf's topic as its title and summary state it (a `should` row may be adjacent);
- where a row is the backbone and its note names chapters, those chapters cover the leaf's topic.

**Fail** when any leaf has a `must` row that teaches something else, or a backbone chapter that does not match the
leaf's ground. Leaves with no Read table are not scored here (the code checks count them).

**Judge input.** The leaf's label, title and summary; its rows as `tier · title · minutes · note`; the material's
`why` line and kind; for the backbone, its title and author. Do not give the judge fetched page text.

**Examples.**

- Pass: Week 3 "Evaluation methodology" reads *AI Engineering* (must, ch. 3) and *Your AI Product Needs Evals*
  (must, whole essay).
- Fail: Week 3 "Evaluation methodology" reads *AI Engineering* (must, ch. 7 on finetuning).
- Fail: Day 4 "Window functions: ROW_NUMBER and RANK" has a must row for a video on database indexing.

**Why it exists.** The research build (spec `docs/superpowers/specs/2026-09-28-research-materials-design.md`) lets
the plan name real material. Accuracy, coverage and source fidelity judge the plan's text; this dimension judges
whether the reading behind each unit is the right reading.
