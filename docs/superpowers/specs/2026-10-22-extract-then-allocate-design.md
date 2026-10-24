# Extract, then allocate: research records, the allocation chooses

Status: draft for approval. Builds on `2026-10-22-allocate-after-research-design.md` (same branch,
`feat/allocate-after-research`, not yet merged) and changes the steps between the end of research and the end of the
allocation.

## Why

Two live drafts of the SDE interview brief on this branch each lost a key source in research's candidates step, not in
the allocation:

- Run 1: the practice notes had found NeetCode's 150 solved problems, but the candidates step listed no problem source;
  the plan had no coding problems ("No practice source found for: Problems").
- Run 2: the candidates step listed NeetCode, but proposed ByteByteGo's *Coding Interview Patterns* as backbone under
  the site's page title ("System Design · Coding · Behavioral · Machine Learning Interviews"); Open Library found no
  such book and the gate dropped it. The plan had no system design book ("Not covered: System design").

The candidates step runs at low effort and still *selects* (a list that "covers the topic" within the plan's hours),
while the allocation (Opus 5.5) now makes the real choices with sizes in hand. The two overlap, and the weaker one
cuts first, before anything is verified or sized. The owner agreed the roles should be separated: research records,
the gate verifies, the allocation judges.

## Goals

1. **Extraction, not selection.** The candidates step lists every credible source the research notes found, across
   all directions, with what the notes say about it. Nothing is left out to fit the hours.
2. **Books are matched by their published title.** A book carries its published title and author, separately from
   its web page's title; the gate falls back to the page title when the published one finds nothing.
3. **The allocation chooses the backbone**, from the verified books, along with everything it already decides.
4. **The allocation states the plan's coverage**, so "Covered / Not covered" describes the plan, not research.
5. **The allocation runs at high effort.**
6. **Misses become visible:** a page a researcher read that the extraction didn't list is recorded as a fact.

## Non-goals

- Changing the research workers, their budgets, or the fetcher.
- Changing how the weeks and days are drafted from the allocation.
- Re-allocating saved plans. Saved plans keep their materials, backbone and split as saved.

## Anti-goals

- Everything in the parent design's anti-goals still holds: no fixed shares, ranges, floors or ceilings beyond
  validity; no steering numbers or worked examples in prompts; the reading share derived from the kept reading; the
  learner's own materials never dropped; a long book is not a reason to drop it.
- The extraction must not quietly keep selecting ("the best few"); its prompt asks for completeness.
- A backbone must not appear that the gate couldn't match (an unmatched book is never the backbone).

## The flow

```
notes ──► 1 EXTRACT (Sonnet) ──► 2 GATE (code) ──► 3 ALLOCATE (Opus 5.5, high effort) ──► weeks/days
          everything credible     verify + size      backbone, parts, drops, shares, coverage
```

### 1. Extraction (the candidates step, `buildFinalPrompt` / the candidates call)

- **Job:** list every credible source the notes found, from every direction, once each. The prompt states that
  choosing what the plan uses happens later, with sizes in hand, so leaving a found source out loses it.
- **No hour cap.** The "must not exceed N hours" line goes. A count bound stays as today (the schema's maximum
  candidates), so the list cannot run away.
- **Fields per candidate:** as today (url, kind, author, year, why, recommendedBy, minutes as the whole work, uses
  null, practice), plus:
  - `title`: for a book, the title as published (e.g. "System Design Interview – An Insider's Guide"); for anything
    else, the page's own title, as today;
  - `pageTitle`: for a book, the title its web page shows, when the notes give one; null otherwise;
  - `foundBy`: the research directions whose notes mention it (`backbone`, `canonical`, `current`, `practice`,
    `learner`).
- **`backbone` flag:** removed from the candidate schema. Instead each book carries its evidence (`recommendedBy`,
  `why`); the choice moves to the allocation.
- **Coverage:** stays, renamed in meaning to "what research found" (covered/open areas of the topic in the notes).
  It still drives the thin-research notice (`isThin`); it is no longer what the page shows as the plan's coverage.
- **Effort:** unchanged (`CANDIDATE_STEP_EFFORT`), since extraction is transcription; revisit only if evals show
  misses.
- **"Found but not listed" fact (code):** after the call, every URL that a research worker *read successfully* (not
  search results, which are many) and that no candidate or learner source points to (by canonical URL or final URL)
  is recorded as a fact on the candidates call: `read but not listed: <url> (<direction>)`. It is a fact only.

### 2. Gate (`runGate`)

- **Book title fallback:** when Open Library finds no match for the claimed `title`, try `pageTitle` (if given and
  different); a match counts only when the author agrees, as today. The matched work's title becomes the material's
  title.
- **Backbone:** the gate no longer sets `backbone`. It keeps, per book, what the allocation needs: matched or not,
  the number of distinct recommending sites (`recommendingDomains`), the chapter list, the size. Only a matched book
  may become the backbone (checked again in code after the allocation).
- **Everything else unchanged:** title check for non-books, answers rule for practice-only sources, sizing, the
  practice-only null-minutes rule, the learner's own sources always kept.

### 3. Allocation (`lib/ai/allocate.ts`)

- **Effort high:** a new `ALLOCATE_EFFORT: ReasoningEffort = "high"` in `lib/ai/models.ts`, passed to the call (the
  existing `effort` option of `loggedGenerateObject`, which maps to the Anthropic effort setting). Logged with the
  call as other calls' effort is.
- **Sees per book:** matched or not, recommending sites (count and domains), chapters with minutes, whole size,
  `why`, and whether the learner supplied it. It sees `foundBy` for every material.
- **Chooses the backbone:** a new output field `backbone: string | null` (a material id). Prompt guidance in words
  only: the backbone is the one book the plan follows in order; prefer a book that independent pages recommend and
  that fits the learner's goal; a learner-supplied book they want followed comes first; length alone is not a reason
  against a book (take part of it); none when no book suits. Code: the id must be a kept, matched book (a learner's
  own book counts as matched if the gate matched it); otherwise no backbone and a fact. Exactly one material ends with
  `backbone: true`, or none.
- **States the plan's coverage:** a new output field `coverage: { covered: string[]; open: string[] }` — the topic's
  main areas the kept materials and practice cover, and those the plan leaves open (1–3 words each, as research's).
  Normalised with the existing `normalizeCoverage`. Sent to the client with the allocated materials and shown in
  place of research's coverage.
- **Drops:** unchanged rules (learner's own never; researched with a stated reason). With a longer list, more drops
  are expected; the materials list shows them as a "Found but not used" group with their reasons (today's dropped
  list holds both the gate's rejections and the allocation's drops — keep them visually distinct: rejected by
  checks vs. found but not used).
- **Unchanged:** parts, practice shares, the derived reading share, facts, prompt framing of materials as data.

### 4. Fallback

When the allocation call fails on the app's key, or returns nothing usable, research's list is now complete and
unselected, so it can't be used as it stands. A code-only fallback chooses:
- the learner's own materials;
- as backbone, the matched book with the most recommending sites (ties: research's order), if any;
- practice sources that passed the gate;
- other reading in research's order while the running total of reading fits the plan's hours (each material at its
  whole size; a backbone too large for the hours is kept and the rest skipped);
- the all-reading split, as today. A fact on the call says the fallback chose.

This is a rule for the failure path only, not a target share.

### 5. Events and UI

- The `allocated` event gains `coverage` (the plan's). The workspace replaces research's coverage with it.
- `research.done` keeps research's coverage (used for the thin notice and shown until `allocated` arrives).
- The materials list's dropped section splits into "Rejected by checks" (gate) and "Found but not used" (allocation),
  each with reasons. Minimal styling change; no new interactions.

## Constraints

- The local `DATABASE_URL` is production. No migration is needed (`backbone` already exists on `sources`, with one
  per track; coverage is not saved). If the builder finds one is needed, stop and ask.
- No paid eval runs without the owner's go-ahead. One live draft of the SDE brief on the builder's own dev server is
  approved as the final check, as before.
- Tests: vitest, node environment. Every code rule above gets a unit test (title fallback, backbone validation,
  coverage normalisation, the read-but-not-listed fact, the fallback chooser, effort passed). Prompts get tests that
  they carry the new fields and still carry no target numbers.

## Decided in conversation

- Research records; the gate verifies; the allocation judges.
- The allocation chooses the backbone.
- The allocation runs at high effort.

## Calls made after the builder check

Each is the author's call, for the owner to check while reading.

1. **A material the allocation doesn't mention is not used.** The prompt asks for a part or a drop for every listed
   material. A researched material with no entry is dropped as "not used by the plan: not chosen" with a fact; the
   learner's own are always kept. "Nothing usable" (which triggers the fallback chooser) means only: the call failed,
   or no valid split comes out of normalisation. A partial answer is applied, not replaced. Reading that still exceeds
   the hours after the allocation is a fact, as today.
2. **The web chapter finder runs before the allocation, for a bounded few books.** For each matched book with no
   catalogue chapter list and at least `BACKBONE_MIN_DOMAINS` recommending sites (the books that could reasonably be
   the backbone), at most two, in parallel. So the allocation can still cut a likely backbone by chapter, at the cost
   of at most two finder runs.
3. **A learner's own book can be the backbone without an Open Library match.** The learner vouches for their own
   material; the gate does not look it up. Only researched books need a match.
4. **A researched book with no Open Library match under either title is still dropped**, as today. The catalogue stays
   the verification for books; the published-title field and the page-title fallback are what fix run 2's case.
5. **"Every credible source" means sources the notes read or that a worker's notes name, not every search hit.** A
   search result seen only as a snippet is listed only when a worker's notes recommend it. The candidate list is
   bounded at 25 (the materials schema's stated "at most 25 are asked for"); the schema gets that `.max`, and the
   prompt asks the model to keep the most-evidenced ones if it has more.
6. **Coverage on the fallback path:** the `allocated` event carries `coverage: null`; the page then shows research's
   coverage under the label "Research found", never as "Covered / Not covered".
7. **Evals: compile and meaning, no new runs.** `evals/research/bench.ts` stops reading `candidate.backbone`; its
   backbone metric becomes "a matched book with at least `BACKBONE_MIN_DOMAINS` recommending sites is among the
   verified materials" (what the allocation could choose). `evals/research/compare.ts`, which runs full drafts, reads
   the allocated backbone. No eval is run as part of this change.

## Left to the builder

- Field and function names, prompt wording within the anti-goals.
- How `foundBy` is derived (from which worker's notes mention the URL, or asked of the extraction model) — prefer code
  when the notes carry the URL.
- The exact UI wording of the two dropped groups.
