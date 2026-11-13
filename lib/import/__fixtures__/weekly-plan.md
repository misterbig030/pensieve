# Weekly Plan, Nov 10, 2026 → Jan 3, 2027 (8 weeks)

Written 2026-11-10. It replaces the August 18-week plan (now in `archive/weekly-plan-2026-08.md` together with
the Nov 10 status check). It still uses `leetcode-plan.md` rules 1–5, `career-brief.md` integrity rules, and
`position_analysis.md` for per-company fit.

**Target.** Senior Software Engineer on an AI product, at a startup or big tech. Eval engineering (product evals, eval
platform/infra) is the first lane. Senior SWE on AI learning products is the second.

**Shape of the next 8 weeks.**

| Phase | Dates | What happens |
|---|---|---|
| Prove it | Nov 10 – Nov 29 | Pensieve feature freeze; make the eval story checkable; resume and narratives. LeetCode daily. System-design drills from zero |
| Apply | Dec 1 – Dec 20 | Three application batches. Mocks every week. LeetCode and drills continue |
| Holiday | Dec 21 – Jan 3 | Hiring slows down. Interview prep for anything booked; January plan |

**Weekly budget, about 13 h:** LeetCode 1 problem/day (~5 h) · system design 2 drills (~3 h) · pensieve or
applications (~5 h). Pensieve gets **no hours beyond its line**. In October it took nearly all of them.

---

## Where you start (2026-11-10)

- **Pensieve.** The eval and benchmark work is deeper than planned, but nothing about it can be verified yet. It isn't
  in CI. The judge calibration files are ungraded, so every judged number reads `(unchecked)`. Each benchmark run
  used one test case, so the reports give no verdict. The results sit gitignored in
  `.claude/worktrees/model-benchmark/`. There's no deploy, and the README is boilerplate. Temporal, critic, MCP and
  Langfuse are cut.
- **Reading.** Huyen *AI Engineering* is finished. No more books before applying.
- **LeetCode.** NeetCode 150 at 50/150, through Trees. Heap, Backtracking, Graphs, DP, Intervals, Greedy and Tries
  are all at 0%.
- **System design.** No drills done yet. Starts from zero this week.

**Why evals.** The ML-credential bar is low: no PhD, training or kernels. But the coding and system-design loop is
the company's standard one, and eval roles add a statistics and measurement bar (CIs, judge calibration, pairwise vs
pointwise, IR metrics). Choose evals because pensieve's evidence fits them, not because they're easy.

---

## Week 1 · Nov 10–15 · freeze + calibrate + Heap + framework

- **Pensieve (5 h).**
  1. Merge or close the open branches (`allocate-keeps-units`, `judge-view-sections`, `aieng-fixture`). Feature
     freeze from here.
  2. Copy `benchmarks/results/` and `benchmarks/calibration/` out of the `model-benchmark` worktree into the main
     checkout, so a worktree cleanup can't delete them.
  3. Grade the outline calibration files, then `--calibrate` and grade allocate. Goal: every judge criterion reaches
     "checked" (≥8/10 agreement with both classes present). Rewrite any criterion the judge keeps getting wrong.
- **LeetCode, Heap (7):** 703, 1046, 973, 215, 621, 355, 295.
- **System design.** Read the framework once: Alex Xu vol. 1, ch. 1–3 (scaling from zero, back-of-envelope, the
  4-step framework). Drill 1: **rate limiter**, 45 min cold on paper, then compare with ch. 4 and write a one-page
  note of what you missed.
- ✅ Exit: open branches closed; results saved; judge agreement measured per criterion; 7 heap problems.

## Week 2 · Nov 16–22 · 基准测试 + CI

- **Pensieve (5 h).**
  1. One multi-fixture benchmark round: 3–4 topics including a Chinese one, the top 3 contestants, 3 epochs, a cap
     around $25. You want one verdict with intervals, such as which outline levels can move off Opus and what that
     saves.
  2. CI tier: GitHub Actions runs `vitest` plus the code-only checks on committed fixtures through the existing
     mock-model replay, with no paid calls. Paid judge rounds stay on demand; be able to explain why.
- **LeetCode, Backtracking + Tries (8):** 78, 39, 46, 90, 79, 131 · 208, 211.
- **System design.** Drill 2: **key-value store** (consistent hashing, replication, quorum; vol. 1 ch. 5–6). Drill 3:
  **notification system** (vol. 1 ch. 10). Your Kafka and outbox work maps directly onto this one.
- ✅ Exit: a benchmark verdict with intervals; CI green on GitHub; 8 problems; 3 drills total.

## Week 3 · Nov 23–29 (Thanksgiving) · publish + resume + narratives

- **Pensieve (4 h, the last build week).**
  1. Commit `docs/evals/` with one benchmark report, one draft-eval summary, and `methodology.md`. Its arc: open
     coding → rubric → code vs judge split → calibration → benchmark (intervals, pass^k, paired deltas) → decision.
  2. Finish the README checklist (prod migrations, first deploy, BYOK check) and deploy. Rewrite the README so it
     opens with what pensieve is, an architecture sketch and the eval numbers.
  3. Record a 2-minute Loom. It can slip to Week 4.
- **Resume + narratives (3 h).**
  - Rewrite the resume with pensieve's eval work as the lead project, then the SAP verification queries and drift
    detector, then migration scale. Follow the career-brief integrity rules.
  - Re-copy the CV to `~/projects/ai-job-search/documents/cv/`. Update LinkedIn.
  - Write a 90-second "my AI experience" answer and five STAR stories: drift detector, migration waves, HANA
    scale-out cutover, Multi-Tier ASN, pensieve judge calibration.
- **LeetCode, Graphs as timed redos (7, 25 min each):** 200, 133, 207, 210, 417, 994, 684.
- **System design.** Drill 4: **news feed** (vol. 1 ch. 11). Drill 5, the first eval one: **design an LLM eval
  platform** that runs thousands of evals per model checkpoint (dataset versioning, scheduling, judge pool, caching,
  regression gating, cost). It is the xAI / Fireworks / Thinking Machines question.
- **Book mocks** for Weeks 4–6 (interviewing.io or peers): 1 coding, 1 classic SD, 1 eval/AI SD, 1 behavioral.
- ✅ Exit: public URL + README + `docs/evals/`; resume final and copied; narratives written; mocks booked.

## Week 4 · Nov 30 – Dec 6 · Batch 1 out

- **Applications, Batch 1 (Tue Dec 1).** Warm-up and startup evals roles first, so the first recruiter calls are
  practice:
  - xAI SE Evals, plus the Exceptional SE door that names evals as the target
  - Turing, Senior SWE AI Evaluation Infrastructure
  - Handshake, MTS Evals
  - Mercor, MTS Enterprise Evals Platform
  - Fireworks, MTS Evals Platform
  - Surge, SWE Coding Evaluation (remote)
  - One or two AI-learning backend roles (Quizlet Sr Backend, Speak Backend/Full-stack)
- **Mock:** coding.
- **LeetCode, 1-D DP (8):** 70, 198, 213, 322, 300, 139, 91, 416.
- **System design.** Drill 6: **distributed message queue** (vol. 2). Drill 7: **product evals for an AI answer
  engine**: define quality (relevance, factuality, citation support, coverage), sources of data (production samples,
  synthetic, past failures), code checks vs judge, judge calibration, offline vs online, regression gates.
- **Pensieve:** maintenance only. Fix whatever a reviewer would hit in the demo.
- ✅ Exit: 8–10 applications sent; first mock done and its feedback logged.

## Week 5 · Dec 7–13 · Batch 2: top targets

- **Applications, Batch 2 (Mon Dec 7).** Before each one, add the company to `position_analysis.md` (or run
  `/apply` in ai-job-search):
  - OpenAI: Product Evals Engineer, ChatGPT Learning, and SWE Native Learning Experiences
  - Glean: AI Engineer, Data and Evals
  - Perplexity: MTS Answer Quality & Evals, and MTS Enterprise Agent Evals
  - Thinking Machines: SWE Evaluation Platform / Infra
  - Waymo: Senior SWE Quantitative Evaluations, and ML/Eval Data Platforms
- **Mock:** classic system design.
- **LeetCode, Intervals + Greedy (7):** 56, 57, 435, 253 · 55, 45, 134.
- **System design.** Drill 8: **ad-click event aggregation** (vol. 2; stream processing, exactly-once, your Spark
  work). Drill 9: **customer-support agent with RAG**: retrieval, tools, guardrails, evals, cost (B4's chatbot/RAG
  chapters, or your own notes).
- ✅ Exit: Batch 2 sent; position_analysis sections written for each.

## Week 6 · Dec 14–20 · Batch 3 + interview mode

- **Applications, Batch 3.** Run `python3 job_scan.py --keyword eval,quality --titles --remote` and apply to what's new.
  Reach roles (Anthropic Safeguards Evals, Harvey, Cohere) go through referrals only. Follow up on Batch 1.
- **Mocks:** eval/AI system design + behavioral.
- **LeetCode, 2-D DP + Dijkstra (7):** 62, 1143, 72 · 743 · 3 timed redos of problems that took more than 2 tries.
- **System design.** Drill 10: **payment system** (idempotency, reconciliation; the migration dual-source
  reconciliation story). Drill 11: **trace capture + online monitoring for an LLM feature** (sampling production
  traffic, drift alerts, replay).
- ✅ Exit: 25+ applications total; all 4 mocks done; 11 drills done.

## Week 7 · Dec 21–27 (holiday, light)

- Prep for any booked screens with company-tagged problems (`leetcode-plan.md` rule 4).
- Otherwise: redo the two weakest drills at 45 min; LeetCode stays at 1/day as redos.
- ✅ Exit: the streak holds.

## Week 8 · Dec 28 – Jan 3

- Mock mode: 3–4 random Mediums cold, 25-minute timer.
- Retrospective: response rate per batch, which resume lines got callbacks, weak topics. Write the January plan
  (more batches, onsite prep, maybe the deferred pensieve phases if an agent-infra role asks for them).
- ✅ Exit: January plan written.

---

## Eval-interview prep (ongoing from Week 3)

- **Stats to explain without notes:**
  - a confidence interval for a pass rate (binomial or bootstrap)
  - paired vs unpaired comparison
  - why pass^k
  - why raw judge agreement misleads under class imbalance (Cohen's kappa)
  - the sample size needed to detect a 5-point change
- **Two grading examples from pensieve,** one code check and one judge criterion, and where each one fails.
- **One story about a judge you didn't trust** (from the Week 1 calibration) and what you changed.

## Rules

1. **Priority:** daily LeetCode > system-design drills > pensieve proof tasks > everything else. Pensieve gets its
   hours and no more. A new feature idea goes in a list for January.
2. **Applications start Dec 1 regardless.** If a pensieve task slips, apply anyway and finish it in the background.
   A README is enough to start.
3. **Drills are timed and cold:** 45 minutes on paper before reading the solution, then a one-page note.
4. Re-scan postings weekly (`job_scan.py --group all --keyword eval,quality --titles --remote`). Postings close, so
   re-check a link before applying.
5. Deferred until after applications, only if a target role asks: Temporal durable pipeline, critic loop, MCP
   server, OTel/Langfuse tracing.
