# Research-backed plans: a verified materials list — design

Date: 2026-09-28
Status: approved in brainstorming, awaiting spec review
Mock: https://claude.ai/artifact/Vu3XTUXieRgR9D4NcmMVsp (four artboards: drafting, plan with materials, week leaf,
edge states)

## Why

The product is only as good as the plans it drafts, and a later "starred / popular plans" feature will put the best
of them in front of other learners, the way Duolingo's course paths are something people are willing to follow. The
two plans the owner follows today (`jobhunting/weekly-plan.md` and its W4–W8 re-cut, `leetcode-plan.md`) show the
shape wanted for a tech topic:

- a plan-level **materials list** gathered up front (books, videos, essays and docs, tooling);
- a **backbone textbook** the plan follows in order (there: *AI Engineering*);
- per-week **Read tables**: tier, item, minutes, note;
- current material that covers what the backbone predates.

Today the model drafts from its own training data. That is out of date for fast-moving topics and cannot be trusted
to name real, existing material. `planPrompt.ts:141` and `dailyContent.ts:53` tell the model to "search the web",
but no tool exists, so the sentence does nothing.

Of the 32 drafts in the 2026-09-16 open coding, 10 failed on dimensions that research helps (accuracy 4, coverage
3, source fidelity 3). The larger group (partition 9, fit 5, pacing 5) is a prompting problem and out of scope here.

## Decisions

| Decision | Choice |
|---|---|
| Learner intake | None. The brief stays as it is. |
| What research finds | (1) one well-recommended backbone textbook, (2) canonical and current materials around it |
| Where materials live | One plan-level list. Units reference a subset by id. |
| Flow | One shot: research and drafting run in the same request. The list appears with the plan. |
| Implementation | Our own `webSearch` + `fetchSource` tools in a bounded agent loop (arm A) |
| Provider search | Anthropic's server-side web search and fetch (arm C), in the eval only, as the baseline A must match |
| Trust rule | A material enters the plan only if code fetched it and the page matches the claim |
| UI | As drawn in the mock, including the four choices below |

The four UI choices the mock settles:

1. Dropped candidates are shown to the learner (struck through, with the reason), not only in the admin panel.
2. "Research again" is offered only before the plan is confirmed.
3. Planned weeks show their full Read list in the plan view, not only a count.
4. Two tiers, **must** and **should**. A backbone chapter is a `must` whose note names the chapter.

## Architecture

```
brief ─► research (arm A | arm C) ─► verification gate ─► materials list ─► draft levels ─► plan + materials
                                      (code, shared)                        (existing, now assigns ids)
```

- **Research is swappable.** Both arms implement `research(brief, signal) → { candidates, calls }`. Everything after
  it is shared, so a difference in plan quality between arms is caused by research alone.
- **Arm A** (ships to users): a `ToolLoopAgent` with our two tools. It is portable across gateway models.
- **Arm C** (eval only, behind a flag): the same Claude model with Anthropic's `web_search` and `web_fetch` server
  tools, prompted to return the same candidate shape.
- **The verification gate** re-fetches every candidate whichever arm proposed it. Running it on arm C too makes the
  comparison fair and measures how often provider citations hold up.
- **Model.** Research uses a new `DEFAULT_RESEARCH_MODEL = "anthropic/claude-sonnet-5"`: judging which sources agree
  needs more than the Haiku model used for outlines. Arm C uses the same model.

## Data model

### Materials: extend `sources`

The sources a learner attaches become materials with `origin: "learner"`, so there is one list.

| Column | Type | Notes |
|---|---|---|
| `origin` | `learner` \| `research` | Learner materials are always kept. Existing rows migrate as `learner`. |
| `kind` | `book` \| `course` \| `video` \| `docs` \| `essay` \| `paper` \| `repo` \| `tool` \| `note` | Display and grouping. `type` stays for the existing link/youtube/file/note handling. |
| `backbone` | boolean, default false | At most one per track (partial unique index). |
| `author` | text, null | |
| `year` | integer, null | Drives the recency metric and "new since" labels. |
| `why` | text, null | One line: why this material, what it covers that others don't. |
| `position` | integer | Order within the list. The UI groups by kind. |
| `verifiedAt` | timestamp, null | Null for learner notes and files. |
| `fetchedTitle` | text, null | The title the gate saw. Shown in the Verified popover. |
| `recommendedBy` | jsonb `string[]`, default `[]` | URLs of pages that recommended it (backbone evidence). |

### Assignments: new `node_materials`

| Column | Type | Notes |
|---|---|---|
| `nodeId` | uuid → `plan_nodes`, cascade | |
| `sourceId` | uuid → `sources`, cascade | |
| `role` | `covers` \| `assigned` | `covers` on headings (reserved coverage); `assigned` on leaves. |
| `tier` | `must` \| `should`, null | Leaves only. |
| `minutes` | integer, null | Leaves only. Summed against `budgetHours`. |
| `note` | text, null | "Ch. 4 §2", "evals and guardrails sections only". |
| `position` | integer | Row order in the Read table. |

Primary key is `(nodeId, sourceId)`. Removing a material removes its rows after the confirm dialog (mock, state D).

Migrations follow the repo quirk: `drizzle-kit generate` needs a TTY, so additions and drops go in separate
migrations.

### Wire format

- Zod schemas in a new `lib/schemas/material.ts`: `materialSchema` (the client-side shape with a short id `M1…Mn`
  and a `sig`), `materialRefSchema` (`{ id, tier, minutes, note }`), `coverRefSchema` (`{ id, note }`).
- `unitDraftSchema` gains optional `covers` (headings) and `materials` (leaves). `revisedLeafSchema` and the node
  input schemas gain the same optional fields.
- The `sources` field in the draft, expand and chat bodies and in track creation becomes `materials`.
- **Signature.** Each researched material carries `sig = HMAC(MATERIALS_SIGNING_SECRET, url | fetchedTitle |
  verifiedAt)`. On confirm, a research material with a bad or missing `sig` is re-verified, and dropped if it fails.
  Learner materials need no signature. This keeps a forged "verified" badge out of plans that later go public.
- Short ids are mapped to uuids in `createTrack` and in the adjust-mode save. A reference to an unknown id is
  dropped and recorded as a fact (see Checks).

## The research step (arm A)

### Tools

- **`webSearch({ query })`**: Tavily, 5 results. It returns `{ title, url, snippet, publishedDate }[]`, never the
  full page. It sits behind a `SearchProvider` interface, so tests use a fake and the provider can change.
- **`fetchSource({ url })`**: a guarded GET. It returns `{ finalUrl, title, ogTitle, h1, author, published, text }`,
  with `text` cut to about 4k tokens of readable content. Results are cached per run, and the gate reuses them.

### Egress guards (`lib/ai/research/egress.ts`)

- `https:` only, default port, no credentials in the URL.
- DNS is resolved before connecting. Loopback, RFC 1918, link-local, CGNAT, cloud-metadata (`169.254.169.254`),
  `::1`, `fc00::/7` and `fe80::/10` are rejected, as are IP-literal hosts in any encoding (decimal, octal, hex).
- The connection goes to the resolved, checked address, not a second lookup, which closes DNS rebinding.
- Redirects are followed by hand, at most 3, and every hop is re-checked.
- 5 s timeout, 2 MB body cap (streamed; stop reading at the cap), and only `text/html`, `application/pdf` and
  `text/plain` are accepted.
- `gzip` and `br` are requested and decoded (`deflate` too if a site sends it); the cap counts decoded bytes, and
  any other content encoding is refused.
- No cookies, no auth headers, and a fixed user agent that names Pensieve.

**Rule of Two.** The agent handles [A] untrusted input (fetched pages). It holds no [B] private data beyond the
learner's own brief, and has no [C] tools that change state. An injected instruction in a page can at worst propose
a bad material, which the gate and the judges exist to catch.

### Budget (enforced in code)

At most 12 steps, 6 searches, 12 fetches and 60 s wall clock. A tool call past its cap returns a "budget spent"
result instead of running. When a cap or the clock is hit, the loop stops and the final structured step runs on the
notes gathered so far.

### Agent strategy (prompt)

1. Fetch each learner source and describe it. These are always kept.
2. **Backbone.** Search from several angles (best book for X, course syllabi, reading lists) and record which pages
   recommend each candidate. Independent agreement beats a single listicle. A book's link is its publisher's or
   author's page, never a shop listing.
3. **Canonical materials.** Official docs, the well-known courses, the standard papers.
4. **Currency.** For fast-moving topics, material from the last two years that covers what the backbone predates.
5. **Final step.** Emit 12–25 candidates:
   `{ url, title, kind, author?, year?, backbone, why, recommendedBy: url[] }`.

### Verification gate (`lib/ai/research/verify.ts`, shared by both arms)

| Check | Rule |
|---|---|
| Fetched | A 2xx through the guarded fetch in this run (cache hit or new fetch) |
| Title | Normalized token overlap between the claimed title and the fetched `title`, `og:title` or `h1` clears a threshold (tuned on the eval). A mismatch drops the candidate; titles are never auto-corrected. |
| Kind | Plausible for the host (YouTube → video, GitHub → repo, …). |
| Book | A `book` is verified by Open Library instead: a search match by title and author, which supplies `year`. Books are rarely readable online and publishers often refuse automated readers, so a page is not required. If the book's own page passes the three checks above it is the link; otherwise the link is the book's Open Library entry (this needs an author on both sides). No match drops the book. |
| Dedupe | By canonical final URL |
| Backbone | A verified `book` whose `recommendedBy` spans at least 2 distinct registrable domains. If none qualifies, the plan has no backbone, which is allowed and gets flagged. |

Every drop is logged with its reason, and is streamed to the UI.

### Arm C (eval only)

- Same model, with Anthropic's `web_search` and `web_fetch` server tools (the `_20260209` versions for Sonnet 5), and
  the same final candidate schema.
- To verify during the build: whether provider-executed tools pass through the AI Gateway. If they don't, arm C calls
  `@ai-sdk/anthropic` directly, and only from the eval script, so the app has no direct provider dependency.

## Drafting changes

Drafting is lazy: a draft plans the top level and then one path down to the leaves, and other headings are expanded
later (`streamExpandNode`). So headings reserve coverage and leaves assign.

- **Headings** (month, and week when weeks are not leaves) return `covers: [{ id, note }]`, with no tier and no
  minutes. Example: `M1: ch. 5–6`, `M4: whole essay`. An expansion drafts its children from that reservation, so
  weeks expanded later still read the book in order.
- **Leaves** return `materials: [{ id, tier, minutes, note }]`. The prompt gives the parent's reservation as the
  primary pool and the whole list as a fallback, plus the leaf's budget. Rules:
  - at least one `must` per leaf;
  - `must` minutes within about 60% of the leaf's budget (the owner's "~2 h/week of must-reads" rule; the rest is
    building);
  - backbone chapters run in order across leaves.
- **Revision and chat.** The tree rendering shows each node's references. `revisedTreeSchema` carries them back, so
  "make the Karpathy talk optional" edits an assignment without re-researching. Adding a new URL through chat
  (`addMaterial`, running the same gate) is a follow-up, not part of this build.
- **Daily and weekly lessons.** `generateDailyContent` receives the leaf's assigned materials as its sources. Its
  `citations` must be a subset of them, which gives source fidelity a check in code. The dead "search the web"
  sentences in `planPrompt.ts` and `dailyContent.ts` are removed.

### Checks in code (after each level)

These show as facts in the admin panel and feed the eval:

| Check | Action |
|---|---|
| Reference to an unknown id | Drop it, record a fact |
| Leaf minutes against `budgetHours` (week leaves) | Flag over-budget; keep the reference |
| Backbone chapter order, parsed from `note` when present | Flag regressions |
| Top level: backbone chapters all reserved by some heading | Flag gaps (coverage signal) |

## Streaming and UI

New NDJSON events precede the first unit:

```
research.start
research.search   { query, results }
research.fetch    { url, ok, reason? }
research.verified { id, title, kind, backbone }
research.dropped  { title, reason }
research.done     { materials, notice?: "thin" | "unavailable" }
```

Every research model call goes through `logged` and `onCall`, so the generation log and the admin panel show each
step with its tool inputs and outputs.

UI, per the mock:

- **While drafting** (artboard 1): a research card with counters for searches, pages read and verified (against
  the caps), a live log (source read, searched, verified, dropped with reason, reading now), a "Found so far" chip
  row, and plan placeholders. Chat is disabled until the plan exists.
- **Plan** (artboard 2): a Materials section above the tree. The backbone is pinned with a badge and its `why`;
  the rest are grouped by kind, each with author · year, `why`, a ✓ Verified button, and "Yours" on learner items.
  "Show all N" collapses past the first few. Headings show a "Covers" chip row. Planned weeks show their Read rows
  and a must / should / budget bar.
- **Week leaf** (artboard 3): a Read table (Tier | Item | Min | Note) with a budget footer, the lesson card ("cites
  only these"), and a "Where these come from" note.
- **Edge states** (artboard 4): the Verified popover (opened date, fetched title, host, Open Library match,
  recommending sources); the thin-research notice with no backbone; the research-unavailable notice with "Research
  again" (before confirm only); the remove-material confirmation listing where it is assigned.

## Failure handling

Nothing in research fails the draft.

| Failure | Behaviour |
|---|---|
| Search API errors or times out | End research early. Draft from what verified plus learner sources, with the `unavailable` or `thin` notice. |
| A fetch fails (timeout, 4xx/5xx, guard, content type) | Drop the candidate with its reason |
| Step or budget cap hit | Go to the final structured step with the notes so far |
| Final step fails its schema | Retry once, then continue with learner sources only |
| Fewer than 5 researched materials verified, or none | `thin` notice. No backbone if none qualified. |
| Client disconnects | The abort signal reaches search and fetch |
| Confirm with a bad or missing `sig` | Re-verify that material; drop it if it fails |

## Testing

Vitest, with no live network in any test.

- **Egress guard**, as a table: `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `::1`, `fc00::1`, `2130706433`,
  `0x7f.1`, an `http:` URL, a redirect into a private range, a rebinding resolver (public then private), an
  oversized body, a wrong content type, a compressed body (decoded, capped after decoding, refused when the encoding
  is unknown).
- **Pure functions:** title matcher, kind rules, dedupe, backbone rule, HMAC sign and verify, short id to uuid
  mapping with unknown-id dropping, minutes against budget, chapter-order parser.
- **Agent loop,** with the AI SDK mock model and fake search and fetch: event order; each failure-handling path;
  caps enforced in code whatever the model requests.
- **Persistence:** `createTrack` writes materials and `node_materials` from short ids; removing a material cascades.

## Eval: arm A against arm C (the W7 "source-fidelity delta")

- **Inputs.** A golden v3 set built from the v1 draft records, mostly tech topics plus a few non-tech ones to
  exercise thin research. v1 stays frozen. Records gain optional labels: `expectedBackbone` (`{ title, author }`)
  and `mustInclude` (canonical materials a teacher would expect).
- **Runs.** 3 per record per arm. Same model, same gate, same drafting code, same judges.
- **Metrics.**

  | Metric | Source |
  |---|---|
  | Verified rate (survivors ÷ candidates) | Gate logs |
  | Backbone hit | `expectedBackbone` label |
  | `mustInclude` recall | Label |
  | Recency (share from the last 2 years) | `year` |
  | Accuracy, coverage, source fidelity | Existing rubric dimensions |
  | Materials fit (new rubric dimension, below) | Judge |
  | Unknown-id refs, over-budget leaves, chapter-order regressions | Code checks |
  | Cost, latency, tool calls | Generation log |

- **New rubric dimension, "Materials fit".** Pass when each leaf's assigned materials teach that leaf's topic and the
  backbone chapters named in its notes match what the leaf covers.
- **Decision rule (pre-registered).** Arm A stays the default if it is no worse than arm C on backbone hit and the
  three research-sensitive rubric dimensions, and within 10 points on verified rate. If arm C clearly wins, the
  next step is a hybrid: provider search where the model supports it, with our fetch and gate kept regardless.
- **Cost.** One record through both arms is measured first, and the full run waits on approval of that number.

## Files

New:

- `lib/ai/research/egress.ts`: guarded fetch
- `lib/ai/research/tools.ts`: `webSearch`, `fetchSource`, `SearchProvider`, Tavily implementation
- `lib/ai/research/verify.ts`: the gate
- `lib/ai/research/agent.ts`: arm A, `research(brief, signal)`
- `lib/ai/research/signature.ts`: HMAC
- `lib/schemas/material.ts`
- `evals/research/providerArm.ts`: arm C
- `evals/research/compare.ts`: runner for A against C
- `components/pensieve/ResearchProgress.tsx`, `MaterialsList.tsx`, `ReadTable.tsx`
- Two drizzle migrations: add columns and table; any drop

Changed:

- `lib/db/schema.ts`, `lib/db/queries.ts` (`createTrack`), `lib/db/planQueries.ts` (adjust save)
- `lib/schemas/plan.ts`, `lib/schemas/source.ts`
- `lib/ai/planDraft.ts`, `lib/ai/planPrompt.ts`, `lib/ai/planRevision.ts`, `lib/ai/planChat.ts`,
  `lib/ai/dailyContent.ts`, `lib/ai/models.ts`
- `app/api/plan/{draft,expand,chat}/route.ts`, `app/tracks/new/actions.ts`, the adjust page
- `components/pensieve/PlanWorkspace.tsx`, `PlanTree.tsx`, `app/tracks/[id]/nodes/[nodeId]/LeafView.tsx`
- `evals/rubric.md` (Materials fit)

New environment: `TAVILY_API_KEY`, `MATERIALS_SIGNING_SECRET`.

## Sequencing

The owner's weekly plan puts the tools and guards in W6 and citation verification and the eval delta in W7. So:

1. Egress guard and tools, with the SSRF test table (W6 Build).
2. Gate, signature, agent loop, stream events (W6–W7).
3. Schema and migrations, drafting changes, persistence (W7).
4. UI (W7).
5. Arm C, golden v3 labels, compare runner, first measured record, then the full run once its cost is approved
   (W7 Exit).

## Out of scope

- `addMaterial` through chat
- Editing assignments inline (chat only for now)
- Public or starred plans (the signature exists so they can come later)
- The partition, fit and pacing prompt work
- Research for non-English topics beyond what falls out naturally. The Chinese-output regression stays its own fix.

## Open items to settle during the build

- Tavily plan and rate limits, and whether its `raw_content` can stand in for a separate fetch on search hits (the
  gate still fetches; this is only a latency question).
- Open Library rate limits, and a fallback when it is down (the book's own page decides; a book kept that way is
  marked unmatched and is never the backbone).
- The readable-text extractor (Readability plus a DOM shim, or a lighter HTML-to-text) and PDF text extraction.
- The title-match threshold, tuned on the first eval run.

## Known issues, deferred

Found in browser testing of the branch on 2026-10-02 and judged minor; none blocks shipping.

Research quality
- A material the gate drops can still be named by others: their `why` lines and the plan's reading notes may point
  at it (seen when the backbone book was dropped; the companion repo then got the book's chapter assignments).
- Non-book titles are the page's raw title ("Redirecting to LangGraph Documentation", "… - Model Context Protocol").
- Thin metadata: most researched materials have no `recommendedBy`, and about half have no `year`.
- Reading lists and course directories get kind `note`.
- The agent can spend half its searches hunting for a publisher page that refuses automated readers (O'Reilly),
  despite the prompt saying to try once.
- GitHub sometimes misses the 5 s fetch timeout, which drops a repo.

Research card
- It says "usually about a minute"; runs take about 1:50 to 2:20 because the final candidates step has no time cap
  of its own.
- The live log lists searches only: page reads are not shown, and the verified and dropped lines never appear before
  the list replaces the card.
- "Only pages Pensieve could open and check make the list" is no longer true for books checked by Open Library.

Drafting and plan
- A material listed twice in one unit is dropped silently (`lib/materials.ts`, `resolveMaterialRefs`) instead of
  being reported as a fact.
- Revisions add "Week N:" / "Day N:" to titles: the revision prompt lacks the drafting prompt's no-prefix rule (also
  on `main`).
- The drafting prompt says materials "were found and checked by research" even when research did not run.
- The "Expand week N" suggestion chip stays after the week has been expanded.

Not yet exercised in a browser: arm C and the eval runner, the `thin` notice, "Research again" with a search key,
and confirming a plan whose book links to Open Library (covered by unit tests only).
