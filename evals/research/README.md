# Research eval: arm A against arm C

Compares the research step that ships (arm A: our `webSearch` and `fetchSource` tools in a bounded loop) with
Anthropic's server-side `web_search` and `web_fetch` tools (arm C), with the same model, verification gate, drafting
code and judges. Spec: `docs/superpowers/specs/2026-09-28-research-materials-design.md`.

| File | What it is |
|---|---|
| `golden.v3.ts` | Briefs with optional `expectedBackbone` and `mustInclude` labels. Review the labels before a full run. |
| `providerArm.ts` | Arm C. `route: "gateway"` by default; `--route direct` calls Anthropic with `ANTHROPIC_API_KEY`. |
| `metrics.ts` | Verified rate, backbone hit, `mustInclude` recall, recency, code-check counts, cost, latency, tool calls, and the decision rule. |
| `compare.ts` | The runner. |
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
