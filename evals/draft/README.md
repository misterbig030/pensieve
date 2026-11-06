# Draft eval

Runs the app's researched draft (the same input the draft route streams, built by `researchedDraftInput`) for a topic
whose right answers are known, saves everything the run did, and checks the plan in code. It spends real money, about
$1 to $2 a run, so run it on demand; nothing here runs in CI.

## Running

```bash
npx tsx evals/draft/run.ts --topic sde                  # three runs, one at a time, on the app's gateway key
npx tsx evals/draft/run.ts --topic sde --runs 1         # one run
npx tsx evals/draft/run.ts --topic sde --parallel 2     # at most two at once
npx tsx evals/draft/run.ts --topic sde --key user       # on the stored key of EVAL_USER_ID
npx tsx evals/draft/run.ts --rescore evals/results/draft-<ts>-sde-1 evals/results/draft-<ts>-sde-2   # no calls, no cost
```

| Flag | Meaning |
|---|---|
| `--topic <id>` | Required. A key of `DRAFT_TOPICS` in `topics.ts`: `sde`, plus ten from the research golden set chosen to reach every plan shape (`csapp`, `finance`, `sqlwin`, `c25k`, `mle`, `aieng`, `deeplearning`, `aieng-daily`, `ml-daily`, `frenchrev`). |
| `--runs N` | Runs in the round; default 3. |
| `--parallel 1\|2` | Runs at once; default 1. |
| `--key app\|user` | `app` (default) uses the app's gateway key. `user` resolves the models from the stored key of the user in `EVAL_USER_ID`, reads the database, and records nothing back. |
| `--rescore <dir…>` | Reads saved folders, runs the current checks, rewrites each `report.md` and `run.json`'s `result`, and writes a new summary beside the first folder. |

Environment (`.env.local`): `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`; with `--key user` also `EVAL_USER_ID` and `DATABASE_URL`.
The default route never connects to the database. A run that fails part-way is still saved and scored; the round goes on.

A run ends with one line, for example `run 1: pass 5/6 · 212 s · $1.31` (`fail` when any criterion fails; n/a criteria are not counted).

## Output

Everything goes to `evals/results/` (gitignored). Each run has a folder `draft-<timestamp>-<topic>-<n>/`:

| File | What it holds |
|---|---|
| `report.md` | Header (topic, run, commit, key, time, cost by stage), each criterion with its evidence, warnings. Start here. |
| `run.json` | `meta` (models, commit, cost, time) and, once scored, `result` (verdicts, warnings, passed). |
| `events.ndjson` | The whole event stream, one line per event with milliseconds since the start: stream events, model calls, failed service attempts. |
| `calls.json` | Every model call with its prompt, raw response, cost and facts. |
| `materials.json` | What research verified, the allocation kept, what was dropped, coverage. |
| `plan.json` | The split and the finished plan. |

Keys and the Open Library contact are scrubbed from every file. The round's `draft-<timestamp>-<topic>-summary.md`
has the pass count per criterion (for example `2/3`), unscorable runs with their error, warning counts, and the median
time and cost. A rescore writes `draft-<timestamp>-rescore-summary.md`.

## The six criteria

1. **Backbone**: the allocated backbone is one of the topic's labelled books, by title and author.
2. **Named practice list**: a read LeetCode/NeetCode list carries the problem-set time and the first drafted units name its problems, none twice.
3. **Reservations add up**: every material is reserved by some top-level unit (a heading's covers, a leaf's own rows), nothing with chapters twice, and the first drafted units use only their heading's reservation.
4. **Outside services**: no outside call gave up, no Open Library read failed, and the stream did not error.
5. **Practice time served**: every picked format that needs a source has one, and served formats get at least half their share of practice time.
6. **First drafted units**: the first drafted leaves fit their minutes, no text shows a material id, and nothing with chapters is used twice.

The checks read every plan shape. The top level holds the reservations whatever its level, and the "first drafted
units" are the first run of leaves: Week 1's days, Month 1's weeks, Month 1 · Week 1's days, or the top level itself
when its units are leaves (a one-week plan of days, a plan of week leaves). A day's minutes are its share of the week;
a week leaf's are its own hours. As the leaf rules in `lib/ai/planPrompt.ts` allow, a chapter may run across
consecutive leaves when each names its part in a note; a heading reserves each chapter once.

Warnings do not fail a run: expected books missing, drop reasons, refused page reads, sizing slips, cost or time over
the limit, and retries. Criteria that need labels the topic lacks score n/a.
