# Model benchmark

Which gateway models can do Pensieve's jobs, and at what cost. This folder is separate from the evals; the design is in
`docs/superpowers/specs/2026-10-29-model-benchmark-design.md`.

## A benchmark is not the eval

| | Eval (`evals/draft/`) | Benchmark (here) |
|---|---|---|
| Question | Does the app do what it should, today? | How good is model X at this job, against the baseline, per dollar? |
| Varies | The code (commits) | The model behind one role |
| Result | Pass/fail against a bar the owner set | A graded score with an error bar, a cost and a latency, per contestant |
| Outside failures | Count against the run | Void the sample; it is re-run once |

A benchmark runs the app's own allocation step on a frozen input (a fixture) once per contestant and epoch, scores the
result against weighted criteria (code decides what it can, a judge model the rest), and compares each contestant with
the baseline: what the app runs today. The first task is `allocate`.

**Results with one topic test the framework, not which models to ship.** The first fixtures are all `sde`; a verdict
worth shipping on needs more topics, Chinese ones included.

## Commands

Run from the repo root. Calls go through the app's gateway key (`AI_GATEWAY_API_KEY` in `.env.local`); nothing reads or
writes the database.

```bash
# Freeze draft-eval runs (evals/results/draft-<ts>-sde-<n>) as fixtures benchmarks/fixtures/sde-<n>/allocate.json.
# A folder that cannot be captured is named with the reason and the rest go on.
npx tsx benchmarks/run.ts --capture evals/results/draft-<ts>-sde-1 evals/results/draft-<ts>-sde-2

# Run a round. The baseline is always included. Defaults: --epochs 3, --max-usd 10, --margin 0.05.
# Round 1 screens every proposed candidate on one fixture; round 2 confirms the top three on all of them.
npx tsx benchmarks/run.ts --task allocate --fixtures sde-1 --epochs 2 --contestants sonnet-5.5,gpt-6.1-sol,gemini-4-argon,gpt-6.1-terra,gemini-3.8-flash,deepseek-v4-pro,haiku-5.5,gpt-6-luna
npx tsx benchmarks/run.ts --task allocate --fixtures sde-1,sde-2,sde-3 --contestants <top three> --max-usd 15

# Score a saved round again after the criteria or judge changed, and judge what a cap left unjudged.
# Asks the judge only what the cache (benchmarks/cache/judge.jsonl) lacks; contestants are not called.
npx tsx benchmarks/run.ts --rescore benchmarks/results/<ts>-allocate [--max-usd 5]

# Pick 10 judged samples for the owner to grade.
npx tsx benchmarks/run.ts --calibrate benchmarks/results/<ts>-allocate
```

Contestants are named in `benchmarks/contestants.ts`. Before calling anything a run prints its estimate (contestants,
then judging) and stops if the total is over `--max-usd`, saying whether to cut epochs, fixtures or contestants. During
the run it stops starting samples and stops judging once the real spend passes the cap; samples already done are kept and
scored, and the unjudged ones can be judged later with `--rescore`.

## What a run saves

`benchmarks/results/<ts>-<task>/` (gitignored):

| File | Contents |
|---|---|
| `run.json` | task, fixtures, contestants with their models and effort, epochs, cap, margin, judge models, commit, estimate, spend, start time |
| `samples/<contestant>-<fixture>-<epoch>.json` | the sample: gate result, output, the contestant's model calls, cost (with `estimatedCostUsd` when the call ended without usage and the cost is the fixture's baseline tokens at the contestant's price), time, each criterion's result with evidence or the judge's reason, whether it was judged, the second judge's results when it had them |
| `scores.json` | the per-contestant summaries and verdicts the report is drawn from |
| `report.md` | the comparison, score by group, criteria, samples and a link to the chart |
| `chart.svg` | score against cost per sample |

## Grading a calibration file

A judged number is labelled `(unchecked)` until the owner has checked the judge. `--calibrate` writes
`benchmarks/calibration/allocate-<ts>.json` (committed). Each item holds an `rendered` output as the judge read it and,
per judge criterion, `judge` (what the judge said) and `owner: null`.

1. Read each item's `rendered` text and each criterion's `text` in the file's `criteria`.
2. Set `owner` to `true` if the criterion holds for that output, `false` if not. A criterion that names a harm
   ("a kept material is off the topic") holds when the harm is present. Leave `null` what you cannot tell.
3. Run a report again (`--rescore`). A criterion is checked once 10 of your grades are in and the judge agreed with at
   least 8; its numbers then lose the label. Grades count only against the criterion's current text, so rewording a
   criterion starts it over.

Several calibration files add up, so a second `--calibrate` after the first is graded brings a criterion to 10 sooner.
