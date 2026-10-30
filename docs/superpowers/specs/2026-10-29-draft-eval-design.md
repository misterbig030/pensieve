# Draft eval: the live test, automated and checked in code

Status: draft for approval. Adds an on-demand eval of the whole draft call under `evals/draft/`, and one event to the
app's draft stream. Builds on the research eval (`evals/research/`, `evals/rubric.md`), which it does not replace.

## Why

Runs 1–12 of the structure-finder work (ledger `.superpowers/sdd/2026-10-27-structure-finder/progress.md`) were live
tests: a draft started in Chrome on a dev server, its event stream captured in the page, and the result read by hand.
They found most of the bugs fixed in PR #26, but each one cost a browser session and a reader, and the checks lived
only in that reader's head. The existing research eval does not cover the same ground:

- it calls research without the structure finder and without a deadline, so units, item lists and named problems
  never run in it;
- it has not been run since 5 Oct, before research workers, practice formats, allocation, chapters, structure and item
  lists shipped;
- the rubric's judge was never built, and a run saves only one-line facts, not the model calls or the event stream;
- it runs on the app's key only, where the forced-step 400 of runs 8–10 never showed.

The owner wants the draft call tested automatically, on demand, against a bar they set: for the senior software
engineer interview topic, (1) the backbone is DDIA or Alex Xu's *System Design Interview*, (2) the practice includes
LeetCode/NeetCode problems; for every topic, (3) the materials each week reserves add up to the pool without overlap,
(4) no call to an outside service fails.

### What the live runs found most often

1. Practice missing or unnamed (6 of 8 finished runs): count-only problem sets, a list dropped as "no answers", topic
   sections sized as 1% of practice.
2. Outside calls failing (5 runs, 3 fatal): Open Library blocking the address, Anthropic's 400 on the forced last
   step, search returning junk. Ordinary pages refusing a reader (403, script-drawn, slow) happened in almost every run
   and is normal.
3. Books dropped or mismatched: author-less catalogue matches, an edition the catalogue lacks, a wrong page linked.
4. Structure and sizes off: 1-minute units, too many units from a short essay, problems titled "Solution".
5. Plan consistency: a reservation made twice, ids leaking into text, days reading outside their week.

## Goals

- One command runs the draft exactly as the app does, N times, and writes everything it emitted to disk.
- Code decides the six criteria below from that record, with the evidence for each verdict. No model judges them.
- A saved record can be re-scored after the checks change, for free.
- A readable report per run and per round.

## Non-goals

- Running automatically (CI, nightly). On demand only, for now.
- The rubric judge for the quality lines (coverage, pacing, progression, accuracy, materials fit). The record keeps
  what it would need; building it is a later piece. *(My call: the owner approved the code criteria; the judge was
  mentioned as optional and is left out to keep this build to what code can decide.)*
- Drafting days beyond Week 1. The app drafts the top level and Week 1's days; so does the eval.
- Recording and replaying web responses. Runs make real calls; outside failures are counted, not removed.
- Replacing `evals/research/compare.ts` or the golden sets.

## Anti-goals

- An eval path that differs from the app's. It must call the same entry point with the same research options the
  route passes, or its verdicts say nothing about the app.
- Writing an API key or `OPEN_LIBRARY_CONTACT` anywhere in the record.
- A check that fails on normal web weather (a site's 403) instead of on our failures.
- Changing what the learner sees in the app.

## Decisions

### Running it

- `npx tsx evals/draft/run.ts --topic sde --runs 3` runs the named topic N times (default 3), one after another by
  default; `--parallel 2` runs two at a time. *(My call: Open Library's one pace is shared across the process, so
  parallel runs are slower than the app alone and more likely to run out of time before Week 1.)* `--rescore
  <folder>` re-runs the checks on saved runs with no calls.
- It calls `streamResearchedPlanDraft` in-process with what `app/api/plan/draft/route.ts` passes (arm, structure
  finder, deadline, models), not the HTTP route: no Clerk session, no browser.
- Key route: the app's gateway key by default; `--key user` runs on the owner's stored key, the user named by
  `EVAL_USER_ID`, resolved the way the route resolves it. *(My call: the step-6 400 only showed on a user key.)*
- The eval writes nothing to the database, on either route: no generation-log rows, and on `--key user` the key
  guard runs with recording and clearing turned off, so a refusal still becomes the same `UserKeyError` message but the
  owner's key row in Settings is untouched. It only reads (the key). *(My call: the local `DATABASE_URL` is
  production.)*
- Each run's cost and time are printed as it ends. There is no first-run gate. *(My call: the owner said cost is fine
  for now.)*

### Topics

`evals/draft/topics.ts` holds the records. The first is `sde`, with the inputs of runs 9–12:

- topic "Senior software engineer interview preparation", 8 weeks, 5 days a week, 6 hours a week, granularity day,
  no instructions, no learner materials.
- labels: backbone set {*Designing Data-Intensive Applications* (Kleppmann), *System Design Interview* (Alex Xu,
  either volume, any edition)}; practice list hosts and names {neetcode, leetcode, Blind 75}; expected books
  {DDIA, *System Design Interview*, *Cracking the Coding Interview*}.

### What one run saves

`evals/results/draft-<timestamp>-<topic>-<n>/`, gitignored:

| File | Contents |
|---|---|
| `run.json` | inputs, commit SHA, model ids and effort per role, key route; verdict and evidence per criterion; warnings; time and cost by stage |
| `events.ndjson` | every event the stream yielded, in order, each with milliseconds since start |
| `calls.json` | every model call (label, model, prompt, response, finish reason, facts, tokens, cost, latency) |
| `materials.json` | verified, allocated and dropped materials with reasons; coverage |
| `plan.json` | the final plan tree, with each week's `covers` and `practiceCovers` and Week 1's days |
| `report.md` | the verdicts and warnings in prose, with the evidence lines |

A round also writes `evals/results/draft-<timestamp>-<topic>-summary.md`: pass counts per criterion ("2/3"), warnings
and cost and time medians.

### One app change: a `service` event

Today the stream does not see every outside failure: Open Library lookups emit nothing, a structure finder's failed
model call on the app's key is logged to the console and swallowed, and a search error only sets `stoppedBy`. The app
gains one event, `{ type: "service", name: "anthropic" | "openlibrary" | "search", ok, retries, status?, reason?, ms }`,
emitted once per logical call to those three services (one model call, one lookup, one search), including calls whose
failure is swallowed or turned into a drop reason. `ok` is false only when the call ended without a usable answer: an
error after the SDK's or our own retries, a refusal, a timeout, a refused connection. A call that failed and then
recovered on retry is `ok: true` with `retries` above zero. An empty answer is a usable answer: Open Library finding no
match and a search with no results are `ok: true`. Page reads keep `research.fetch`. The UI ignores the event; nothing
the learner sees changes. *(Owner's decision.)*

### The criteria

Pass/fail, all from the record. A run passes when all applicable criteria pass. Each verdict lists its evidence (the
ids, titles, weeks or events behind it). A draft that ends before Week 1's days exist fails every criterion that reads
Week 1 (2, 3 and 6), with "Week 1 not drafted" as the evidence: the app would show the learner no days either.
*(Owner's decision.)*

| # | Applies to | Passes when |
|---|---|---|
| 1 | sde | the allocated backbone matches the label's backbone set by title and author |
| 2 | sde | a problem-set material carries an item list that was read (its URL, or the page or file it came from, is in a successful `research.fetch` or the item reader's reads) and that is LeetCode/NeetCode by host, repository name or item links; the plan's problem-set time comes from it; at least three of Week 1's five days have a practice row naming one of its items by title, and no item repeats within Week 1 |
| 3 | every topic | every allocated material is reserved by some week (`covers` or `practiceCovers`); no chapter, unit or item range is reserved by two weeks; Week 1's days use only what Week 1 reserves. Overlap is checked only where there is structure to overlap: a material with no chapters or units may be covered whole by several weeks, a practice source with no item list may appear in several weeks, and generated practice (`id: null`) is exempt. *(My call.)* |
| 4 | every topic | no `service` event has `ok: false` and the stream has no `error` event. Recovered retries do not fail it; they are a warning |
| 5 | every topic | every format the split picked with a share has a serving material, unless the format may be generated (`PRACTICE_REGISTRY`); and for a format served by materials, the minutes the allocation gives those materials are at least half of the format's share of the practice time. *(My call: only the allocation has per-format minutes for the whole plan; weeks 2–8 carry none. This is where runs 5–6 lost the problem set, 18% → 1%.)* |
| 6 | every topic | each of Week 1's days plans within ±20% of the daily minutes (hours per week × 60 ÷ days per week); no title, summary, task or note contains a material id (`M9`, `M9.3`); no chapter, unit or item is used on two days of Week 1 (a whole resource with no structure may be); no practice item repeats |

### Warnings

Reported in `run.json` and the report, never failing a run:

- expected books (sde): fewer than two of the label's expected books among the allocated materials;
- drop reasons by kind (no author, no match, outage, page refused, other) with counts;
- page-refusal rate: failed `research.fetch` over all, with the refused hosts;
- sizes: reading rows under 2 minutes; a source with more than one unit per 2 minutes of its size; item titles that
  are labels (Solution, Link, Video, Problem); the share of structure answers refused;
- cost over $2 or time over 300 s for the run;
- retries: levels that breached a check and were asked again (`breach:` facts), and `service` calls that recovered
  on retry, by service.

## Left to the builder

- Module layout under `evals/draft/` and how checks are split into functions; tests for every check against small
  hand-built records, and one test that re-scores a saved fixture record.
- Where each service reports its `service` event (the clients, the logged-call wrapper, the catch sites), as long as
  every call to the three services is covered and the event reaches the stream the eval reads.
- Title matching for criteria 1–2 (normalisation, subtitles, volumes) within the spirit of the labels.
- The exact report wording.
