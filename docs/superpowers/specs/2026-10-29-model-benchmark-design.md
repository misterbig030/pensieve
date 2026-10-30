# Model benchmark: which gateway models can do Pensieve's jobs, and at what cost

Status: draft for approval. Adds a benchmark framework under `benchmarks/`, separate from the evals, and one change to
how reasoning effort reaches non-Anthropic models. The first topic is `sde`, used to prove the framework, not to pick
models for good.

## Why

Users without their own key run on the app's gateway key, and the defaults are the expensive end of the catalogue
(Opus 5.5 for outline and allocation, Sonnet 5.5 for research). To offer the app to those users, the owner needs to know
which cheaper gateway models hold up against those defaults, role by role, and what a draft costs on each. The second
answer feeds the pricing work (free monthly credits, then a premium tier), which is a separate project.

An eval and a benchmark ask different questions *(owner's framing)*:

| | Eval (`evals/draft/`) | Benchmark (this) |
|---|---|---|
| Question | Does the app do what it should, today? | How good is model X at this job, against the baseline, per dollar? |
| Varies | The code (commits) | The model behind one role |
| Result | Pass/fail against a bar the owner set | A graded score with an error bar, a cost and a latency, per contestant |
| Outside failures | Count against the run | Void the sample; it is re-run |

## What other benchmarks do, and what we take

| System | How it is built | How it scores | Taken here |
|---|---|---|---|
| [Inspect AI](https://inspect.aisi.org.uk/scorers.html) (UK AISI) | Task = dataset + solver + scorer; `epochs` repeat each sample | Reducers fold epochs (mean, mode, `pass_at_k`); metrics report accuracy with stderr, [clustered](https://inspect.aisi.org.uk/metrics.html) by group if asked | The shape: task × contestant × epoch → sample → scorer → reducer → metric |
| [HealthBench](https://arxiv.org/abs/2505.08775) (OpenAI) | A rubric per example, 48k criteria written by physicians | Each criterion weighted −10…+10; a judge marks each met/unmet on its own; score = met points ÷ positive points; the mean over examples is clipped to [0, 1] | Weighted binary criteria, negative weights for harms, the same formula |
| [PaperBench](https://arxiv.org/abs/2504.01848) (OpenAI) | A rubric tree; leaves are binary and small enough to check quickly | A parent is the weighted mean of its children; the judge is checked against human grades (JudgeEval, F1 0.83) before it is trusted | Criteria grouped into a tree; the judge calibrated against the owner's grades |
| [τ-bench](https://arxiv.org/abs/2406.12045) (Sierra) | Agent tasks graded by the end state, not the path | `pass^k`: chance all k tries succeed, next to pass@1 | `pass^k` for reliability: a user sees one draft, not the best of three |
| [Adding error bars to evals](https://arxiv.org/abs/2411.00640) (Anthropic) | — | Clustered standard errors; compare models by paired differences on the same questions | Every contestant runs the same frozen inputs; we report the paired difference from the baseline with a 95% interval |
| [Arena-Hard-Auto](https://arxiv.org/abs/2406.11939), [LC AlpacaEval](https://arxiv.org/abs/2404.04475) | Pairwise judging against a baseline answer | Win rate, with position swapping and length/style control; rankings shift when the baseline changes | Not the headline. We keep the lesson: judges are biased by length, style and position, so the judge sees plans rendered the same way and never the model's name |
| [Artificial Analysis](https://artificialanalysis.ai/methodology) | An index of ten evaluations | Reports the cost to run the index next to the score, from real token use | Cost per sample from the gateway's own figures, and a score-vs-cost chart |
| [HELM](https://arxiv.org/abs/2211.09110) (Stanford) | Many metrics per scenario | Mean win rate across scenarios, since criticised as gameable | Not taken: one aggregate over unlike tasks hides the trade-offs |
| [promptfoo](https://www.promptfoo.dev/docs/configuration/expected-outputs/) | Assertions per test case | Weighted mean of assertions; a test passes above a threshold | Same as the HealthBench formula; nothing extra |

Anthropic's [agent-evals guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) points the same
way: code graders where code can decide, model graders for the rest, and read transcripts to check the graders.

## Goals

- One command scores a set of contestants on a task and writes a comparison table: quality score with a 95% interval,
  the paired difference from the baseline, completion rate, `pass^k`, cost per sample and latency.
- A contestant is a model choice for one role. Everything else stays fixed, so a difference in the score comes from that
  model.
- A saved run can be re-scored when criteria or the judge change, without calling the contestants again.
- A plain verdict per contestant and role: **qualifies**, **worse**, or **inconclusive**.

## Non-goals

- Pricing. This produces the cost per draft that pricing needs; the pricing design is its own document.
- Chat, daily content and revision roles. They become tasks later; the first version covers the draft's roles.
- Concluding which models to ship from `sde` alone. One topic tests the framework; a verdict for shipping needs more
  topics, including Chinese ones.
- Running in CI, a public leaderboard, or a human preference arena.

## Anti-goals

- A task that calls a stage differently from the app. It calls the app's own function (`allocatePlan`, the outline
  call, `researchMaterials`) with the options the draft passes, changing only the model and its effort.
- A non-Anthropic model losing because we called it wrong (its effort setting dropped, an Anthropic-only option sent),
  not because of the model.
- A judge that knows which model wrote the output.
- One number without its error bar, or a verdict the data cannot support.
- Web weather (a site's 403, Open Library down) counted against a model.
- An API key in any saved file.

## Decisions

### The pieces

- **Contestant**: a name and, for one or more roles, a model id and effort. `baseline` is today's defaults
  (`DEFAULT_MODEL_IDS` and the effort constants in `lib/ai/models.ts`). Contestants live in `benchmarks/contestants.ts`.
  A contestant model must support tool calls and structured output; the framework refuses one that doesn't.
- **Task**: one stage of the draft, a set of frozen inputs (**fixtures**), and its scorer. A task names the role it
  tests; contestants change only that role.
- **Sample**: one task × fixture × contestant × epoch. Default 3 epochs; 5 for `research`.
- **Scorer**: weighted criteria (below), a completion gate, and the reducers.

### Tasks test one stage on frozen inputs *(my call)*

A whole draft takes up to 285 s and its research reads a changing web, so two drafts differ for many reasons besides
the model. Changing one role inside that drowns its signal. So a task freezes what comes into its stage and runs only
that stage:

| Task | Role tested | Frozen input | What is scored | Live web |
|---|---|---|---|---|
| `allocate` | allocate | research's verified materials and the request | the allocation alone: split, kept and dropped materials, each one's part and minutes, coverage | no |
| `outline` | outline (top level and Week 1's days) | the allocation and split | the plan tree | no |
| `research` | research, with everything the app runs on the research model (candidate step, structure finder, item reader) | the request only | verified materials, their structure and item lists | yes |
| `draft` | a whole combination | the request only | the finished plan, as the eval scores it | yes |

`allocate` and `outline` give exact paired comparisons: every contestant sees the same input. Each task scores only its
own stage's output and calls nothing after it, so `allocate` never runs an outline: the criteria that read a plan
(reservations, overlap, Week 1's days) belong to `outline`. *(My call: running a baseline outline under every allocate
sample would double its cost and add the outline's own randomness to the allocation's score.)*

`research` cannot be frozen without replaying the web, so it gets more epochs and wider intervals. Swapping its model
swaps every call the app makes on the research model, as the app does; the structure finder is not a role of its own,
because `ModelSet` has none and the finder's tool loop chooses its own pages and searches, which no fixture can hold.
*(My call. A separate structure role would be an app change and a task with a recorded web; both wait until `research`
shows the finder is where a cheap model fails.)*

`draft` is the last check: once each role has a winner, the winning combination runs end to end through the draft
eval's path and is scored there too, since a cheap research model may hand a cheap allocate model inputs it never saw
in its own task.

Fixtures are captured from saved draft-eval runs (`evals/results/draft-*/`): `--capture <run folder>` writes each
stage's input to `benchmarks/fixtures/<topic>-<n>/`, committed, so a fixture is the same input for every future run.
The first fixtures are three baseline runs of `sde`. Order of work: `allocate` first (the costliest call on Opus, and
fully frozen), then `outline`, `research`, `draft`.

### Scoring one sample

**Completion gate.** The stage returned an output the model wrote: schema-valid, within the stage's time limit, no
error. The app's quiet fallbacks fail the gate, because the model wrote none of them: `fallbackAllocation`, and a
research source the structure finder left whole after failing or running out of steps. The time limit is the app's own
for that stage (`ALLOCATE_TIMEOUT_MS`, 90 s, for allocation; the outline's share of the draft budget for `outline`), not
the remainder a particular draft happened to leave. A model too slow for the app's limit would fail users the same way.
*(My call.)* A sample
that fails the gate scores 0 and counts against the completion rate. A sample that failed because of an outside
service (the `service` event with `ok: false` for Open Library or search, or a gateway 5xx after retries) is **void**:
it is re-run once, and reported as void if it fails again. It never scores 0. *(My call.)*

**Criteria.** Each task has a list of binary criteria, each with a weight from −10 to +10 and a group. Positive weights
for what a good output does, negative for harms (a material id in learner-facing text, a chapter reserved twice).
Graders:

- **code** where code can decide. Most of `evals/draft/checks.ts` breaks down into criteria here (backbone matches a
  label, every material reserved, no overlap, practice time served, days within ±20%, no ids in text). In the eval they
  are a pass bar; here each is a weighted point.
- **judge** for quality, from the eight dimensions in `evals/rubric.md` (partition, progression, coverage and scope,
  pacing, fit to the kind of topic, source fidelity, accuracy, materials fit), each split into binary criteria a reader
  can check in a minute or two (PaperBench's rule for leaves). The judge marks each criterion met or not with one
  sentence of reason. It judges one dimension per call, that dimension's criteria together, with the rendered output in
  a cached prefix shared by the sample's calls: about eight judge calls a sample instead of one per criterion.
  *(My call: one call per criterion would put judging at roughly ten times the contestants' spend.)*

**Sample score** = sum of the weights of met criteria ÷ sum of the positive weights (HealthBench). It can go below 0.
Groups (materials, structure, practice, quality) are reported as their own sub-scores by the same formula; the headline is
the formula over all criteria, not a mean of groups. *(My call: a group mean would let a group with two criteria count as
much as one with twenty.)*

### The judge

- One fixed judge per benchmark version, recorded in every result: `anthropic/claude-opus-5.5` at `high`. *(My call.)*
- It sees the output as the app renders it for the rubric today (`renderTree`, `renderMaterials`), never the model's
  name or raw JSON. Because every contestant's output passes through the same renderer, formatting and length tricks
  mostly fall away; this is the cheap version of Arena-Hard's style control.
- **Self-preference check.** The judge is an Anthropic model judging Anthropic baselines. Each benchmark run re-judges a
  fifth of its samples with a second judge from another provider (`openai/gpt-5.4`). The report shows where the two
  disagree by contestant; a contestant whose score depends on which judge is used is marked inconclusive. *(My call.)*
- **Unchecked until calibrated** (PaperBench's JudgeEval, small). Judge criteria count in the score from the start, but
  every judged number carries an **unchecked** label until the owner has graded a calibration set by hand: 10 samples
  across baseline and contestants, every judge criterion. A criterion loses the label once the judge agrees with the
  owner on at least 8 of 10; one that agrees less stays labelled and the report says how often they disagreed. The
  report always shows the code-only score beside the full one, so a verdict that rests on unchecked judging is visible
  as such. `--calibrate` picks the samples whenever the owner wants to do it; grades are saved in
  `benchmarks/calibration/` and re-checked when the judge or a criterion changes. *(Owner's decision: show the label,
  review later.)*
- Judgments are cached by (sample output hash, criterion id and text, judge model, effort), so a re-score only judges
  what changed.

### From samples to a verdict

Per contestant per task:

| Metric | How |
|---|---|
| Quality | Mean sample score, 95% interval. Standard errors clustered by fixture once there are several (Anthropic's paper); with one fixture, the interval only measures the model's own run-to-run spread, and the report says so. |
| Δ vs baseline | Paired: for each fixture, contestant's mean minus baseline's mean on the same fixture; mean and 95% interval. |
| Completion | Share of non-void samples that passed the gate. |
| `pass^k` | Per fixture, the unbiased estimate C(c, k) ÷ C(n, k) with c the epochs that passed the gate and scored ≥ 0.7, k = 3; mean over fixtures (τ-bench). |
| Cost | Mean USD per sample: the sum of every call's `costUsd`, the app's own list-price estimate (`estimateCostUsd`, the figure the admin panel and the eval show). It ignores cache discounts, so it errs high. |
| Latency | p50 and p90 of the stage's wall time. |

**Verdict** *(my call: the margin of 5 points is a default the owner can change with `--margin`)*:

- **qualifies**: the lower end of Δ's 95% interval is above −0.05 (non-inferior within 5 points), completion ≥ 95%,
  and cheaper per sample than the baseline;
- **worse**: the upper end of Δ's interval is below −0.05, or completion < 90%;
- **inconclusive**: anything else. The report says roughly how many more epochs or fixtures would settle it.

The report also lists the **Pareto frontier**, the contestants that no other beats on both quality and cost, so the
owner can pick a point on it rather than read a single winner.

### Provider parity: one app change

Effort reaches only Anthropic models today: `effortOptions` in `lib/ai/logged.ts` returns `{ anthropic: { effort } }`,
and `structureFinder.ts` adds Anthropic-only thinking options. On Gemini or GPT those are dropped and the model runs at
its own default, so it would be judged at a setting we never chose. Before any non-Anthropic number counts:

- `effortOptions(effort, modelId)` returns the option for the model's provider: Anthropic's `effort`; OpenAI's
  reasoning effort; Google's thinking level. Levels the provider lacks map to its nearest (`xhigh` and `max` to the
  top level). The exact option names are checked against the installed `@ai-sdk/*` docs, not memory.
- Anthropic-only options (`thinking`, `blockBinding`) are sent only to Anthropic models.
- The forced last step of the structure finder (`toolChoice` on `answer`) is checked to work on each provider in the
  contestant list; a provider where it doesn't is excluded from `research` with the reason in the report.

On Anthropic models nothing changes, so the app's behaviour and the eval's results today stay the same.

### Running it

```bash
npx tsx benchmarks/run.ts --capture evals/results/draft-<ts>-sde-1      # freeze a run's stage inputs as fixture sde-1
npx tsx benchmarks/run.ts --task allocate --fixtures sde-1,sde-2,sde-3 --contestants baseline,gemini-3-flash,gpt-5.4-mini
npx tsx benchmarks/run.ts --task allocate ... --epochs 5 --max-usd 20
npx tsx benchmarks/run.ts --rescore benchmarks/results/<ts>-allocate        # no contestant calls; judges only what changed
npx tsx benchmarks/run.ts --calibrate benchmarks/results/<ts>-allocate      # pick 10 samples for the owner to grade
```

- Before calling anything it prints an estimate in two lines, contestants (from the baseline fixtures' token counts and
  each contestant's price) and judging (judge calls per sample × samples, plus the second judge's fifth), and stops if
  the total exceeds `--max-usd` (default $10, the owner's cap), saying which of `--epochs`, `--fixtures` or
  `--contestants` to cut to fit. During the run it stops when the real spend of both passes the cap;
  samples already done are kept and scored, and unjudged ones can be judged later with `--rescore`. *(My call.)*
- Always on the app's gateway key. No database reads or writes. *(The benchmark is about the gateway route; the owner's
  stored key has nothing to say about other providers.)*
- Samples run up to 4 at a time for the frozen tasks, 1 for `research` and `draft` (Open Library's shared pace).

### What a run saves

`benchmarks/results/<ts>-<task>/`, gitignored:

| File | Contents |
|---|---|
| `run.json` | task, fixtures, contestants with models and effort, judge models, commit, cap, totals |
| `samples/<contestant>-<fixture>-<epoch>.json` | output, every model call (prompt, response, tokens, cost, latency), gate result, each criterion's verdict with evidence or judge reason |
| `scores.json` | the metrics and verdicts above |
| `report.md` | the comparison table, the verdicts, the Pareto frontier, the score breakdown below, judge disagreements, unchecked criteria, voids |

### What the report shows

The report reads top down, from the verdict to the evidence behind it *(owner asked that the final score come with its
breakdown)*:

1. **Comparison table**, one row per contestant: verdict, final score with its 95% interval, the code-only score beside
   it, Δ vs baseline with its interval, completion, `pass^3`, cost per sample, p50 and p90 latency. Judged numbers carry
   the **unchecked** label while calibration is missing.
2. **Score by group**, contestants as columns: the sub-score of each group (materials, structure, practice, quality,
   and within quality each rubric dimension), by the same formula as the final score, so the owner can see where a
   contestant loses its points.
3. **Criteria**, one row per criterion: its weight and grader, and for each contestant how often it was met across
   samples (`3/3`, `1/3`). Negative-weight criteria that were met are listed first: they are the harms.
4. **Samples**, one line each: score, gate result, cost, time, and the link to its file, where every criterion's
   verdict carries its evidence (code) or the judge's reason.
5. **Score vs cost** chart of the contestants, with the Pareto frontier drawn.

## Left to the builder

- Module layout under `benchmarks/`, and how much of `evals/draft/` (record, checks, scrubbing) is imported versus
  moved to a shared place.
- Which parts of a draft-eval record each stage's fixture needs; if the record lacks something a stage takes as input,
  extend the eval's capture rather than rebuilding it in the benchmark.
- The exact criteria, their wording and weights for each task, starting from `checks.ts` and `rubric.md`; the owner
  reviews the list before the first scored run.
- The judge prompt, the interval method (t-based or bootstrap) for small samples, and the report wording.
- Tests for the scoring formula, `pass^k`, the paired difference, the verdict rule, the cache key, and one re-score of a
  saved fixture.
