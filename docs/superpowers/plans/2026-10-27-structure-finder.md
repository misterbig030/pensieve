# Structure Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Research measures every page and finds each long source's real units. The allocation gives each material a minute budget and a purpose. The outline picks units to meet each budget and spreads them over consecutive weeks.

**Architecture:**
- **Page extraction:** parses every HTML page's heading tree and links once, and keeps them on the cached `PageInfo`. The gate, the finder's tools and the unit check all read that one parse.
- **Structure finder:** one Sonnet tool loop per source, with tools that only fetch and measure (`outline`, `measure`, `search`, `items`).
- **Unit check (pure code):** turns the finder's answer into a `toc`, a size and an item list, or refuses it.
- **Allocation:** its `parts` become `{ minutes: budget, purpose }`.
- **Outline:** prompt rules and `levelChecks` treat every material with units the way they treat the backbone's chapters today, plus a new `budget-miss` breach and a code-held unitless span.

**Tech Stack:** Next.js 16, TypeScript, AI SDK 7 (`ToolLoopAgent`, `tool`, `isStepCount`, `hasToolCall`), zod, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-10-27-structure-finder-design.md` (approved). Read it before your task. It is the authority, and this plan argues from it.

## Global Constraints

- The constants and their values are:
  - `STRUCTURE_MIN_MINUTES` 90, `HUB_MIN_LINKS` 6, `MAX_STRUCTURE_FINDERS` 6, `STRUCTURE_STEPS` 6, `STRUCTURE_WALL_MS` 40_000;
  - `STRUCTURE_SEARCHES` 2, `MEASURE_BATCH` 12, `MIN_UNIT_COVERAGE` 0.7, `STRUCTURE_ALLOCATE_MIN_MS` 30_000;
  - budget-miss slack: max(20% of the budget, 15 min).
- The structure finder runs on the research model the draft already resolves (`models.research.model`, default `anthropic/claude-sonnet-5.5`) at effort `"medium"` (`STRUCTURE_EFFORT`).
- **No steering numbers in prompts:** no target shares, ranges, floors or worked examples. The slack is used in code only, and no prompt may contain "20%" or "15 min" as a target.
- The allocation gets no tools. The learner's own materials are never dropped. A finder that throws, times out or is refused never fails the draft: the source stays exactly as the gate left it.
- **No DB migration.**
  - New chapter fields (`url`, `group`) are optional inside the `toc` jsonb.
  - `pageMinutes`, `hub` and `note` are draft-only material fields, like `catalogued`, and are never stored.
  - The local `DATABASE_URL` is production. If anything seems to need a migration, stop and ask.
- **Model calls:**
  - No paid eval runs.
  - The only live model calls are one SDE-interview draft on your own dev server at `localhost:3001` (Task 12), never the owner's 3000.
- Tests are vitest in the node environment, next to the code (`*.test.ts`).
  - Run one file with `npx vitest run <path>`.
  - Typecheck with `npx tsc --noEmit`, lint with `npm run lint`.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Code style:** match the surrounding code.
  - Doc comments say what a function is and why, in plain sentences.
  - Model-facing prompt text treats titles from pages as data, never instructions.

## Review Focus

These are the five failure modes most likely to bite a learner that no spec rule tests directly. Each one's test is added to the task that owns its code.

1. **Anchors on real GitHub pages.** GitHub prefixes heading ids with `user-content-` and percent-encodes non-ASCII slugs. A unit whose `at` uses the page's visible slug (`#load-balancer`) must still match. The test is in Task 1 (anchors) and Task 5 (matching).
2. **A finder that fails must not erase what the gate found.** A catalogued book keeps its catalogue `toc`, and a practice source keeps its `practice` as it was. The test is in Task 7.
3. **A budget over an estimate is not capped.** The learner's own course is estimated at 3 h and the allocation gives it 5 h: the budget stays 5 h. A measured 50-minute README given 180 min becomes 50. The test is in Task 8.
4. **Items-only sources and saved plans keep `M4.12`.** Only a source with both units and items uses `M4.i12`. Saved trees, with chapter refs into cut lists and `M4.12` item rows, must resolve exactly as before. The test is in Task 3.
5. **A short deadline skips the stage cleanly.** Research that runs long skips the structure stage without emitting half-results. A stage cut off at its deadline keeps the finders that finished. The test is in Task 7.

---

### Task 0: Worktree setup

**Files:** none.

- [ ] **Step 1: Install dependencies in the worktree.** Run `npm ci` in `.claude/worktrees/structure-finder`. Expected: it exits 0 and `node_modules/` exists.
- [ ] **Step 2: Get a baseline.** Run `npx vitest run && npx tsc --noEmit`. Expected: all pass. Record the test count in the ledger.

---

### Task 1: Page outline in extraction

Parse each HTML page's heading tree, words per heading and links once, at extraction, so the cached page carries them.

**Files:**
- Create: `lib/ai/research/outline.ts`
- Create: `lib/ai/research/outline.test.ts`
- Create: `lib/ai/research/__fixtures__/pages/*.html.gz` (four captured pages)
- Modify: `lib/ai/research/extract.ts` (`PageInfo`, `extractHtml`, `extractPdf`)

**Interfaces:**
- Produces:
  ```ts
  export interface OutlineLink { url: string; text: string }            // absolute URL, decoded link text
  export interface OutlineHeading {
    level: number;                // 1–6
    title: string;                // decoded, whitespace-collapsed
    anchor: string | null;        // fragment without "#", "user-content-" stripped, percent-decoded
    words: number;                // countWords of the readable text from this heading to the next heading of the same or higher level
    links: OutlineLink[];         // links inside that span
  }
  export interface PageOutline {
    words: number;                // equals PageInfo.words for the same page
    headings: OutlineHeading[];   // document order
    links: OutlineLink[];         // every link in the body, nav and sidebars included (GitHub: README article only)
  }
  export function parseOutline(html: string, finalUrl: string): PageOutline;
  export function siteLinkCount(outline: PageOutline, finalUrl: string): number;
  export function isGithubRepoPage(url: string): boolean;   // github.com/{owner}/{repo}[/tree/...]
  ```
- `PageInfo` gains:
  - `outline?: PageOutline` and `siteLinks?: number` (set by `extractHtml`);
  - `pages?: number | null` (a PDF's page count, set by `extractPdf`).

**Decisions:**
- **GitHub source:** GitHub READMEs are read from the rendered HTML the gate already fetched (the spec leaves this to the builder). The README is the `<article class="markdown-body">` element. Headings and words come from inside it. On a GitHub repo or folder page, links are counted only inside it, because GitHub's own chrome and file list are on every repo page.
- **Heading anchor:** the heading's own `id`. Failing that, the `id` or `href="#…"` of the first `<a>` inside the heading or immediately after it, before any text. GitHub puts it in a sibling `<a class="anchor">`.
- **Other pages:** headings and words come from the region `readableText` picks (`main`/`article` when present, else the body), with nav, header, footer and aside stripped as there. Links come from the whole body.
- **`siteLinkCount`:** distinct canonical link targets (no fragment) that differ from the page itself.
  - GitHub repo pages: targets under `github.com/{owner}/{repo}/` (blob or tree paths).
  - Elsewhere: targets on the same registrable domain (`registrableDomain` in `verify.ts`).
- **PDF page count:** the number of `/Type\s*/Page\b` objects (not `/Pages`) in the bytes read.

- [ ] **Step 1: Capture the fixtures.**
  - For each URL below, run `curl -sL -A "PensieveResearch/1.0 (study-plan source checker)" <url> | gzip > lib/ai/research/__fixtures__/pages/<name>.html.gz`:
    - `github-readme`: `https://github.com/donnemartin/system-design-primer`
    - `github-hub`: `https://github.com/severilov/DL-Audio-AIMasters-Course`
    - `blog`: `https://lilianweng.github.io/posts/2023-06-23-agent/`
    - `book-toc`: `https://web.stanford.edu/~jurafsky/slp3/`
  - Check that `gunzip -c github-readme.html.gz | grep -c 'markdown-body'` is ≥ 1. If GitHub's HTML has no `markdown-body` article, stop and report BLOCKED: the anchor and README decisions above assume it.
- [ ] **Step 2: Write the failing tests** in `outline.test.ts`. Read the fixtures with `gunzipSync`.
  ```ts
  it("reads a GitHub README's sections with anchors and words", () => {
    const o = parseOutline(primer, "https://github.com/donnemartin/system-design-primer");
    const lb = o.headings.find((h) => /^load balancer$/i.test(h.title))!;
    expect(lb.anchor).toBe("load-balancer");        // no "user-content-" prefix
    expect(lb.words).toBeGreaterThan(200);
    expect(o.words).toBeGreaterThan(9000);
    expect(o.headings.filter((h) => h.level === 2).length).toBeGreaterThanOrEqual(10);
  });
  it("counts a hub README's links to its own folders", () => {
    const url = "https://github.com/severilov/DL-Audio-AIMasters-Course";
    expect(siteLinkCount(parseOutline(hub, url), url)).toBeGreaterThanOrEqual(6);
  });
  it("does not count GitHub's own chrome as site links", () => {
    // a README with no links: a synthetic page with GitHub's header and file list around an empty markdown-body article
    expect(siteLinkCount(parseOutline(githubShell, "https://github.com/a/b"), "https://github.com/a/b")).toBe(0);
  });
  it("splits a blog post's words among its headings", () => {
    const o = parseOutline(blog, "https://lilianweng.github.io/posts/2023-06-23-agent/");
    const top = o.headings.filter((h) => h.level === Math.min(...o.headings.map((x) => x.level)));
    expect(top.reduce((s, h) => s + h.words, 0)).toBeGreaterThan(o.words * 0.7);
  });
  it("lists a contents page's chapter links", () => {
    const o = parseOutline(bookToc, "https://web.stanford.edu/~jurafsky/slp3/");
    expect(o.links.some((l) => /n-?gram/i.test(l.text))).toBe(true);
  });
  it("percent-decodes a non-ASCII anchor", () => {
    const o = parseOutline(`<article class="markdown-body"><div class="markdown-heading"><h2>Кэш</h2><a id="user-content-%D0%BA%D1%8D%D1%88" class="anchor" href="#%D0%BA%D1%8D%D1%88"></a></div><p>x</p></article>`, "https://github.com/a/b");
    expect(o.headings[0].anchor).toBe("кэш");
  });
  it("puts the outline and site links on PageInfo", () => {
    const p = extractHtml(primer, "https://github.com/donnemartin/system-design-primer");
    expect(p.outline?.words).toBe(p.words);
    expect(p.siteLinks).toBeGreaterThanOrEqual(0);
  });
  ```
  Also add a test that `extractPdf` counts three `/Type /Page` objects in a synthetic byte string with one `/Type /Pages`.
- [ ] **Step 3: Run the tests.** Run `npx vitest run lib/ai/research/outline.test.ts`. Expected: FAIL (`parseOutline` not defined).
- [ ] **Step 4: Implement `parseOutline`, `siteLinkCount` and `isGithubRepoPage` in `outline.ts`, and set `outline`, `siteLinks` and `pages` in `extract.ts`.**
  - Reuse `readableText`, `decodeEntities` and `countWords` from `extract.ts`. Export what you need; don't copy it.
  - `PageOutline.words` must equal `countWords(readableText(html))` for non-GitHub pages. For GitHub repo pages it is the article's words, and `extractHtml` then sets `PageInfo.words` to the same value.
- [ ] **Step 5: Run the tests.** Run `npx vitest run lib/ai/research/` and expect PASS, with the existing extract and verify tests still green.
- [ ] **Step 6: Commit.** `git add lib/ai/research/outline.ts lib/ai/research/outline.test.ts lib/ai/research/extract.ts lib/ai/research/__fixtures__/pages && git commit -m "feat(research): pages carry their heading tree, words per heading and links"`

---

### Task 2: Gate measures every page

**Files:**
- Modify: `lib/schemas/material.ts`
  - `chapterSchema` gains optional `url` and `group`.
  - `materialSchema` gains draft-only `pageMinutes`, `hub` and `note`.
- Modify: `lib/ai/research/verify.ts` (`SizeInput`, `sizeMaterial`, `runGate`)
- Test: `lib/ai/research/verify.test.ts`, `lib/schemas/material.test.ts`

**Interfaces:**
- Consumes: `PageInfo.outline`, `siteLinks` and `pages` (Task 1).
- Produces:
  - `chapterSchema`:
    - `url: z.string().trim().min(1).max(2000).nullable().optional()`: where the unit is, when it isn't the list's own `url`.
    - `group: z.string().trim().min(1).max(MAX_HEADING).nullable().optional()`.
  - `materialSchema`, draft-only, each documented like `catalogued`:
    - `pageMinutes: z.number().int().min(1).max(60000).nullable().optional()`;
    - `hub: z.boolean().optional()`;
    - `note: z.string().max(300).nullable().optional()`.
  - `export const HUB_MIN_LINKS = 6;` in `verify.ts`.
  - `export function pageMinutesOf(page: Pick<PageInfo, "words" | "durationMinutes">, kind: MaterialKind, bookPages?: number | null): number | null`:
    - a video's runtime;
    - a book's `bookPages × MINUTES_PER_PAGE`;
    - else `words ÷ WORDS_PER_MINUTE` when `words > 0`;
    - else null. All values go through `validMinutes`.
  - `SizeInput` gains `hub?: boolean`. `sizeMaterial` now also measures:
    - `paper` (as `essay`);
    - `repo` when `!hub` and `words ≥ MIN_MEASURED_WORDS`.
- In `runGate`, every kept material whose own page was fetched gets:
  - `pageMinutes` (from `pageMinutesOf`);
  - `hub: (page.siteLinks ?? 0) >= HUB_MIN_LINKS`.
  Both learner and researched materials pass `hub` into `sizeFields`.

**Before you edit:** grep `lib/db` and `app` for where materials are written. Confirm the writer maps explicit columns, so `pageMinutes`, `hub` and `note` are never stored, as `catalogued` isn't. If the writer spreads the whole object into a jsonb column, stop and report.

- [ ] **Step 1: Write the failing tests** in `verify.test.ts`:
  ```ts
  it("measures a README that is the work", () => {
    expect(sizeMaterial({ kind: "repo", uses: null, claimedMinutes: 480, words: 11469 })).toEqual({ minutes: 50, basis: "measured" });
  });
  it("keeps the estimate for a hub repo", () => {
    expect(sizeMaterial({ kind: "repo", uses: null, claimedMinutes: 600, words: 900, hub: true })).toEqual({ minutes: 600, basis: "estimated" });
  });
  it("measures a paper like an essay", () => {
    expect(sizeMaterial({ kind: "paper", uses: null, claimedMinutes: 30, words: 6900 }).basis).toBe("measured");
  });
  it("keeps a course's estimate whatever its landing page measures", () => {
    expect(sizeMaterial({ kind: "course", uses: null, claimedMinutes: 1200, words: 2300 })).toEqual({ minutes: 1200, basis: "estimated" });
  });
  it("sizes every page", () => {
    expect(pageMinutesOf({ words: 2300 }, "course")).toBe(10);
    expect(pageMinutesOf({ durationMinutes: 42 }, "video")).toBe(42);
    expect(pageMinutesOf({ words: 0 }, "docs")).toBeNull();
  });
  ```
  Also add a `runGate` test with a fake fetcher. A repo page has 11,469 words and 2 site links; a course page has 2,300 words and 9 site links. The repo comes out at `minutes 50, measured, hub false, pageMinutes 50`. The course comes out at its estimate, with `hub true` and `pageMinutes 10`.
  In `material.test.ts`, a chapter with `url` and `group` parses, and one without them still parses.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/ai/research/verify.test.ts lib/schemas/material.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it as specified above.**
- [ ] **Step 4: Run the tests.** Run `npx vitest run lib/ai/research lib/schemas`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(research): the gate measures every page and marks hubs`.

---

### Task 3: Item aliases `M4.i12` for sources with both units and items

**Files:**
- Modify: `lib/materials.ts` (`ALIAS_RE`, `aliasMaterials`, `itemAliases`, `itemRun`, their callers)
- Modify: `lib/ai/planPrompt.ts` (`renderItemGroups`, `itemLine`, `positionsText`, line 96)
- Test: `lib/materials.test.ts`, `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Produces:
  - `ALIAS_RE = /^\[?\s*(m\d+)(?:\.(i)?(\d+))?\s*\]?$/i`.
  - `aliases.alias(id, { item: n })` returns `M4.i12` when the material has a chapter list, and `M4.12` otherwise.
  - `resolve`:
    - `M4.i12` resolves only to an item;
    - `M4.12` resolves to a chapter when the material has chapters (never to an item then), else to an item, as today.
  - `export function itemAliases(aliases: MaterialAliases, id: string, positions: Iterable<number>): string`
  - `export function itemRun(aliases: MaterialAliases, id: string, from: number, to: number): string`. A run of one is the item alias; otherwise `"M4 items 1–9"`.
  - Every place that writes an item alias builds it through `aliases.alias(id, { item })` or these two functions. No string concatenation of `${alias}.${n}` stays.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  const both = { id: "b", toc: tocOf(3), practice: listed(5) };
  const itemsOnly = { id: "p", toc: null, practice: listed(5) };
  const a = aliasMaterials([both, itemsOnly]);
  expect(a.alias("b", { item: 4 })).toBe("M1.i4");
  expect(a.alias("b", 2)).toBe("M1.2");
  expect(a.resolve("M1.i4")).toEqual({ id: "b", chapter: null, item: 4 });
  expect(a.resolve("M1.2")).toEqual({ id: "b", chapter: 2 });
  expect(a.resolve("M1.4")).toBeUndefined();                 // past the chapters; items need the i
  expect(a.resolve("M2.4")).toEqual({ id: "p", chapter: null, item: 4 }); // items-only unchanged
  expect(a.resolve("M2.i4")).toEqual({ id: "p", chapter: null, item: 4 });
  expect(itemAliases(a, "b", [2, 3, 5])).toBe("M1.i2–M1.i3, M1.i5");
  expect(itemRun(a, "p", 1, 9)).toBe("M2 items 1–9");
  ```
  In `planPrompt.test.ts`, `renderMaterials` on `both` shows its items as `M1.i…` and its chapters as `M1.1…`.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/materials.test.ts lib/ai/planPrompt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it, and update every caller.** Find them with `grep -rn "itemAliases\|itemRun\|positionsText\|itemLine" lib components`.
- [ ] **Step 4: Run the full suite.** Run `npx vitest run && npx tsc --noEmit`. Expected: PASS. The existing item-list and saved-tree tests stay green unchanged, which is Review Focus 4.
- [ ] **Step 5: Commit.** Commit with the message `feat(plan): a source with units and items names its items M4.i12`.

---

### Task 4: The `items` tool's reading, out of the item finder

Expose today's item-list reading as a function that the structure finder's `items` tool calls on a URL the finder chose.

**Files:**
- Modify: `lib/ai/research/itemFinder.ts`
- Test: `lib/ai/research/itemFinder.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ItemReadContext { fetcher: SourceFetcher; emit: (e: ResearchEvent) => void; signal?: AbortSignal; log?: GenerationLogContext }
  export interface ItemReadOptions { model?: AiModelId | LanguageModel; effort?: ReasoningEffort; read?: FullReader }
  /** Full read of `url` → data-file mapping, or transcription of the page; each model call on its own clock (ITEM_MAP_MS, ITEM_ANSWER_MS). */
  export async function readItemListAt(source: Material, url: string, ctx: ItemReadContext, options?: ItemReadOptions):
    Promise<{ list: PracticeList | null; counts: ResearchCounts; costUsd: number }>;
  export function normalText(text: string): string;   // now exported, unchanged
  ```
- Keep `validateItemList`, `listGroups`, `itemListFacts`, `MAX_UNSEEN_SHARE` and the prompt builders.
- Delete `createItemFinder`, the `ItemFinder*` types, `buildLocatePrompt`, `locateAnswerSchema` and the search/locate stages. The structure finder replaces them, and Task 7 removes the last caller. Until then, keep `createItemFinder` as a thin wrapper that runs gather → locate → `readItemListAt` so that the build stays green. Task 7 deletes it.

- [ ] **Step 1: Write the failing tests.** A fake `read` returns `problemList.json` (the existing fixture) for the URL, and a fake model answers the mapping. Then `readItemListAt` returns a list of the fixture's length with `source: "file"`. A page that isn't a data file goes to transcription with that page as the only read.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/ai/research/itemFinder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it by moving steps 3–5 of `createItemFinder.find` into `readItemListAt`.** The locate step's chosen URLs become the single `url` argument.
- [ ] **Step 4: Run the tests.** Run `npx vitest run lib/ai/research`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `refactor(research): item-list reading runs on a given URL`.

---

### Task 5: Check units (pure code)

**Files:**
- Create: `lib/ai/research/units.ts`
- Create: `lib/ai/research/units.test.ts`

**Interfaces:**
- Consumes: `PageOutline` (Task 1), `chapterSchema.url/group` (Task 2), `normalText` and `validateItemList` (Task 4), `withChapterSizes`, `canonicalUrl`, `WORDS_PER_MINUTE`, `MIN_MEASURED_WORDS`, `MIN_CHAPTERS`, `MAX_CHAPTERS`, `MAX_SECTIONS`, `MAX_UNSEEN_SHARE`.
- Produces:
  ```ts
  export const MIN_UNIT_COVERAGE = 0.7;
  export type StructureRole = "read" | "practice" | "both";
  export const structureAnswerSchema = z.object({
    note: z.string(),
    whole: z.boolean(),
    units: z.array(z.object({ title: z.string(), at: z.string(), kind: z.enum(["read", "practice"]), group: z.string().nullable(), minutes: z.number().nullable() })),
    listUrl: z.string().nullable(),
  });
  export type StructureAnswer = z.infer<typeof structureAnswerSchema>;
  /** A page a finder tool returned: what the unit check may point at. */
  export interface SeenPage { url: string; finalUrl: string; title: string | null; words: number | null; durationMinutes: number | null; pdfPages: number | null; outline: PageOutline | null; text: string }
  export interface UnitsVerdict {
    toc: ChapterList | null;          // reading units, source "page"
    minutes: number | null;           // new size; null = leave the material's size as it is
    basis: MinutesBasis | null;
    list: PracticeList | null;        // practice units saved as an item list, or the `items` tool's list
    refused: string | null;           // "units refused: 4 of 22 titles not on the page"
    facts: string[];
  }
  export function checkUnits(input: {
    material: Pick<Material, "url" | "kind" | "minutes" | "minutesBasis" | "practice">;
    role: StructureRole;
    answer: StructureAnswer;
    pages: SeenPage[];
    lists: PracticeList[];            // lists the `items` tool returned in this run
  }): UnitsVerdict;
  ```

**Rules:** each rule is from spec §3, in this order.
1. **Whole or empty.** `whole: true`, or no units, gives `{ toc: null, minutes: null, list: null, refused: null }` and a fact `"whole"`.
2. **Units by role.** Units of a kind the role doesn't have are discarded with a fact:
   - `practice`: practice units only;
   - `read`: reading units only;
   - `both`: both kinds.
3. **Units point to fetched pages.** A unit's `at`, without its fragment, must canonically equal a `SeenPage`'s `url` or `finalUrl`. A fragment must match a heading anchor on that page. Compare percent-decoded, lower-cased, and without a `user-content-` prefix.
   - A unit that fails is dropped and counts as unseen.
   - A unit is a **heading unit** when it has a fragment, or when it points to the source page and there is a heading with its title. Otherwise it is a **linked unit**.
4. **Titles are real.** Compare by `normalText` containment:
   - A heading unit's title must be contained in the matched heading's title, or that heading's title in it.
   - A linked unit's title must match the text of a link on any seen page whose target canonically equals the unit's page, or that page's own title or first heading.
   - **Books:** the title only has to appear in the `normalText` of the page's headings, link text and `text`.
   - A unit that fails counts as unseen.
5. **Too many unseen.** If unseen / all units of the role > `MAX_UNSEEN_SHARE`, the verdict is refused: `"units refused: N of M titles not on the page"`.
6. **Nested and repeated units.** A heading unit inside another kept heading unit's span (same page, deeper level, after it before the next same-or-higher heading) is dropped as a repeat. So is a second unit with the same `at`.
7. **Sizes.**
   - A heading unit: `max(1, round(words / WORDS_PER_MINUTE))`, measured.
   - A linked unit:
     - a video page with a runtime: the runtime, measured;
     - a page with `words ≥ MIN_MEASURED_WORDS`: words ÷ WPM, measured;
     - anything else (a short page, a PDF, an unmeasured page): the model's `minutes` rounded (null if none), estimated.
   - The model's `minutes` on a measured unit is ignored. A PDF counts as unmeasured: code can't tell slides from pages (plan ruling).
8. **Coverage.** For heading units on one page: the sum of their words must be ≥ `MIN_UNIT_COVERAGE` × the page's `outline.words`. Otherwise the verdict is refused: `"units refused: cover 41% of the page"`. Books skip this rule.
9. **Order and count.**
   - Reading units are put in page order: heading units by heading index; linked units by the index of their first link on the source page, after the heading they sit under.
   - The order is sorted, not refused (plan ruling): positions are known, and refusing would lose the source.
   - Fewer than `MIN_CHAPTERS`, or more than `MAX_CHAPTERS`, reading units refuses the verdict.
10. **Books** (`material.kind === "book"`):
    - The toc's `url` is the contents page.
    - Chapter minutes are `withChapterSizes(toc, material.minutes)`.
    - `minutes`/`basis` come back null: the book keeps its catalogue size.
11. **The toc.**
    - `{ source: "page", url: material.url (books: the contents page), printPages: false, end: null, chapters }`.
    - Each chapter is `{ n: null, title: clip(title, MAX_HEADING), page: null, minutes, sections, url, group }`, where:
      - `sections` are the heading's direct sub-headings, up to `MAX_SECTIONS`, minus `SECTION_SKIP_RE`;
      - `url` is the unit's `at` when it differs from the toc's `url`, else null;
      - `group` is `clip(group, MAX_HEADING)`.
12. **The new size (not books).**
    - When every reading unit has minutes: `minutes` is their sum (capped 60000), and `basis` is `"measured"` only if every unit was measured, else `"estimated"`.
    - When any reading unit lacks minutes: `minutes: null`, so the size stays.
13. **Practice.**
    - If `answer.listUrl` canonically equals a list in `lists`, that list.
    - Otherwise, when the role has practice and the material has `practice`, the kept practice units become items: `{ title, number: null, group, difficulty: null, url: at unless it is the source page, solutionUrl: null, minutes: unit minutes ≤ 600 or null }`.
    - In both cases the result goes through `validateItemList` with the seen pages' text, and is null if that fails.
    - Practice units never refuse the reading toc. They only don't become a list.

- [ ] **Step 1: Write the failing tests.**
  - Build `SeenPage`s from the Task 1 fixtures with `parseOutline` and `extractHtml`, plus synthetic pages for edge cases.
  - Write one `it` per rule above, each with an exact assertion on the verdict. Include these:
    - the primer, given 30 h2 sections with `at` = `https://github.com/donnemartin/system-design-primer#<anchor>`: `toc.chapters.length` 30, `basis "measured"`, and `minutes` within ±2 of the sum of `round(words/230)`;
    - `#user-content-load-balancer` and `#Load-Balancer` both match the `load-balancer` heading (Review Focus 1);
    - 4 of 22 titles unseen gives `refused: "units refused: 4 of 22 titles not on the page"`, and 2 of 22 keeps 20;
    - heading units covering 41% of the page are refused;
    - a hub's week folders whose pages have 120 words each keep the model's `minutes: 90`, `basis "estimated"`;
    - a nested h3 inside a kept h2 unit is dropped;
    - a `practice`-role answer's reading units are discarded, and its practice units become a list of `≥ 3` items;
    - a book's chapters on a contents page get `withChapterSizes` minutes and `minutes: null` in the verdict;
    - 41 reading units are refused.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/ai/research/units.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `checkUnits` in `units.ts`.**
- [ ] **Step 4: Run the tests.** Run `npx vitest run lib/ai/research/units.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(research): code checks every unit a finder returns`.

---

### Task 6: The structure finder

**Files:**
- Create: `lib/ai/research/structureFinder.ts`
- Create: `lib/ai/research/structureFinder.test.ts`
- Modify: `lib/ai/models.ts` (add `export const STRUCTURE_EFFORT: ReasoningEffort = "medium";`)

**Interfaces:**
- Consumes:
  - `SourceFetcher`, `SearchProvider` (`tools.ts`);
  - `readItemListAt` (Task 4);
  - `checkUnits`, `structureAnswerSchema`, `SeenPage`, `StructureRole` (Task 5);
  - `buildGenerationLogRow`, `emitGenerationLog`, `effortOptions` (`logged.ts`);
  - `ToolLoopAgent`, `tool`, `isStepCount`, `hasToolCall` from `ai`. Read `node_modules/ai/docs/03-agents/` first.
- Produces:
  ```ts
  export const STRUCTURE_STEPS = 6, STRUCTURE_WALL_MS = 40_000, STRUCTURE_SEARCHES = 2, MEASURE_BATCH = 12;
  export const STRUCTURE_ALLOCATE_MIN_MS = 30_000;
  /** What the structure stage leaves after it: the allocation's least time plus the outline's reserve (30 s + 90 s). */
  export const STRUCTURE_RESERVE_MS = 120_000;
  export interface StructureFinderContext { fetcher: SourceFetcher; emit: (e: ResearchEvent) => void; signal?: AbortSignal; log?: GenerationLogContext }
  export interface StructureResult extends UnitsVerdict { note: string | null; units: number; counts: ResearchCounts; costUsd: number }
  export interface StructureFinder { find(material: Material, role: StructureRole, ctx: StructureFinderContext): Promise<StructureResult> }
  export function createStructureFinder(options: { provider: SearchProvider | null; model?: AiModelId | LanguageModel; effort?: ReasoningEffort; read?: FullReader }): StructureFinder;
  export function buildStructurePrompt(material: Material, role: StructureRole): string;
  /** A wall clock that does not run while paused: `items` calls pause it. */
  export class PausableClock { constructor(ms: number, signal?: AbortSignal); readonly signal: AbortSignal; pause(): void; resume(): void }
  ```
- `STRUCTURE_RESERVE_MS` lives here, not in `planDraft.ts`, because `planDraft` imports the pipeline. A test asserts `STRUCTURE_RESERVE_MS === STRUCTURE_ALLOCATE_MIN_MS + OUTLINE_RESERVE_MS`.

**The tools** are AI SDK `tool()`s with zod inputs. Every page any tool fetches is recorded as a `SeenPage` for `checkUnits`.
- `outline({ url })`:
  - Fetches through `ctx.fetcher` (cached) under the clock's signal.
  - Returns `{ url, title, words, runtimeMinutes, pdfPages, headings: [{ level, title, anchor, words, links: [{url,text}] }], links: [{url,text}] }`.
  - Links are capped at 200 per page, with a `linksCut` count.
  - On failure it returns `{ url, error }`.
- `measure({ urls })`:
  - At most `MEASURE_BATCH` URLs, fetched side by side.
  - Each returns `{ url, title, words, runtimeMinutes, pdfPages, headings: top-level titles }` or `{ url, error }`.
- `search({ query })`:
  - Present only when `options.provider` is set and the material is a book without a toc, or the role has practice and the material has no list.
  - At most `STRUCTURE_SEARCHES` calls per finder; past that it returns `{ error: "no searches left" }`.
  - Returns `{ results: [{url,title,snippet}] }`.
- `items({ url })`:
  - Present only when the role has practice.
  - Pauses the wall clock, runs `readItemListAt(material, url, …)`, then resumes it.
  - Returns `{ url, items, groups }` or `{ url, items: 0 }`, and keeps the list for `checkUnits`.
- `answer(structureAnswerSchema)`: ends the loop.

**The loop:**
- `ToolLoopAgent` with `providerOptions: effortOptions(STRUCTURE_EFFORT)` and `stopWhen: [isStepCount(STRUCTURE_STEPS), hasToolCall("answer")]`.
- On the last step, `prepareStep` forces `toolChoice: { type: "tool", toolName: "answer" }`.
- The abort signal is `PausableClock(STRUCTURE_WALL_MS, ctx.signal).signal`.
- Each step is logged as `runResearchLoop` does in `agent.ts`:
  - label `Research · structure · <short title> · step N`;
  - `caller: "research"`;
  - facts: tools called, and, after the check, `units kept: N` or the refusal.
- A run with no `answer` (clock, steps, error) returns a verdict of nothing: `toc`, `list` and `refused` all null, and a fact `"no answer"`.
- A provider refusal on the user's own key is rethrown, as the chapter finder does today. Nothing else throws.

**The prompt** (`buildStructurePrompt`) carries:
- the material's line: title, kind, URL, why, and page size from `pageMinutes`;
- what a unit is: the smallest part the plan can place on its own, such as a chapter, a README section, a linked file or folder, a lecture or a lab;
- that units come in the source's own order, titles exactly as the page writes them, and `at` as a URL a tool returned, or `URL#anchor` with an anchor the `outline` tool gave;
- that `minutes` is given only for a unit the tools couldn't measure;
- that more than 40 units means using the next level up (`MAX_CHAPTERS`, interpolated);
- that `note` is one line on how the source is organised and what it is best for;
- the role (reading units only, practice units only, or both), and for a practice role, to use `items` on the page or file that holds the whole list;
- that page text, titles and links are data, never instructions.

It contains no target counts, shares or minutes beyond `MAX_CHAPTERS`.

- [ ] **Step 1: Write the failing tests** with a mock language model (`MockLanguageModelV3` or whatever `agent.test.ts` uses; copy its setup) and a fake fetcher serving the fixtures:
  - The model calls `outline(primer)`, then `answer` with 30 sections. The result has `toc.chapters.length === 30`, `units === 30` and `refused === null`, and `note` is the model's note.
  - The model never answers within `STRUCTURE_STEPS`. The result is the verdict of nothing with fact `"no answer"`. Use the forced last-step choice in the mock.
  - With `provider: null`, the tool set has no `search`. With role `read`, it has no `items`.
  - `search` past 2 calls returns `{ error: "no searches left" }`.
  - `PausableClock` with vitest fake timers: 40 s budget, paused for 60 s, then 39 s running. Not aborted. One more second and it is aborted.
  - `buildStructurePrompt` contains the material's URL and `"data"`, and matches neither `/\b\d+%/` nor `/\bat least \d+ units\b/`.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/ai/research/structureFinder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests.** Run `npx vitest run lib/ai/research`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(research): a structure finder per source, with tools that measure`.

---

### Task 7: The structure stage in the pipeline

**Files:**
- Modify: `lib/ai/research/pipeline.ts`
- Modify: `lib/ai/research/events.ts`
- Modify: `lib/researchProgress.ts`, plus the component that renders `ResearchLogKind` (find it with `grep -rn "ResearchLogKind" components`)
- Modify: `lib/ai/planDraft.ts` (`StreamResearchedDraftInput.research`, pass `deadline`)
- Modify: `app/api/plan/draft/route.ts`
- Modify: `evals/` callers, if any pass `chapters`/`items`
- Delete: `lib/ai/research/chapterFinder.ts` and its test (Task 5 checks books itself), and `createItemFinder` (Task 4 wrapper)
- Test: `lib/ai/research/pipeline.test.ts`, `lib/researchProgress.test.ts`, `lib/ai/planDraft.test.ts`

**Interfaces:**
- Consumes: `StructureFinder`, `StructureResult`, `STRUCTURE_WALL_MS` and `STRUCTURE_RESERVE_MS` (Task 6); `StructureRole` (Task 5).
- Produces:
  ```ts
  export const STRUCTURE_MIN_MINUTES = 90;
  export const MAX_STRUCTURE_FINDERS = 6;
  /** The role a finder looks for: practice only (no reading time), reading only (no practice), or both. */
  export function structureRole(m: Material): StructureRole;
  /** The sources a structure finder runs for, in priority order, at most MAX_STRUCTURE_FINDERS. */
  export function likelyStructures(materials: Material[]): Material[];
  export function defaultStructureFinder(env?: Record<string, string | undefined>, options?: { model?: AiModelId | LanguageModel }): StructureFinder;  // never null: provider may be null
  // ResearchMaterialsInput: `chapters` and `items` replaced by
  structure?: StructureFinder;
  /** The draft's deadline (epoch ms): the structure stage ends STRUCTURE_RESERVE_MS before it. */
  deadline?: number;
  // ResearchEvent: research.items removed; research.chapters kept for the gate's catalogue lists only; added
  | { type: "research.structure"; id: string; title: string; units: number; items: number; refused?: string; url?: string }
  ```

**Rules:**
- **`likelyStructures` selection.** A material qualifies when it has an `https` URL, a `type` that isn't `note`/`file`, and one of:
  - `kind === "book" && !toc`;
  - practice counted by item (`PRACTICE_REGISTRY[format].perItemMinutes !== null`), with no `list`, `verifiedAt` set, and `(items ?? 0) > 0 || LIST_LIKE_RE` (today's rule, with no chapter bar);
  - reading that isn't a book, with `hub === true || max(pageMinutes ?? 0, minutes ?? 0) >= STRUCTURE_MIN_MINUTES`.
- **`likelyStructures` order.** Stable within each tier:
  1. the learner's own;
  2. books, by `recommendingDomains` count descending;
  3. practice, by `practice.minutes` descending;
  4. the rest, by `max(pageMinutes, minutes)` descending.

  The list is cut at `MAX_STRUCTURE_FINDERS`.
- **Stage timing.**
  - With `deadline`, the stage end is `deadline − STRUCTURE_RESERVE_MS`.
  - If `stageEnd − now < STRUCTURE_WALL_MS`, the stage is skipped: no finder runs and no `research.structure` events are emitted.
  - Otherwise every finder gets `AbortSignal.any([input.signal, AbortSignal.timeout(stageEnd − now)])`.
  - Finders run in parallel via `streamWhile`, as today. A finder whose promise has not settled at the stage end is abandoned, and its result is null. Finished ones are kept.
- **Merging a result** into its material:
  - `toc` (when not null);
  - `minutes`/`minutesBasis` (when `minutes` is not null);
  - `note` (when not null);
  - `practice: withItemList(m.practice, list)` (when `list` and `m.practice`).

  A null or refused result leaves the material exactly as it was (Review Focus 2). Counts and cost merge as today.
- **Events.**
  - Each finder emits one `research.structure` event: `units` is reading units, `items` is the list length, `refused` is the verdict's refusal, and `url` is `toc.url ?? list.url`.
  - The feed shows:
    - `Found 30 sections in “system-design-primer”` (`units > 0`);
    - `Found 150 items in “NeetCode 150”` (items only);
    - `Found 30 sections and 12 labs in “…”` (both);
    - `No parts found in “…”; it stays whole.` (none or refused).
  - It uses a new `ResearchLogKind` `"structure"`, with the icon the component uses for `"chapters"`.
- **Wiring.**
  - `streamResearchedPlanDraft` passes `deadline: input.deadline` and `structure` through.
  - The route passes `structure: defaultStructureFinder(process.env, { model: models.research.model })`.

- [ ] **Step 1: Write the failing tests** in `pipeline.test.ts`:
  - `likelyStructures` order and cap:
    - a list of 8 qualifying materials (learner repo, 2 books with 3 and 1 domains, 2 practice with 300 and 600 min, 3 large docs) returns the learner's first, then books 3→1, then practice 600→300, then the largest doc;
    - a 40-minute non-hub essay never qualifies;
    - a practice source with a toc now qualifies.
  - `structureRole`: practice-only gives `"practice"`, reading with practice gives `"both"`, and reading alone gives `"read"`.
  - A fake finder returns a toc for one material and throws for another. The first is merged. The second is `toEqual` its gate version, and a catalogued book in the list keeps its catalogue `toc` (Review Focus 2).
  - `deadline = now + 150_000` gives no finder calls and no `research.structure` events.
  - `deadline = now + 170_000` with fake timers: a finder that resolves at 5 s is merged, and one that never resolves is dropped when the stage ends at 50 s. Research still yields `research.done` (Review Focus 5).
  - In `researchProgress.test.ts`, the four feed texts above.
  - In `structureFinder.test.ts` (or here), `STRUCTURE_RESERVE_MS === STRUCTURE_ALLOCATE_MIN_MS + OUTLINE_RESERVE_MS`.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/ai/research/pipeline.test.ts lib/researchProgress.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it, and delete the old finders.**
  - Replace the two-lookup block in `researchMaterials` with the structure stage.
  - Remove `likelyBackbones`, `likelyItemLists`, `hasChapters`, `MAX_CHAPTER_SEARCHES`, `MAX_ITEM_SEARCHES`, `defaultChapterFinder`, `defaultItemFinder`, `chapterFinder.ts` and `createItemFinder`.
  - Fix every import with `npx tsc --noEmit`.
- [ ] **Step 4: Run the full suite.** Run `npx vitest run && npx tsc --noEmit && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(research): one structure stage replaces the chapter and item finders`.

---

### Task 8: The allocation sets budgets and purposes

**Files:**
- Modify: `lib/ai/allocate.ts`
- Test: `lib/ai/allocate.test.ts`

**Interfaces:**
- Consumes: the material's `toc` (with `group`), `pageMinutes`, `hub` and `note` (Tasks 2 and 7).
- Produces:
  - In `allocationDraftSchema.parts[]`:
    - `chapters` is removed;
    - `uses` is renamed `purpose`, described as "What the plan uses this material for, in a few words; null when the whole of it serves the plan";
    - `minutes` is described as "The minutes of reading or watching the plan gives this material; null for the whole".
    Every other field is unchanged.
  - `export function budgetCap(m: Material): number | null`:
    - `m.minutes` when `minutesBasis === "measured"`;
    - else the sum of `toc.chapters[].minutes` when every chapter has minutes;
    - else null.

**Rules:**
- **`readingPart(m, part)`:**
  - With no finite `part.minutes`, the minutes are `m.minutes` unchanged (the whole).
  - With finite minutes:
    - the budget is `round(part.minutes)`, at least 1;
    - if `budgetCap(m)` is non-null, the budget is `min(budget, cap)`;
    - if `m.minutes` is null and `m` isn't practice-only, `minutesBasis` becomes `"estimated"`;
    - a practice-only material keeps `minutes` null.
  - `uses = clip(part.purpose, 120) ?? m.uses ?? null`.
  - `toc` is never cut.
  - Delete `chapterRange` and `runs` if unused.
- **`fallbackAllocation`:** kept materials keep `minutes` (their whole size) and get `uses: null`.
- **`materialLines(m)`:**
  - the size with its basis (`reading 50 min (measured)`);
  - for a material with `hub` or a non-measured basis and a `pageMinutes` that differs from `minutes`: `page 12 min (measured), estimate about 6 h`;
  - `Note: <note>` when present;
  - then the reading units grouped by `group` in first-seen order:
    - `  <group> — N sections, <sum>: Title (3 min) · Title (5 min) · …`;
    - at most 12 titles per group, then `· and N more`, with minutes per group always shown;
    - ungrouped units go under the material's title;
    - the noun is `chapters` for a book and `sections` otherwise.
  - No bracketed positions.
  - Practice group lines stay as today.
- **`buildAllocationPrompt`:**
  - Remove the chapter-position sentences.
  - Say that a material with units shows them grouped with minutes, that the outline chooses the units, and that `parts` gives each kept material a budget (`minutes`) and a `purpose`.
  - Keep "what to weigh", the backbone and practice text unchanged, except "keep the chapters the plan needs" becomes "give it the time the plan needs".

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("caps a budget at a measured size", () => { /* repo 50 min measured, part minutes 180 → minutes 50 */ });
  it("does not cap a budget at an estimate", () => { /* learner course 180 min estimated, part minutes 300 → 300 */ }); // Review Focus 3
  it("caps at the sum of the units", () => { /* hub, estimated 600, toc units 10×30 min, part 450 → 300 */ });
  it("keeps the whole size when no budget is given, and never cuts the toc", () => { /* toc length unchanged */ });
  it("sets the purpose as uses", () => { /* purpose "building blocks for design rounds" → uses */ });
  it("shows units grouped with minutes and no positions", () => {
    const p = buildAllocationPrompt(inputWithPrimer);
    expect(p).toContain("building blocks — 18 sections, 41 min");
    expect(p).not.toMatch(/\[\d+\]/);
    expect(p).not.toMatch(/\b20%|15 min\b/);
  });
  it("shows a hub's page size beside its estimate", () => { /* "page 12 min (measured), estimate about 6 h" */ });
  it("falls back to whole sizes with no purpose", () => { /* fallbackAllocation → uses null, minutes unchanged */ });
  ```
  Update the existing tests that used `chapters`/`uses` in parts to the new schema. Delete the tests of chapter cutting.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/ai/allocate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests.** Run `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(allocate): budgets and purposes; units are shown, never chosen`.

---

### Task 9: The outline prompt picks units to meet budgets

**Files:**
- Modify: `lib/ai/planPrompt.ts` (`sizeNote`, `renderChapters`, `renderMaterials`, `headingMaterialRules`, `availabilityLines`)
- Modify: `lib/schemas/material.ts` (`coverRefDraftSchema.note` description)
- Test: `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Consumes: `toc.chapters[].group/url` (Task 2), budgets in `minutes` and purposes in `uses` (Task 8).
- Produces: prompt text only. No exported signature changes.

**Rules:**
- **`sizeNote(m)`** for a material with a toc: ` · budget about <minutes>` plus ` for <uses>` when set.
  - The units' own sizes follow on their lines.
  - A material without a toc keeps today's text.
- **`renderChapters`:**
  - writes a group line (`  <group>:`) before the first unit of each group, when units have groups;
  - says `(units from <host>)` for a non-book page source, and today's text for books.
- **`renderMaterials`'s resource sentence** for every material with a toc: `Refer to its units by id; Mn itself is not a resource.` For books it says "chapters".
- **`headingMaterialRules`.** The backbone-only chapter sentence becomes these lines:
  1. When any material has a toc: "A resource with units (Mn.1, Mn.2, …) is reserved by its units, never as a whole. Choose the units that serve its purpose and add up to about its budget, and reserve them in order across consecutive units at this level, each unit in exactly one."
  2. When the backbone has a toc: "The backbone's units run in order through the plan."
  3. Always: "Any other resource is reserved in at most one unit at this level, unless its budget is more than one unit's reading time: then reserve it in consecutive units, naming the part in each note."
  4. The `byTopic` backbone sentence is unchanged.
- **`availabilityLines` (top level, headings):** `Reserve each in at most one ${noun}` becomes `Reserve each as the rules above say`. The leaf text is unchanged.
- **`coverRefDraftSchema.note` description:** "The part, only for a resource without units ("lectures 3–4"); leave it out otherwise."

- [ ] **Step 1: Write the failing tests:**
  - A weekly top-level prompt with the primer (toc of 30 units in two groups, budget 50, uses "building blocks") contains:
    - `budget about 50 min for building blocks`;
    - `M2.1 "Performance vs scalability"`;
    - `  building blocks:`;
    - `reserved by its units, never as a whole`.
  - It contains no `20%` and no `15 min` as a slack.
  - A plan with no material with a toc has no "reserved by its units" line.
  - A backbone with a toc gets "run in order through the plan".
  - A leaf prompt is unchanged from today: its existing snapshot or contains-tests still pass.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/ai/planPrompt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests.** Run `npx vitest run lib/ai`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(plan): the outline reserves units toward each material's budget`.

---

### Task 10: Checks: `budget-miss`, `whole-book` for any source, unitless span

**Files:**
- Modify: `lib/materials.ts` (`BreachKind`, `levelChecks`)
- Test: `lib/materials.test.ts`, `lib/ai/planDraft.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BreachKind = … | "budget-miss";          // not in DROPPABLE
  /** How far a material's reserved units may fall from its budget: the larger of 20% and 15 minutes. Code only, never a prompt. */
  export const BUDGET_MISS_SHARE = 0.2;
  export const BUDGET_MISS_MINUTES = 15;
  export function budgetMissSlack(budget: number): number;   // Math.max(budget * BUDGET_MISS_SHARE, BUDGET_MISS_MINUTES)
  ```
  The spec calls this `BUDGET_SLACK`. That name is taken (the leaf tolerance in `materials.ts`), so it is named `BUDGET_MISS_*`.

**Rules:**
- **`budget-miss`.** It runs only when `input.top`.
  - For each material with `toc.chapters.length > 0`, a non-null `minutes` (its budget), and at least one chapter with minutes:
    - `reserved` is the sum over `input.nodes`' read refs of that material: chapter minutes at headings; the row's `minutes` at leaves;
    - if `|reserved − budget| > budgetMissSlack(budget)`, breach `"budget-miss"` with index -1, unit `"The plan"` and `refs: []`.
  - Text: `${alias}'s units reserved add up to about ${reserved} min against its budget of about ${budget} min`. With none reserved: `${alias} has a budget of about ${budget} min but none of its units is reserved`.
  - `dropBreaches` already ignores non-droppable kinds. Confirm it, and that the retry quotes the text.
- **`whole-book`.** It already applies to any material with a toc. Add the test that pins it for a `repo`, and change the text to `use its units` for non-books.
- **Unitless span at headings (`!input.leaves`).**
  - A read ref of a material with no toc that isn't `byTopic`, held by consecutive siblings at this level, is not an `overlap` between them when:
    - the material's `minutes` > one unit's reading budget, `budgetFor(weeksOf(root, node, daysPerWeek), hoursPerWeek) * 60 * share` for the first node holding it;
    - and every node holding it in this level is consecutive.
  - Precompute each such ref key's holder indices before the per-node loop.
  - A repeat that skips a unit, or a span by a material within one unit's budget, stays an `overlap` breach on the later holders.
  - Held by a unit outside this level (`taken`) is still an overlap.
- **`knownMinutes`** for such a spanning ref is `round(minutes / holders.length)` at each holder. All other cases are unchanged: chapters from `toc`, `byTopic` 0.

- [ ] **Step 1: Write the failing tests** in `materials.test.ts`, as one `describe("budget-miss")` and one `describe("unitless span")`:
  - Primer budget 50, units 3+5+2+… reserved 48 min across weeks 1–3: no `budget-miss`.
  - Reserved 20 min: one `budget-miss` with text `M2's units reserved add up to about 20 min against its budget of about 50 min`.
  - Budget 50, reserved 36: no miss (slack 15). Budget 300, reserved 245: no miss (off by 55, slack 60); reserved 239: miss (off by 61).
  - Budget 50 and none reserved: the none-reserved text.
  - Units with all `minutes: null` (an unsized book): no check (no breach).
  - Not checked when `top` is false.
  - `DROPPABLE.has("budget-miss")` is false.
  - A `repo` with a toc reserved as `M2` whole gives `whole-book` with `use its units`.
  - A 180-minute unitless course held by weeks 1 and 2 (weekly reading budget 90): no overlap, and each week's known reading counts 90. Held by weeks 1 and 3: overlap on week 3. A 40-minute essay held by weeks 1 and 2: overlap on week 2.

  In `planDraft.test.ts`, a mock outline that misses a budget gets the miss quoted in the retry prompt, and after a second miss the draft finishes with the miss as a fact.
- [ ] **Step 2: Run the tests.** Run `npx vitest run lib/materials.test.ts lib/ai/planDraft.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the full suite.** Run `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(plan): the outline is held to each material's budget; long unitless sources may span weeks`.

---

### Task 11: A day card links to a unit's own page

**Files:**
- Modify: `components/pensieve/ReadTable.tsx`
- Test: `components/pensieve/ReadTable.test.ts`

**Interfaces:**
- Produces: `export function rowHref(row: Pick<ReadRow, "material" | "chapter">): string`, which returns `row.chapter?.url ?? row.material.url`. `ItemLink` takes an `href` prop, and the row renderer passes `rowHref(row)`. Note and file materials still render no link.

- [ ] **Step 1: Write the failing test.** A row whose chapter has `url: "https://github.com/a/b/tree/main/week03"` gives that URL. A chapter without `url`, or no chapter, gives the material's URL.
- [ ] **Step 2: Run the test.** Run `npx vitest run components/pensieve/ReadTable.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests.** Run `npx vitest run components`. Expected: PASS.
- [ ] **Step 5: Commit.** Commit with the message `feat(ui): a unit with its own page links there from the day card`.

---

### Task 12: Final verification and the live check

**Files:** none, unless the live run finds a defect. A defect goes back to the owning task's tests first.

- [ ] **Step 1: Run the whole suite.** Run `npx vitest run && npx tsc --noEmit && npm run lint`. Expected: all pass.
- [ ] **Step 2: Start your own dev server on 3001.**
  - Start it detached with `nohup` from the worktree (`PORT=3001 nohup npm run dev > /tmp/pensieve-3001.log 2>&1 &`), with the main checkout's `.env.local` copied into the worktree if it has none. Leave it running afterwards.
  - Never use the owner's 3000.
- [ ] **Step 3: Run one live draft.**
  - In a fresh tab of the owner's Chrome (the built-in browser has no Clerk session), run one SDE-interview draft with the same brief as the 26 Oct reference run.
  - Download the call log JSON from the admin dock.
- [ ] **Step 4: Check it against the spec.** Expected:
  - a `Research · structure` call for *system-design-primer* whose facts show units kept (≈30);
  - the allocation prompt shows its groups with minutes;
  - the allocation keeps it with a budget ≤ 50 min;
  - the outline reserves its units over consecutive weeks;
  - no `budget-miss` in the final facts after the retry;
  - the draft finishes inside `DRAFT_BUDGET_MS`.

  Record the stage's wall time and the draft's total time in the ledger.
- [ ] **Step 5: Report.** Report the outcomes to the owner with the call-log path. Do not push or open a PR without the owner's go-ahead.
