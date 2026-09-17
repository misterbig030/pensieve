# Case study: an AI-assisted study-planning session (Aug 10–12, 2026)

This documents a real three-day conversation between Junting (the user) and an AI agent
(Claude Code) that produced a 4-month learning plan for applied-AI job interview prep.
It is preserved here because **the session is a live specimen of exactly what Pensieve wants
to be**: a system that creates a learning topic, generates a plan, and then *adjusts it through
dialogue*. Every friction point and every move that worked is a design input.

Artifacts produced (in `~/projects/jobhunting/`): `prep-plan.md` (4-month track overview),
`weekly-plan.md` (18 weeks, materials list + weekly exit criteria), `leetcode-plan.md`
(two-tier problem schedule). Pensieve itself was chosen as the hands-on portfolio project.

---

## 1. How the session actually unfolded (process trace)

1. **Grounding in the user's real data.** The agent read the user's resume PDF and career
   brief before proposing anything. Later, it read the Pensieve codebase before judging its
   suitability, and browsed the user's live LeetCode history (99 solved, topic-by-topic,
   with dates) before writing the problem plan.
2. **Goal clarification via a forced choice.** "AI/ML role" was ambiguous; the agent asked
   one multiple-choice question (AI-infra/applied SDE vs. model-facing MLE) and the answer
   reshaped everything downstream (no ML math, no fine-tuning in the plan).
3. **The user challenged stale knowledge — and was right.** The agent initially recommended
   RAG + MCP projects from its training-data-era assumptions. The user pushed: *"you are
   still at 2025 era... do some research now."* Fresh web research flipped the
   recommendation (simple RAG now reads as dated; multi-agent orchestration and durable
   execution are the 2026 signals). The plan was revised without ego.
4. **Progressive elaboration on demand.** The plan was built in passes, each triggered by a
   user request: concept list → detailed plan with resources → week-by-week breakdown with
   dates → per-problem schedule. Never all at once.
5. **Plan adjusted to observed reality.** When the user said "I'm already at DDIA ch. 10,"
   the reading load was recomputed and later phases pulled earlier. When the user offered
   more capacity ("I can do 7–10 problems/week"), the agent did not simply scale up — it
   split the plan into a **protected core + conditional stretch tier**, because the user's
   own history showed the real risk was streak-breaking, not low ambition.
6. **Source transparency under questioning.** The user asked *"how do you determine these
   problems, where is your source?"* The agent disclosed its three layers: a community-
   validated list (NeetCode 150) from memory, personal-history-based pruning, and unsourced
   judgment — flagging which parts were unverified.
7. **Tool-role demystification.** Several turns clarified what each tool in the stack is
   actually *for* (NeetCode = map/videos, LeetCode = judge/history/company tags), ending
   with a minimal workflow rather than tool sprawl.

## 2. What made the plan good (properties worth replicating)

- **Personal-history-aware:** categories the user recently covered (graphs) got maintenance
  slots; genuine gaps (DP, heaps, backtracking) got full budget; stale-but-solved items
  became timed **redos** (⚡), a distinct activity type from new learning.
- **Fixed calendar, weekly exit criteria:** every week has dates and a checkable "✅ Exit"
  condition, so slippage is detected the same week, not a month later.
- **Load-aware:** hour budgets stated (~12 h/wk); a holiday week (Thanksgiving) is
  explicitly lighter; heavy topics (DP) placed after the build project winds down.
- **Slippage rules written down in advance:** what to protect, what to cut, and a hard
  "applications start W15 no matter what" deadline against perfectionism.
- **Two-tier capacity:** core (floor, protected) vs. stretch (conditional on the week's
  other milestone). Great weeks use full capacity; bad weeks don't break the plan.
- **Anti-goals stated:** what is deliberately *not* studied, with reasons.
- **Failure-mode-aware:** the user's LeetCode history showed intense topic blocks separated
  by multi-month stalls; the plan's key metric was chosen as "consecutive weeks ≥4 solved,"
  directly countering the observed pattern.
- **Just-in-time reading:** concepts scheduled the week before the phase that needs them,
  not front-loaded.

## 3. Design implications for Pensieve

Each maps to an observation above (§ references).

- **Track creation should ingest evidence, not just a topic string** (§1). Sources today
  are URLs; the highest-value "sources" in this session were *the user's own artifacts*:
  a repo, a solve history, a resume, "I'm at chapter 10." Consider source types like
  "current progress/state" and structured intake questions.
- **One sharp clarifying question beats a long form** (§2). A single forced-choice
  ("which flavor of role?") did more than any number of free-text fields. Outline
  generation could emit 1–2 multiple-choice questions before drafting.
- **Curricula about fast-moving fields need fresh research at generation time** (§3).
  Pensieve's outline prompt already tells the model to search the web if the topic is
  current — this session proves why that must be a real tool call, not a suggestion
  (the model's priors about its own field were a year stale and materially wrong).
- **Revision is the product** (§4–5). The initial plan was fine; the *value* was in five
  rounds of adjustment. Pensieve's adjust-plan flow should support: "I'm further along
  than the plan assumes," "I have more/less capacity," "justify this item," "add detail
  to this section" — each as a targeted revision, preserving completed days (already a
  Pensieve invariant).
- **Plans need exit criteria, not just content** (§2 above). An OutlineItem today has
  title + summary; a per-day or per-week *checkable completion condition* would enable
  honest streaks and early slippage detection.
- **Model transparency about sourcing builds trust** (§6). When generated content draws
  on a known curriculum/list vs. model judgment, say so — and mark unverified claims.
  Relates directly to the citation-fidelity work planned in the eval harness.
- **Two-tier day design** (§5): a "core" block plus optional "stretch" block per day would
  encode capacity flexibility without letting ambitious users overload the schedule and
  then quit. Streak logic should count core only.
- **Failure-mode personalization** (§2 above): given progress history, the system can
  detect a user's stall pattern and choose pacing/metrics accordingly. Long-term feature,
  high differentiation.

## 4. Reusable prompts/moves from the session

- *"You're operating on stale assumptions — research the current state before recommending."*
- *"Elaborate on X"* → next level of detail only for X, leaving the rest stable.
- *"Where is your source?"* → forces provenance disclosure; good default critic question.
- *"I can manage N/week — is this plan manageable and does it work best for me?"* →
  capacity renegotiation; the right response pattern is tiering, not linear scaling.
- Reality updates ("I'm already at chapter 10") → recompute downstream, pull work earlier.
