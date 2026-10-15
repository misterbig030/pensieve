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
| `candidates-bench.ts`, `bench.ts` | Replays one recorded candidate-step prompt on several models and effort levels; see the last section. |
| `../../lib/ai/research/workers.ts` | Arm W, in the app, behind `RESEARCH_ARM=workers`. |
| `../rubric.md` §8 | "Materials fit", the rubric dimension the research build adds for the judges. |

## Running

```bash
# 1. Measure one record through both arms, once. Report the cost before going further.
npx tsx evals/research/compare.ts --first

# 2. Only after that number is approved: the whole set, three runs per record per arm.
npx tsx evals/research/compare.ts --full --runs 3
```

Environment (`.env.local`): `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY` (arms A and W), and `ANTHROPIC_API_KEY` for
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

Each run records `workers` (per worker: steps, searches, reads, how it stopped, duration, cost), `duplicateShare`
(distinct search-result URLs more than one worker saw, over all distinct ones) and `researchMs`, the research stage
alone; the summary adds its median. The rule reads that, not the whole run's latency, because drafting time is the
same for every arm and would dilute the ratio.

**Pre-registered rule** (`decideWorkers` in `metrics.ts`): adopt arm W as the default if, over the full set, its median
research latency is at most 0.7 × arm A's, `backboneHit` and `mustIncludeRecall` are each within five points of arm
A's, and cost per run is at most 1.8 × arm A's. A check that cannot be made (no runs, or no labelled records on one
side) blocks adoption and is named in the output. If latency passes and quality does not, read the backbone worker's transcripts
first (the publisher-page step cut off, or a recommending page dropped by the books-only boundary) and adjust the
brief, not the shape. If `duplicateShare` is high, tighten the boundaries before touching budgets.

## Candidate-step bench (Oct 13)

The candidate step is one structured call. To measure it alone, replay a recorded prompt on several models at several
effort levels, with the app's schema and route, so the numbers are the app's numbers:

```bash
npx tsx evals/research/candidates-bench.ts --export ~/Downloads/model-calls-<ts>.json --dry-run   # plan and cost bound, no calls
npx tsx evals/research/candidates-bench.ts --export ~/Downloads/model-calls-<ts>.json             # the matrix
```

The export is the admin panel's model-calls JSON for one draft; the bench takes the "Research · candidates" call's
prompt verbatim and never copies it into the repo. Defaults: Haiku 5.5, Sonnet 5.5, Opus 5.5 and Sonnet 5 at `low`,
`medium` and `high`, twelve calls for well under a dollar. The table shows latency, input, output and reasoning tokens,
cost, and cheap checks on each list (candidates, backbones, total hours, URLs and recommenders the notes cannot vouch
for, retitled pages). Every list is written to `evals/results/candidates-bench-<ts>.json` for a reader to judge; the
gate and the judges, not these checks, decide quality. The first run (2026-10-13) is summarized in the arm W spec's open
items.
