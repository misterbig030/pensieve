# Research eval: arm A against arms C and W

Compares the research step that ships (arm A: our `webSearch` and `fetchSource` tools in a bounded loop) with
Anthropic's server-side `web_search` and `web_fetch` tools (arm C), with the same model, verification gate, drafting
code and judges. Spec: `docs/superpowers/specs/2026-09-28-research-materials-design.md`.

| File | What it is |
|---|---|
| `golden.v3.ts` | Briefs with optional `expectedBackbone` and `mustInclude` labels. Review the labels before a full run. |
| `providerArm.ts` | Arm C. `route: "gateway"` by default; `--route direct` calls Anthropic with `ANTHROPIC_API_KEY`. |
| `metrics.ts` | Verified rate, backbone hit, `mustInclude` recall, recency, code-check counts, cost, latency, tool calls, and the decision rule. |
| `compare.ts` | The runner. |
| `../../lib/ai/research/workers.ts` | Arm W, in the app, behind `RESEARCH_ARM=workers`. |
| `../rubric.md` §8 | "Materials fit", the rubric dimension the research build adds for the judges. |

## Running

```bash
# 1. Measure one record through both arms, once. Report the cost before going further.
npx tsx evals/research/compare.ts --first

# 2. Only after that number is approved: the whole set, three runs per record per arm.
npx tsx evals/research/compare.ts --full --runs 3
```

Environment (`.env.local`): `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY` (arm A), and `ANTHROPIC_API_KEY` for
`--route direct`. Results go to `evals/results/` (gitignored) with each run's materials, dropped candidates, plan and
code-check facts, ready for the rubric judges.

## Still to settle on the first run

- Whether provider-executed tools pass through the AI Gateway. If arm C stops at once with `stoppedBy:
  "search-error"`, rerun with `--route direct`.
- The title-match threshold (`TITLE_MATCH_THRESHOLD` in `lib/ai/research/verify.ts`, 0.6 for now): read the
  dropped candidates whose reason starts "title doesn't match" and move it if good pages are being refused.

## Study hours and the time split (Oct 4)

Records may set `hoursPerWeek`; left out, a record runs at six, as the app does. Research is given the plan's total
hours as a ceiling and returns each material with a size, and the drafter decides how time divides between reading
and practice. Each run now records:

- `sizedHours` against `totalHours`, `measuredShare` (sizes code measured from a runtime, a page count or the
  page's own length, against the model's estimates) and `unsizedShare`;
- `coverage`: how many of the topic's main areas research named as covered and as left open;
- `split`: the drafter's reading share, what the rest is spent on, and its reason, for the judges to score under
  rubric dimension 5 (fit to the kind of topic);
- `overShareLeaves`: units whose must-reading ran well past the plan's own share.

Four records at the end of `golden.v3.ts` exist for this: three hours a week, thirty hours a week, a history topic
with nothing to build, and physical training.

## Arm W: one worker per direction (Oct 12)

Arm W reads the learner's links in code, then runs a backbone worker (a loop of three or four steps), a canonical
worker and a current worker (two steps each) at the same time under one deadline at three quarters of the band's
clock, and merges their notes into the same candidate step and gate. Spec:
`docs/superpowers/specs/2026-10-09-research-workers-design.md`. It ships behind `RESEARCH_ARM=workers`.

```bash
npx tsx evals/research/compare.ts --first --arms A,W          # cost and latency of one record; report before going on
npx tsx evals/research/compare.ts --full --runs 3 --arms A,W  # the whole set, once that cost is approved
```

Each run records `workers` (per worker: steps, searches, reads, how it stopped, duration, cost) and `duplicateShare`
(distinct search-result URLs more than one worker saw, over all distinct ones). The summary adds the median latency.

**Pre-registered rule** (`decideWorkers` in `metrics.ts`): adopt arm W as the default if, over the full set, its median
latency is at most 0.7 × arm A's, `backboneHit` and `mustIncludeRecall` are each within five points of arm A's, and
cost per run is at most 1.8 × arm A's. If latency passes and quality does not, read the backbone worker's transcripts
first (the publisher-page step cut off, or a recommending page dropped by the books-only boundary) and adjust the
brief, not the shape. If `duplicateShare` is high, tighten the boundaries before touching budgets.
