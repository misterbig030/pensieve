# Chapters as Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each chapter of a listed book becomes a resource the outline reserves and assigns by id, with containment and exclusivity checked in code, review rows, sizes from the list, and the free resources stated in the prompt.

**Architecture:** References gain `chapter` and `activity`; aliases become `M1.3`; `levelChecks` replaces `levelFacts` and returns breaches that `draftLevel` retries once and then drops; prompts render chapter aliases, an availability block and new rules; the lesson prompt and the UI render chapter titles from the list.

**Tech Stack:** Next.js 16, TypeScript, Zod, Drizzle (Postgres; PGlite in tests), Vercel AI SDK `streamObject` (mocked in tests), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-chapter-resources-design.md`

## Global Constraints

- Alias of a chapter: `M<i>.<k>`, `k` = 1-based position in `toc.chapters`; a bare `M<i>` for a listed book is a `whole-book` breach.
- `activity` is `"read"` or `"review"`; `"read"` when absent. `chapter` is null (wire) / 0 (database) for a whole resource.
- `node_materials` primary key: `(node_id, source_id, chapter)`; migration `0011_chapter_refs`, additive.
- Breach kinds: `outside`, `overlap`, `whole-book`, `review-before-read`, `over-budget`, `unread-reservation`. Droppable after the retry: the first four. One retry per level, its units not streamed, label `… (retry)`.
- Breach facts are logged as `breach: <text>`; drops as `dropped <aliases> from <unit>: <kind>`.
- `SHARE_TOLERANCE` = 1.25; share = `readingShare ?? MUST_SHARE` (0.6). Heading budget = `budgetFor(len, hoursPerWeek) × 60 × share`.
- Chapter rows across the consecutive leaves that read one chapter sum to its listed size; rounding remainder goes to the last row; all-zero rows split evenly.
- Positionless chapter lists (page path) share the book's minutes evenly.
- Prompt copy is the spec's §Prompt changes, verbatim, with aliases and unit nouns interpolated.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never bare `git stash`. `npx drizzle-kit generate` needs a TTY: run it through `python3 -c 'import pty; pty.spawn(["npx","drizzle-kit","generate","--name","chapter_refs"])'`.
- Test command for the whole task: `npx vitest run <file>`; the suite: `npx vitest run`; types: `npx tsc --noEmit`.

## Review Focus

1. A plan saved before this change, whose week reserves a listed book as a whole with a prose note, is expanded or split: its days may read any chapter of that book without an `outside` breach, and old rows render as before. (Task 4, test "a whole-resource cover admits any chapter".)
2. A page-found list whose chapters have no numbers (`n` null): aliases work by position, the prompt line reads `M1.3 "Title"` with no `ch. 3`, and the lesson row omits `ch.`. (Task 7 and Task 9 tests "unnumbered chapters".)
3. The retry call fails: on the app's key the first answer is kept with its breaching rows dropped; on the user's key a provider refusal is rethrown. (Task 6, test "a failed retry".)
4. A review reservation is not a read reservation: a child reading under a review cover is `outside`; a child reviewing under a read cover is fine when an earlier unit read it. (Task 4, test "review covers".)
5. The live-check case: a leaf week assigned chapters 1 and 2 (247 min) against 6 h/week at 40% reading (144 min) is `over-budget`, triggers the retry, and stays a fact if the retry repeats it. (Task 4 and Task 6.)

---

### Task 1: Reference schemas carry a chapter and an activity

**Files:**
- Modify: `lib/schemas/material.ts:100-152`
- Test: `lib/schemas/material.test.ts`

**Interfaces:**
- Produces: `REF_ACTIVITIES = ["read", "review"] as const`, `type RefActivity`; `materialRefSchema` and `coverRefSchema` with `chapter: z.number().int().min(1).max(MAX_CHAPTERS).nullable().optional()` and `activity: z.enum(REF_ACTIVITIES).optional()`; draft schemas with `activity` optional and new descriptions; `normalizeMaterialRef` / `normalizeCoverRef` returning `activity: ref.activity ?? "read"` and no `chapter` (the resolver sets it); `chapterAt(toc: ChapterList | null | undefined, chapter: number | null | undefined): Chapter | null`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("references with chapters", () => {
  it("accepts chapter and activity on both ref shapes and defaults neither", () => {
    expect(materialRefSchema.parse({ id: "a", tier: "must", minutes: 10, note: null, chapter: 3, activity: "review" })).toMatchObject({ chapter: 3, activity: "review" });
    expect(coverRefSchema.parse({ id: "a", note: null })).toEqual({ id: "a", note: null });
    expect(materialRefSchema.safeParse({ id: "a", tier: "must", minutes: 10, note: null, chapter: 0 }).success).toBe(false);
    expect(materialRefSchema.safeParse({ id: "a", tier: "must", minutes: 10, note: null, chapter: 41 }).success).toBe(false);
  });
  it("normalizes a draft to activity read and leaves the chapter to the resolver", () => {
    expect(normalizeMaterialRef({ id: " M1.3 ", tier: "must", minutes: 42.6 })).toEqual({ id: "M1.3", tier: "must", minutes: 43, note: null, activity: "read" });
    expect(normalizeCoverRef({ id: "M2", activity: "review" })).toEqual({ id: "M2", note: null, activity: "review" });
  });
  it("chapterAt returns the chapter at a 1-based position or null", () => {
    const toc = { source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: [{ n: 1, title: "A", page: null, minutes: null, sections: [] }] };
    expect(chapterAt(toc, 1)?.title).toBe("A");
    expect(chapterAt(toc, 2)).toBeNull();
    expect(chapterAt(toc, null)).toBeNull();
    expect(chapterAt(undefined, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/schemas/material.test.ts`
Expected: FAIL — `chapterAt` is not exported; `activity` missing from the normalized object.

- [ ] **Step 3: Implement**

In `lib/schemas/material.ts`: export `REF_ACTIVITIES` and `RefActivity` beside `MATERIAL_TIERS`; add the two fields to both wire schemas; on the drafts set `id` description `"A resource id from the list, e.g. M3 or M1.3"`, add `activity: z.enum(REF_ACTIVITIES).optional().describe('"read" (the default) or "review": revisiting a resource an earlier unit read')`, and describe `note` as `'The part: for a chapter, the sections this unit covers ("Post-Training; Sampling"); otherwise the part ("§2 only", "lectures 3–4")'` (material) and `'The part only for a resource without chapters ("lectures 3–4"); leave it out otherwise'` (cover). Normalizers add `activity`. Add `chapterAt` after `clip`.

- [ ] **Step 4: Run tests and types**

Run: `npx vitest run lib/schemas/material.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean (the new fields are optional, so existing literals still type).

- [ ] **Step 5: Commit**

```bash
git add lib/schemas/material.ts lib/schemas/material.test.ts
git commit -m "feat(schema): references carry a chapter position and an activity"
```

---

### Task 2: The database keys rows by chapter and keeps the activity

**Files:**
- Modify: `lib/db/schema.ts:120-138`, `lib/db/planQueries.ts:20-30, 60-75, 92-108, 322-340`, `components/pensieve/PlanWorkspace.tsx:721-728`
- Create: `drizzle/0011_chapter_refs.sql`, `drizzle/meta/0011_snapshot.json`, journal entry (generated)
- Test: `lib/db/materials.test.ts`

**Interfaces:**
- Consumes: `REF_ACTIVITIES`, `RefActivity` (Task 1).
- Produces: `nodeMaterials.chapter` (integer, not null, default 0), `nodeMaterials.activity` (text enum, not null, default `'read'`), primary key `(nodeId, sourceId, chapter)`; `refsByNode` emits `chapter: row.chapter || null, activity: row.activity`; `refRows` writes `chapter: ref.chapter ?? 0, activity: ref.activity ?? "read"` and dedupes on `${id}#${chapter ?? 0}`; `getTrackNodeMaterials` and `getNodeReadList` select both columns.

- [ ] **Step 1: Write the failing tests** (in the existing `describe("persistence of materials")`, using its `plan()` and `MATERIALS`)

```ts
it("keeps chapter and activity through save and load, two chapters of one book on one node", async () => {
  const root = makeRoot([
    makeNode({ level: "week", title: "W", summary: "s", len: 7, budgetHours: 6, materials: [
      { id: "M1", tier: "must", minutes: 107, note: null, chapter: 1 },
      { id: "M1", tier: "must", minutes: 140, note: "Post-Training; Sampling", chapter: 2 },
      { id: "M3", tier: "should", minutes: 20, note: null, activity: "review" },
    ] }),
    makeNode({ level: "month", title: "M", summary: "s", len: 28, covers: [{ id: "M1", note: null, chapter: 3 }, { id: "M1", note: null, chapter: 4, activity: "review" }] }),
  ]);
  const id = await createTrackWithPlan({ userId: "u-ch", title: "T", granularity: "week", root, materials: MATERIALS, hoursPerWeek: 6, split: null });
  const detail = (await getTrackDetail(id, "u-ch"))!;
  const [week, month] = detail.root.children!;
  expect(week.materials!.map((r) => [r.chapter, r.activity, r.minutes])).toEqual([[1, "read", 107], [2, "read", 140], [null, "review", 20]]);
  expect(month.covers!.map((r) => [r.chapter, r.activity])).toEqual([[3, "read"], [4, "review"]]);
});
it("loads rows written before chapters as whole reads", async () => {
  const detail = (await getTrackDetail(trackId, "u1"))!;                       // the track the file's beforeAll creates
  const day = detail.root.children![0].children![1];
  const evals = detail.materials.find((m) => m.title === "Evals guide")!;
  await db.insert(nodeMaterials).values({ nodeId: day.id, sourceId: evals.id, role: "assigned", tier: "should", minutes: 5, note: "ch. 2", position: 9 });   // no chapter, no activity: the defaults
  const again = (await getTrackDetail(trackId, "u1"))!;
  expect(again.root.children![0].children![1].materials!.at(-1)).toEqual({ id: evals.id, tier: "should", minutes: 5, note: "ch. 2", chapter: null, activity: "read" });
});
```

Extend the existing "carries a week's reservation into the days it is planned into" test: the week's Read table has `{ id: "M1", chapter: 2, tier: "must", minutes: 140, note: null }`; after `insertChildren(..., manualSplit = true)` the week's covers include `{ chapter: 2, activity: "read" }`.

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/db/materials.test.ts`
Expected: FAIL — unknown column `chapter`; duplicate key on `(node_id, source_id)`.

- [ ] **Step 3: Change the schema and generate the migration**

In `lib/db/schema.ts` add the two columns and the three-column `primaryKey`. Generate with the TTY command from Global Constraints. Expected SQL in `drizzle/0011_chapter_refs.sql`:

```sql
ALTER TABLE "node_materials" DROP CONSTRAINT "node_materials_node_id_source_id_pk";--> statement-breakpoint
ALTER TABLE "node_materials" ADD COLUMN "chapter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_materials" ADD COLUMN "activity" text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE "node_materials" ADD CONSTRAINT "node_materials_node_id_source_id_chapter_pk" PRIMARY KEY("node_id","source_id","chapter");
```

- [ ] **Step 4: Map the columns**

`refsByNode` (both branches) adds `chapter: row.chapter || null, activity: row.activity`; its `Pick<NodeMaterialRow, …>` adds the two names. `refRows` dedupes on `${ref.id}#${ref.chapter ?? 0}` and writes both columns in both branches. `getTrackNodeMaterials` and `getNodeReadList` select `chapter: nodeMaterials.chapter, activity: nodeMaterials.activity`. `PlanWorkspace.splitWeek` maps `{ id: r.id, chapter: r.chapter, activity: r.activity, note: r.note }`.

- [ ] **Step 5: Run tests and types**

Run: `npx vitest run lib/db/materials.test.ts && npx tsc --noEmit`
Expected: PASS (PGlite applies 0011); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts drizzle lib/db/planQueries.ts components/pensieve/PlanWorkspace.tsx lib/db/materials.test.ts
git commit -m "feat(db): node_materials keyed by chapter, with an activity"
```

---

### Task 3: Aliases name chapters and resolvers set them

**Files:**
- Modify: `lib/materials.ts:17-78`
- Test: `lib/materials.test.ts` ("aliases and refs")

**Interfaces:**
- Consumes: `Material.toc`, `MaterialRef`, `CoverRef` (Task 1).
- Produces:

```ts
export interface ResolvedAlias { id: string; chapter: number | null }
export interface MaterialAliases {
  alias(id: string, chapter?: number | null): string | undefined;   // "M1", "M1.3"
  resolve(alias: string): ResolvedAlias | undefined;
  chapters(id: string): number;                                      // toc length, 0 without a list
}
export function aliasMaterials(materials: Pick<Material, "id" | "toc">[]): MaterialAliases
export function refKey(ref: { id: string; chapter?: number | null }): string          // "uuid#3", "uuid#0"
export function formatAliases(refs: ResolvedAlias[], aliases: MaterialAliases): string  // "M1.1–M1.4, M3"
```
`resolveMaterialRefs` / `resolveCoverRefs` keep their `{ refs, unknown }` shape, set `chapter` from the alias, and dedupe on `refKey`.

- [ ] **Step 1: Write the failing tests**

```ts
const toc = (n: number) => ({ source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `C${i + 1}`, page: null, minutes: null, sections: [] })) });
const aliases = aliasMaterials([{ id: "uuid-a", toc: toc(4) }, { id: "uuid-b" }]);
it("names chapters by position and resolves them back", () => {
  expect(aliases.alias("uuid-a", 3)).toBe("M1.3");
  expect(aliases.alias("uuid-a")).toBe("M1");
  expect(aliases.resolve("m1.3")).toEqual({ id: "uuid-a", chapter: 3 });
  expect(aliases.resolve("[M2]")).toEqual({ id: "uuid-b", chapter: null });
  expect(aliases.resolve("M1.5")).toBeUndefined();     // past the list
  expect(aliases.resolve("M2.1")).toBeUndefined();     // no list
  expect(aliases.resolve("M9")).toBeUndefined();
  expect(aliases.chapters("uuid-a")).toBe(4);
  expect(aliases.chapters("uuid-b")).toBe(0);
});
it("resolves chapter refs, dedupes on id and chapter, keeps a bare book id for the checks", () => {
  const { refs, unknown } = resolveMaterialRefs(
    [{ id: "M1.2", tier: "must", minutes: 30 }, { id: "M1.2", tier: "should", minutes: 5 }, { id: "M1.3", tier: "must", minutes: 20, activity: "review" }, { id: "M1", tier: "must", minutes: 10 }, { id: "M7", tier: "must", minutes: 1 }],
    aliases,
  );
  expect(unknown).toEqual(["M7"]);
  expect(refs.map((r) => [r.chapter, r.activity, r.minutes])).toEqual([[2, "read", 30], [3, "review", 20], [null, "read", 10]]);
});
it("collapses runs of consecutive chapters", () => {
  expect(formatAliases([{ id: "uuid-a", chapter: 1 }, { id: "uuid-a", chapter: 2 }, { id: "uuid-a", chapter: 3 }, { id: "uuid-b", chapter: null }, { id: "uuid-a", chapter: 4 }], aliases)).toBe("M1.1–M1.3, M2, M1.4");
  expect(refKey({ id: "x", chapter: null })).toBe("x#0");
});
```

Update the existing "maps list positions to M ids and back" assertion to `toEqual({ id: "uuid-a", chapter: null })`.

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/materials.test.ts -t "aliases and refs"`
Expected: FAIL — `alias` ignores the chapter; `resolve` returns a string.

- [ ] **Step 3: Implement**

`aliasMaterials` keeps `toAlias`/`fromAlias` maps for base ids plus a `counts` map from `toc?.chapters.length ?? 0`. `resolve` matches `/^\[?\s*(m\d+)(?:\.(\d+))?\s*\]?$/i`, looks the base up, and returns undefined when a chapter is given on a material with none or beyond its count. `formatAliases` walks in order and merges an item whose `id` equals the previous one's and whose `chapter` is the previous chapter + 1 into a run, printed `first–last`. Both resolvers call `resolve`, spread the normalized ref with `{ id, chapter }`, and dedupe on `refKey`.

- [ ] **Step 4: Run and type-check**

Run: `npx vitest run lib/materials.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/materials.ts lib/materials.test.ts
git commit -m "feat(materials): chapter aliases M1.3 and resolvers that set the chapter"
```

---

### Task 4: `levelChecks` finds breaches, with a plan fixture

**Files:**
- Create: `lib/__fixtures__/aiEngineeringPlan.ts`
- Modify: `lib/materials.ts:122-233` (replace `levelFacts`)
- Test: `lib/materials.test.ts` (replace the `levelFacts` describe)

**Interfaces:**
- Consumes: `aliasMaterials`, `refKey`, `formatAliases`, `ResolvedAlias` (Task 3); `labelOf`, `walk`, `parentOf`, `budgetFor`, `childLevel` from `lib/planTree`.
- Produces:

```ts
export type BreachKind = "outside" | "overlap" | "whole-book" | "review-before-read" | "over-budget" | "unread-reservation";
export const DROPPABLE: ReadonlySet<BreachKind>;   // the first four
export interface Breach { kind: BreachKind; index: number; unit: string; refs: ResolvedAlias[]; text: string }  // index: position among `nodes`; -1 for unread-reservation
export interface LevelChecks { facts: string[]; breaches: Breach[] }
export interface LevelCheckInput {
  root: PlanNode; nodes: PlanNode[]; leaves: boolean; top: boolean;
  materials: (Pick<Material, "id" | "toc" | "minutes"> & { backbone?: boolean })[];   // replaces backboneId
  unknownIds: string[]; hoursPerWeek?: number; readingShare?: number | null;
}
export function levelChecks(input: LevelCheckInput): LevelChecks
export function treeChecks(root: PlanNode, materials: LevelCheckInput["materials"], opts: { hoursPerWeek?: number; readingShare?: number | null }): LevelChecks & { nodes: PlanNode[] }  // every sibling group in walk order, top = parent is root; `nodes` is the flat walk order and each Breach.index points into it
export function dropBreaches(nodes: PlanNode[], breaches: Breach[]): string[]  // removes the refs of DROPPABLE breaches from nodes[breach.index] (deleting `materials`/`covers` when empty); one "dropped <aliases> from <unit>: <kind>" line per droppable breach
```

Fixture (`lib/__fixtures__/aiEngineeringPlan.ts`): the plan drafted on 2026-10-17 in the new shapes, cleaned of its three overlaps. Exports `AIE_TOC` (ten chapters: 107, 140, 93, 126, 98, 127, 126, 93, 99, 96 minutes; titles as in the spec's prompt excerpt; sections on ch. 1 `["The Rise of AI Engineering", "Foundation Model Use Cases", "Planning AI Applications", "The AI Engineering Stack"]` and ch. 2 `["Training Data", "Modeling", "Post-Training", "Sampling"]`, `[]` elsewhere; `page: null`, `printPages: false`, `end: null`, source `catalogue`), `AIE_MATERIALS` (ids `aie` book backbone 1105 min with the toc; `agents` essay 12; `evals` essay 79; `oaievals` docs 30; `rag` course 240 (the real course is 26 h, trimmed so month 2 fits its budget); `prachub` essay 10; `techscreen` essay 16; titles as in the prompt excerpt; every material's `url` is `https://example.com/<id>`), `AIE_HOURS = 6`, `AIE_SHARE = 0.4`, and `aiePlan(): PlanNode` = `layout(makeRoot([...]))` with Month 1 (30 days, covers `aie` ch. 1–4 read, `evals`) containing week leaves W1 (7 days, budgetHours 6, reads `aie#1` must 107, `aie#2` must 140), W2 (7, 6, reads `aie#3` must 93, `aie#4` must 126), W3 (8, 7, reads `evals` must 79, `oaievals` should 30), W4 (8, 7, reviews `aie#1`–`aie#4` must 15 each); Month 2 (30, covers `aie#5`, `aie#6`, `agents`, `rag`); Month 3 (30, covers `aie#10`, `prachub`, `techscreen`). Node ids `m1`, `w1`…`w4`, `m2`, `m3`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("levelChecks", () => {
  const share = { hoursPerWeek: AIE_HOURS, readingShare: AIE_SHARE };
  const weeksOf = (root: PlanNode) => root.children![0].children!;
  const read = (chapter: number | null, minutes: number, id = "aie") => ({ id, tier: "must" as const, minutes, note: null, chapter });
  const days = (root: PlanNode, specs: { chapter: number | null; minutes?: number; activity?: "read" | "review"; id?: string }[]) => {
    const w1 = weeksOf(root)[0];
    w1.covers = w1.materials!.map((r) => ({ id: r.id, chapter: r.chapter, note: null })); delete w1.materials;
    w1.children = specs.map((s, i) => makeNode({ id: `d${i + 1}`, level: "day", title: `D${i + 1}`, summary: "s", len: 1, materials: [{ ...read(s.chapter, s.minutes ?? 20, s.id), activity: s.activity }] }));
    layout(root);
    return w1.children;
  };

  it("the fixture as drafted breaches only on weeks 1 and 2's budgets", () => {
    const root = aiePlan();
    const { breaches, facts } = levelChecks({ root, nodes: weeksOf(root), leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share });
    expect(breaches.map((b) => b.text)).toEqual([
      "Week 1's must-reading is 247 min against a budget of about 144 min",
      "Week 2's must-reading is 219 min against a budget of about 144 min",
    ]);
    expect(facts).toEqual([]);   // reviews do not count as the backbone going backwards
  });
  it("days outside the reservation and overlapping a sibling week are breaches naming the holder", () => {
    const root = aiePlan();
    const placed = days(root, [{ chapter: 1 }, { chapter: 1 }, { chapter: 2 }, { chapter: 2 }, { chapter: 3 }, { chapter: 3 }, { chapter: 4 }]);
    const { breaches } = levelChecks({ root, nodes: placed, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share });
    expect(breaches.map((b) => [b.kind, b.index, b.text])).toEqual([
      ["outside", 4, "Day 5 reads M1.3, which Week 1 did not reserve"],
      ["overlap", 4, "Day 5 reads M1.3, which Week 2 holds"],
      ["outside", 5, "Day 6 reads M1.3, which Week 1 did not reserve"],
      ["overlap", 5, "Day 6 reads M1.3, which Week 2 holds"],
      ["outside", 6, "Day 7 reads M1.4, which Week 1 did not reserve"],
      ["overlap", 6, "Day 7 reads M1.4, which Week 2 holds"],
    ]);
  });
  it("two siblings reading one chapter: the later one breaches, naming the first", () => {
    const root = aiePlan();
    const placed = days(root, [{ chapter: 1 }, { chapter: 1 }]);
    placed[1].materials = [{ ...read(1, 20), minutes: 20 }];
    // A second day reading ch. 1 is a shared chapter, not an overlap; reading ch. 2 in both days 1 and 2 is fine too.
    expect(levelChecks({ root, nodes: placed, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share }).breaches).toEqual([]);
    const weeks = weeksOf(aiePlan());
    weeks[1].materials!.push(read(1, 107));
    const r2 = aiePlan(); r2.children![0].children = weeks; layout(r2);
    expect(levelChecks({ root: r2, nodes: weeks, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share }).breaches.map((b) => b.text)).toContain("Week 2 reads M1.1, which Week 1 holds");
  });
  it("a bare book id is a whole-book breach; a review of something unread is a breach; a review of something read is not", () => {
    const root = aiePlan();
    const weeks = weeksOf(root);
    weeks[0].materials!.push(read(null, 30));
    let out = levelChecks({ root, nodes: weeks, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share });
    expect(out.breaches.map((b) => b.text)).toContain("Week 1 refers to M1 as a whole; use its chapters");
    expect(out.breaches.map((b) => b.kind)).not.toContain("review-before-read");   // week 4 reviews ch. 1–4, read by weeks 1–2
    weeks[3].materials!.push({ id: "aie", chapter: 5, tier: "should", minutes: 10, note: null, activity: "review" });
    out = levelChecks({ root, nodes: weeks, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share });
    expect(out.breaches.map((b) => b.text)).toContain("Week 4 reviews M1.5, which no earlier unit reads");
  });
  it("review covers: a child reading under one is outside; a child reviewing under a read cover is fine", () => {
    const root = aiePlan();
    const w4 = weeksOf(root)[3];
    w4.covers = [{ id: "aie", chapter: 1, note: null, activity: "review" }]; delete w4.materials;
    w4.children = [makeNode({ id: "d1", level: "day", title: "D", summary: "s", len: 1, materials: [read(1, 20)] })]; layout(root);
    expect(levelChecks({ root, nodes: w4.children, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share }).breaches.map((b) => b.kind)).toEqual(["outside", "overlap"]);
    w4.children[0].materials = [{ ...read(1, 20), tier: "should", activity: "review" }];
    expect(levelChecks({ root, nodes: w4.children, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share }).breaches).toEqual([]);
  });
  it("a whole-resource cover admits any chapter, as plans saved before chapters did", () => {
    const root = aiePlan();
    const w1 = weeksOf(root)[0];
    w1.covers = [{ id: "aie", note: "Ch. 1; Ch. 2" }]; delete w1.materials;
    w1.children = [makeNode({ id: "d1", level: "day", title: "D", summary: "s", len: 1, materials: [read(2, 20)] })]; layout(root);
    expect(levelChecks({ root, nodes: w1.children, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share }).breaches).toEqual([]);
  });
  it("a heading over its budget, an unread reservation, and the top level's overlap", () => {
    const root = aiePlan();
    const [m1, m2] = root.children!;
    m2.covers!.push({ id: "aie", chapter: 4, note: null });
    const out = levelChecks({ root, nodes: root.children!, leaves: false, top: true, materials: AIE_MATERIALS, unknownIds: [], ...share });
    expect(out.breaches.map((b) => b.text)).toEqual(["Month 2 reserves M1.4, which Month 1 holds"]);
    m1.covers = [...m1.covers!, { id: "rag", note: null }];   // 545 + 240 min against 576 × 1.25
    expect(levelChecks({ root, nodes: root.children!, leaves: false, top: true, materials: AIE_MATERIALS, unknownIds: [], ...share }).breaches.map((b) => b.text)).toContain(
      "Month 1 reserves about 785 min of reading against a budget of about 576 min",
    );
    const weeks = weeksOf(aiePlan()); const r2 = aiePlan(); weeks[1].materials = [read(3, 93)]; r2.children![0].children = weeks; layout(r2);
    expect(levelChecks({ root: r2, nodes: weeks, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share }).breaches.map((b) => b.text)).toContain("Month 1 reserved M1.4, which no week reads");
  });
  it("keeps the facts: unknown ids, no must, total over budget, chapter order, unreserved chapters", () => {
    const w1 = makeNode({ id: "w1", level: "week", title: "A", summary: "a", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "must", minutes: 400, note: "ch. 3" }] });
    const w2 = makeNode({ id: "w2", level: "week", title: "B", summary: "b", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "should", minutes: 30, note: "ch. 2" }] });
    const root = layout(makeRoot([w1, w2]));
    const out = levelChecks({ root, nodes: [w1, w2], leaves: true, top: true, materials: [{ id: "B", backbone: true }], unknownIds: ["M9"] });
    expect(out.facts).toEqual(["dropped unknown M9", "no must: Week 2", "Week 1 over budget: 400 of 360 min", "backbone ch. 2 after ch. 3 (Week 2)"]);
    expect(out.breaches.map((b) => b.text)).toEqual(["Week 1's must-reading is 400 min against a budget of about 216 min"]);
  });
  it("dropBreaches removes the rows of droppable breaches and reports them", () => {
    const root = aiePlan();
    const placed = days(root, [{ chapter: 1 }, { chapter: 3 }]);
    const { breaches } = levelChecks({ root, nodes: placed, leaves: true, top: false, materials: AIE_MATERIALS, unknownIds: [], ...share });
    expect(dropBreaches(placed, breaches)).toEqual(["dropped M1.3 from Day 2: outside", "dropped M1.3 from Day 2: overlap"]);
    expect(placed[1].materials).toBeUndefined();
  });
  it("treeChecks runs every sibling group", () => {
    const root = aiePlan();
    weeksOf(root)[1].materials!.push(read(1, 107));
    const out = treeChecks(root, AIE_MATERIALS, share);
    expect(out.breaches.map((b) => b.text)).toEqual([
      "Week 1's must-reading is 247 min against a budget of about 144 min",
      "Week 2 reads M1.1, which Week 1 holds",
      "Week 2's must-reading is 326 min against a budget of about 144 min",
    ]);
    expect(out.facts).toContain("backbone ch. 7, 8, 9 not reserved");
    expect(out.nodes[out.breaches[1].index].id).toBe("w2");
  });
});
```

Port the two existing `levelFacts` tests that still apply ("checks days against the learner's hours…", "continues chapter order from leaves earlier in the plan") to `levelChecks` with `materials: [{ id: "X" }, { id: "Y" }]` / `[{ id: "B", backbone: true }]`; the day test's share case now expects the breach text `"Day 1's must-reading is 45 min against a budget of about 15 min"` and, with `readingShare: null`, only the `"Day 2 over budget: 60 of 50 min"` fact (share falls back to 0.6).

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/materials.test.ts -t "levelChecks"`
Expected: FAIL — `levelChecks`, `dropBreaches`, `treeChecks`, `aiePlan` not found.

- [ ] **Step 3: Write the fixture, then implement**

Implementation notes beyond the signatures: a reservation key set is built from the parent's read covers (`refKey`; a whole cover on a listed book adds every chapter key); "taken" is built by walking `root` and skipping the placed units, the parent and its ancestors (`parentOf` chain), and descendants of placed units, taking read covers and read materials, keyed to the holder's `labelOf`; a placed sibling's read keys join "taken" after it is examined so later siblings see it. Regressions consider read rows only, never reviews. Breach order within a unit: `whole-book`, `outside`, `overlap`, `review-before-read`, `over-budget`; `unread-reservation` last, index -1, unit = the parent's label, text `${parent} reserved ${aliases}, which no ${childNoun} reads`. The leaf over-budget text: `${unit}'s must-reading is ${must} min against a budget of about ${Math.round(budget × share)} min`, emitted when `must > budget × share × SHARE_TOLERANCE + 10`; the heading text `${unit} reserves about ${known} min of reading against a budget of about ${Math.round(budgetFor(len, hoursPerWeek) × 60 × share)} min`, emitted when `known > that × SHARE_TOLERANCE`. `chapterRegressions` reads chapter numbers from `ref.chapter` (as `toc.chapters[chapter - 1].n`, falling back to the position) and from `parseChapters(note)` for rows without one.

- [ ] **Step 4: Run and type-check**

Run: `npx vitest run lib/materials.test.ts && npx tsc --noEmit`
Expected: PASS for materials; tsc fails only in `lib/ai/planDraft.ts` (`levelFacts` gone) — fixed in Task 6. If anything else fails, fix it here.

- [ ] **Step 5: Commit**

```bash
git add lib/__fixtures__/aiEngineeringPlan.ts lib/materials.ts lib/materials.test.ts
git commit -m "feat(materials): levelChecks with breaches, treeChecks, dropBreaches, and the AI-engineering plan fixture"
```

---

### Task 5: Sizes come from the list

**Files:**
- Modify: `lib/materials.ts` (new export), `lib/ai/research/chapters.ts:196-209`
- Test: `lib/materials.test.ts`, `lib/ai/research/chapters.test.ts:89-104`

**Interfaces:**
- Produces: `sizeChapterRows(nodes: PlanNode[], materials: Pick<Material, "id" | "toc">[]): void` — for every `(id, chapter)` with a listed `minutes`, the read rows across `nodes` that carry it are rescaled to sum to it; `withChapterSizes` shares `bookMinutes` evenly when no chapter has a position.

- [ ] **Step 1: Write the failing tests**

```ts
describe("sizeChapterRows", () => {
  const row = (chapter: number, minutes: number, activity: "read" | "review" = "read") => ({ id: "aie", tier: "must" as const, minutes, note: null, chapter, activity });
  const day = (id: string, rows: ReturnType<typeof row>[]) => makeNode({ id, level: "day", title: id, summary: "s", len: 1, materials: rows });
  it("rescales a shared chapter to its size, keeping proportions, remainder to the last row", () => {
    const nodes = [day("a", [row(1, 20)]), day("b", [row(1, 20)]), day("c", [row(1, 20)])];
    sizeChapterRows(nodes, AIE_MATERIALS);
    expect(nodes.map((n) => n.materials![0].minutes)).toEqual([36, 36, 35]);
    const skew = [day("a", [row(2, 10)]), day("b", [row(2, 30)])];
    sizeChapterRows(skew, AIE_MATERIALS);
    expect(skew.map((n) => n.materials![0].minutes)).toEqual([35, 105]);
  });
  it("splits evenly when the model wrote zeros, leaves reviews and unsized chapters alone", () => {
    const nodes = [day("a", [row(3, 0), row(1, 25, "review")]), day("b", [row(3, 0)])];
    sizeChapterRows(nodes, AIE_MATERIALS);
    expect(nodes.map((n) => n.materials!.map((r) => r.minutes))).toEqual([[47, 25], [46]]);
    const unsized = [day("a", [row(1, 20)])];
    sizeChapterRows(unsized, [{ id: "aie", toc: { ...AIE_TOC, chapters: AIE_TOC.chapters.map((c) => ({ ...c, minutes: null })) } }]);
    expect(unsized[0].materials![0].minutes).toBe(20);
  });
});
// chapters.test.ts, replacing the last assertion of "leaves minutes null without a book size or positions":
it("shares the book's minutes evenly when no chapter has a position", () => {
  const noPos = { ...base, end: null, chapters: base.chapters.map((c) => ({ ...c, page: null })) };
  expect(withChapterSizes(noPos, 900).chapters.map((c) => c.minutes)).toEqual([300, 300, 300]);
  expect(withChapterSizes({ ...noPos, chapters: noPos.chapters.slice(0, 2) }, 101).chapters.map((c) => c.minutes)).toEqual([51, 50]);
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/materials.test.ts lib/ai/research/chapters.test.ts`
Expected: FAIL — `sizeChapterRows` missing; even split returns nulls.

- [ ] **Step 3: Implement**

`sizeChapterRows`: collect `[node, rowIndex]` per `refKey` for read rows with a chapter; look the size up with `chapterAt`; rescale `Math.round(minutes × size / total)` and set the last row to `size − sum(others)`; with `total === 0` give each `Math.round(size / k)` and the last the remainder. `withChapterSizes`: when every `page` is null and `bookMinutes` is set, assign `Math.round(bookMinutes / k)` to each and the remainder to the last; keep the existing branch when positions exist.

- [ ] **Step 4: Run and type-check**

Run: `npx vitest run lib/materials.test.ts lib/ai/research/chapters.test.ts && npx tsc --noEmit`
Expected: PASS; tsc as at the end of Task 4.

- [ ] **Step 5: Commit**

```bash
git add lib/materials.ts lib/materials.test.ts lib/ai/research/chapters.ts lib/ai/research/chapters.test.ts
git commit -m "feat(materials): chapter rows sized from the list; positionless lists split evenly"
```

---

### Task 6: Drafting retries a breaching level once, then drops and sizes

**Files:**
- Modify: `lib/ai/planDraft.ts:2, 75-86, 103-150, 183-245`
- Test: `lib/ai/planDraft.test.ts`

**Interfaces:**
- Consumes: `levelChecks`, `dropBreaches`, `sizeChapterRows`, `Breach`, `DROPPABLE` (Tasks 4–5); `providerError` from `./providerError`.
- Produces: `StreamUnitsInput.silent?: boolean` (no `unit` events); `draftLevel` behaviour: on breaches a second `streamUnits` call with `label: \`${label} (retry)\``, `silent: true`, and the prompt plus the corrections block; facts logged as `breach: <text>` and `dropped …`; `RETRY_HEADER = (n) => \`Your previous answer broke these rules; return all ${n} units again, corrected:\``.

- [ ] **Step 1: Write the failing tests** (same `fakeStream` / `mockedStreamObject` harness; materials from `lib/__fixtures__/aiEngineeringPlan`)

```ts
describe("breaches while drafting", () => {
  beforeEach(() => { mockedStreamObject.mockReset(); });
  const ctx = { topic: "AI engineering", days: 7, granularity: "day" as const, materials: AIE_MATERIALS, hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" } };
  const dayUnits = (chapters: number[]) => chapters.map((c, i) => ({ title: `D${i + 1}`, summary: "s", materials: [{ id: `M1.${c}`, tier: "must" as const, minutes: 20 }] }));
  const tree = () => { const r = aiePlan(); const w1 = r.children![0].children![0]; w1.covers = w1.materials!.map((m) => ({ id: m.id, chapter: m.chapter, note: null })); delete w1.materials; return r; };

  it("retries once, silently, when a level breaches, and keeps the corrected answer", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 1, 2, 2, 3, 3, 4]))).mockReturnValueOnce(fakeStream(dayUnits([1, 1, 1, 2, 2, 2, 2])));
    const calls: ModelCall[] = []; const events: PlanExpandEvent[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) events.push(e);
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "child")).toHaveLength(7);                       // the retry streamed nothing
    const retryPrompt = mockedStreamObject.mock.calls[1][0].prompt as string;
    expect(retryPrompt).toContain("Your previous answer broke these rules; return all 7 units again, corrected:\n- Day 5 reads M1.3, which Week 1 did not reserve");
    expect(calls.map((c) => c.label)).toEqual(["Week 1 · 7 days", "Week 1 · 7 days (retry)"]);
    expect(calls[0].facts).toContain("breach: Day 5 reads M1.3, which Week 2 holds");
    const finish = events.at(-1); if (finish?.type !== "finish") throw new Error("no finish");
    expect(finish.children.map((d) => d.materials![0].chapter)).toEqual([1, 1, 1, 2, 2, 2, 2]);
    expect(finish.children.map((d) => d.materials![0].minutes)).toEqual([36, 36, 35, 35, 35, 35, 35]);   // sized from 107 and 140
  });
  it("drops rows that still breach after the retry and records the drops", async () => {
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3]))).mockReturnValueOnce(fakeStream(dayUnits([1, 3])));
    const calls: ModelCall[] = []; let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split", log: { onCall: (c) => void calls.push(c) } })) if (e.type === "finish") children = e.children;
    expect(children[1].materials).toBeUndefined();
    expect(calls[1].facts).toEqual(expect.arrayContaining(["dropped M1.3 from Day 2: outside", "dropped M1.3 from Day 2: overlap"]));
  });
  it("an over-budget leaf triggers the retry and then stays a fact", async () => {
    const weeks = [{ title: "W1", summary: "s", materials: [{ id: "M1.1", tier: "must" as const, minutes: 107 }, { id: "M1.2", tier: "must" as const, minutes: 140 }] }, { title: "W2", summary: "s", materials: [{ id: "M1.3", tier: "must" as const, minutes: 93 }] }];
    mockedStreamObject.mockReturnValueOnce(fakeStream(weeks)).mockReturnValueOnce(fakeStream(weeks));
    const calls: ModelCall[] = [];
    for await (const _ of streamPlanDraft({ ...ctx, days: 14, granularity: "week", log: { onCall: (c) => void calls.push(c) } })) { /* drain */ }
    expect(mockedStreamObject).toHaveBeenCalledTimes(2);
    expect(calls[1].facts).toContain("breach: Week 1's must-reading is 247 min against a budget of about 144 min");
    expect(calls[1].facts.some((f) => f.startsWith("dropped"))).toBe(false);
  });
  it("a failed retry keeps the first answer with its drops on the app's key and rethrows a refusal on the user's", async () => {
    const refusal = new APICallError({ message: "credit balance is too low", url: "u", requestBodyValues: {}, statusCode: 400, responseBody: "", isRetryable: false });
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3]))).mockImplementationOnce(failingStream(refusal));
    let children: PlanNode[] = [];
    for await (const e of streamExpandNode({ ...ctx, tree: tree(), nodeId: "w1", reason: "split" })) if (e.type === "finish") children = e.children;
    expect(children).toHaveLength(2);
    expect(children[1].materials).toBeUndefined();
    mockedStreamObject.mockReset();
    mockedStreamObject.mockReturnValueOnce(fakeStream(dayUnits([1, 3]))).mockImplementationOnce(failingStream(refusal));
    const user = { ...ctx, outlineModel: { id: "claude-sonnet-5-5", model: {} as never, keyOwner: "user" as const } };
    await expect((async () => { for await (const _ of streamExpandNode({ ...user, tree: tree(), nodeId: "w1", reason: "split" })) { /* drain */ } })()).rejects.toBe(refusal);
  });
});
```

`failingStream(error)` returns the stream shape of the existing "rethrows a stream failure" test: a `partialObjectStream` that calls the options' `onError({ error })` and ends, with `object`, `usage` and `finishReason` as never-settling promises; it must read `onError` from the `streamObject` options, so use `mockImplementationOnce` for that call. The `APICallError` import is from `@ai-sdk/provider`, as in `chapterFinder.test.ts`. `ResolvedModel` is `{ model: AiModelId | LanguageModel; id: AiModelId; keyOwner: KeyOwner }`. Update the existing "puts covers on headings…" test for the new facts strings where it asserts them.

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/ai/planDraft.test.ts`
Expected: FAIL — one call, no retry, `levelFacts` import error.

- [ ] **Step 3: Implement**

`streamUnits`: with `silent`, skip the `unit` yields. `draftLevel`: `check` builds `final` as today, runs `levelChecks` (with `materials: ctx.materials`), stores the result in a closure `last`, and returns `[...facts, ...breaches.map((b) => \`breach: ${b.text}\`)]`; on the second attempt (closure `attempt === 2`) it also runs `dropBreaches(final, breaches)` and appends those facts; on either attempt it ends with `if (leaf) sizeChapterRows(final, ctx.materials)`. After the first stream: if `last.breaches.length > 0`, set `attempt = 2` and run `streamUnits` again with `prompt: \`${prompt}\n${RETRY_HEADER(n)}\n${breaches.map((b) => \`- ${b.text}\`).join("\n")}\``, `label: \`${label} (retry)\``, `silent: true`, adding its cost; catch: rethrow when `ctx.outlineModel.keyOwner === "user" && providerError(error)`, else `console.error` and run `dropBreaches(final, last.breaches)` then `sizeChapterRows` on the first answer. Yield `done` with `final`.

- [ ] **Step 4: Run and type-check**

Run: `npx vitest run lib/ai/planDraft.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/planDraft.ts lib/ai/planDraft.test.ts
git commit -m "feat(draft): a breaching level is retried once, then its breaching rows are dropped and chapter rows sized"
```

---

### Task 7: Prompts name chapters as resources and say what is free

**Files:**
- Modify: `lib/ai/planPrompt.ts:43-56, 115-152, 192-310, 320-348`
- Test: `lib/ai/planPrompt.test.ts`

**Interfaces:**
- Consumes: `MaterialAliases`, `formatAliases`, `refKey` (Task 3).
- Produces: `renderChapters(toc, options: { sections: boolean; alias?: string })`; `renderMaterials` appending `Refer to its chapters by id; ${alias} itself is not a resource.` to a listed book's line and prefixing chapter lines with `${alias}.${k} `; `renderRefs` output `covers M1.1–M1.4, M3` / `covers M1.1–M1.4, M3 · reviews M2` / `reads M1.2 must 35 min (Post-Training; Sampling); M3 should 79 min · reviews M1.1 should 20 min`; `availabilityLines(input: UnitsPromptInput, aliases: MaterialAliases): string[]`; the heading and leaf rules of the spec; `CHAPTER_LINE` removed; the revision materials rule of the spec.

- [ ] **Step 1: Write the failing tests** (materials from the fixture; `A = aliasMaterials(AIE_MATERIALS)`)

```ts
describe("chapters as resources in prompts", () => {
  it("renders chapter lines with aliases and the not-a-resource sentence", () => {
    const text = renderMaterials(AIE_MATERIALS, undefined, { sections: true });
    expect(text).toContain('"AI Engineering: Building Applications with Foundation Models" — Chip Huyen, 2024 <https://example.com/aie> · about 18.4 h. Refer to its chapters by id; M1 itself is not a resource.');
    expect(text).toContain('  M1.2 ch. 2 "Understanding Foundation Models" · about 2.3 h — Training Data; Modeling; Post-Training; Sampling');
    expect(text).toContain('  M1.10 ch. 10 "AI Engineering Architecture and User Feedback" · about 1.6 h');
    expect(renderMaterials([AIE_MATERIALS[1]])).not.toContain("not a resource");
  });
  it("unnumbered chapters keep their alias and lose the ch. prefix", () => {
    const m = { ...AIE_MATERIALS[0], toc: { ...AIE_TOC, chapters: AIE_TOC.chapters.slice(0, 3).map((c) => ({ ...c, n: null })) } };
    expect(renderMaterials([m])).toContain('  M1.2 "Understanding Foundation Models" · about 2.3 h');
  });
  it("renders references with collapsed chapter runs and activities", () => {
    const root = aiePlan();
    expect(renderRefs(root.children![0], A)).toBe("covers M1.1–M1.4, M3");
    expect(renderRefs(root.children![0].children![3], A)).toBe("reviews M1.1 must 15 min; M1.2 must 15 min; M1.3 must 15 min; M1.4 must 15 min");
    const w1 = root.children![0].children![0];
    w1.materials![1].note = "Post-Training; Sampling";
    expect(renderRefs(w1, A)).toBe("reads M1.1 must 107 min; M1.2 must 140 min (Post-Training; Sampling)");
    expect(renderRefs({ covers: [{ id: "aie", chapter: 1, note: null }, { id: "agents", note: "first half", activity: "review" }] }, A)).toBe("covers M1.1 · reviews M2 (first half)");
  });
  it("the availability block names the reservation and what other units hold", () => {
    const root = aiePlan(); const w1 = root.children![0].children![0];
    w1.covers = w1.materials!.map((m) => ({ id: m.id, chapter: m.chapter, note: null })); delete w1.materials; layout(root);
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "day", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "day", spans: Array(7).fill(1), startDay: 1, totalDays: 90, tree: root, parentId: "w1", unitsAreLeaves: true });
    expect(prompt).toContain("This unit's reservation, the only resources its days may use: M1.1–M1.2.\nHeld by other units: M1.3–M1.4 (Week 2); M3, M4 (Week 3); M1.5–M1.6, M2, M5 (Month 2); M1.10, M6, M7 (Month 3).");
    expect(prompt).not.toContain("Take them first from what the unit marked");
    expect(prompt).not.toContain("Where a book's chapters are listed");
  });
  it("the top level is told everything is free", () => {
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", level: "month", spans: [30, 30, 30], startDay: 1, totalDays: 90, unitsAreLeaves: false, decideSplit: true });
    expect(prompt).toContain("Every resource is free. Reserve each in at most one month; the book's chapters in order.");
    expect(prompt).toContain(`Each resource is read in at most one unit at this level. M1's chapters are resources of their own (M1.1, M1.2, …): reserve them in order across the units, each chapter in exactly one unit, and never refer to M1 itself.`);
    expect(prompt).toContain(`A unit may also reserve a review of resources that an earlier unit reads, with activity "review". A review is not a reading, so it may name resources another unit holds.`);
  });
  it("leaf rules state spanning, single reading, and reviews", () => {
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "week", spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true });
    expect(prompt).toContain(`Materials: for each unit, list its Read table in "materials" as { id, tier, minutes, note, activity }.`);
    expect(prompt).toContain(`Each resource's size is in the list. A chapter longer than one unit's reading time spans consecutive units: list it in each with the part in the note; across those units its minutes add up to its size. A resource is read once: do not assign what another unit reads, and never refer to M1 itself.`);
    expect(prompt).toContain(`A review (activity "review") revisits a resource an earlier unit read. Its minutes count for this unit, and it may name resources other units hold.`);
  });
  it("an unlisted backbone keeps the topic-only rule at both levels", () => {
    const m = [{ ...AIE_MATERIALS[0], toc: null }];
    expect(buildUnitsPrompt({ topic: "t", materials: m, granularity: "week", level: "month", spans: [30], startDay: 1, totalDays: 30, unitsAreLeaves: false })).toContain("Never write a chapter number or a chapter title you were not given.");
    expect(buildUnitsPrompt({ topic: "t", materials: m, granularity: "week", level: "week", spans: [7], startDay: 1, totalDays: 7, unitsAreLeaves: true })).toContain("its chapters are not listed");
  });
  it("the revision rule names chapter ids and reviews", () => {
    const root = aiePlan();
    expect(buildRevisionPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "x" })).toContain(
      `Ids may name a resource (M3) or a chapter (M1.3); a resource is read in one unit, and a review of something read earlier has activity "review".`,
    );
  });
});
```

Rewrite the existing tests that assert the old rule copy ("asks headings to reserve the backbone's chapters in order…", "gives leaves their budget, the parent's reservation…", "switches the backbone rules on the list…", "leaves the general chapter line out…") against the new sentences; keep the "chapters in prompts" rendering tests, adding the `M1.k ` prefix to their expected lines and the not-a-resource sentence to the book line.

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/ai/planPrompt.test.ts`
Expected: FAIL on every new assertion.

- [ ] **Step 3: Implement**

`renderChapters` prefixes `${alias}.${i + 1} ` when `alias` is given; `renderMaterials` passes `aliases.alias(m.id)` and appends the sentence. `renderRefs` groups covers and reads by activity, prints read covers through `formatAliases` with a whole resource's note in parentheses, read rows as today with the alias from `aliases.alias(r.id, r.chapter)`, then ` · reviews …` in the same style. `availabilityLines`: with `tree` and `parentId`, the parent's read covers through `formatAliases` in the first sentence (`This unit's reservation, the only resources its ${noun}s may use: …`), then `Held by other units: …` from every node that is not the parent nor an ancestor of it, in `walk` order, each `${formatAliases(readRefs)} (${labelOf})`, omitted when empty; a parent with no covers gets `Take them from the list above, matching each unit's ground.` plus the held sentence; the top level gets `Every resource is free. Reserve each in at most one ${noun}${listedBackbone ? "; the book's chapters in order" : ""}.`. The rules are the spec's §Rules copy with `${UNIT_NOUN[childLevel(level)]}s` in the heading's first sentence, `M${backbone + 1}` for the book, the availability lines in place of the old reservation sentence, and `where the reservation has material for it` when the parent has covers. Delete `CHAPTER_LINE`. Replace the revision rule.

- [ ] **Step 4: Run and type-check**

Run: `npx vitest run lib/ai/planPrompt.test.ts lib/ai/planDraft.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/planPrompt.ts lib/ai/planPrompt.test.ts
git commit -m "feat(prompt): chapters as resources, the availability block, and the read-once rules"
```

---

### Task 8: Revisions resolve chapter ids and drop breaching rows

**Files:**
- Modify: `lib/ai/planRevision.ts:118-136`
- Test: `lib/ai/planRevision.test.ts`

**Interfaces:**
- Consumes: `treeChecks`, `dropBreaches` (Task 4); resolvers (Task 3).
- Produces: `revisePlanTree` applies, checks (`treeChecks`) and drops (`dropBreaches`) inside `loggedGenerateObject`'s `check` hook, so `breach: …` and `dropped …` facts land on the revision call's log row.

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves chapter ids on revised units", () => {
  const original = withRefs();                     // existing helper, aliases now built with { id: "uuid-book", toc: toc(4) }
  const result = applyRevision(original, assignRefs(original), { units: [{ ref: "n1", title: "Intro", summary: "a", days: 1, materials: [{ id: "M1.2", tier: "must", minutes: 40, activity: "review" }] }, { ref: "n2", title: "Metrics", summary: "b", days: 1 }] }, 0, "day", aliases);
  expect(result.children![0].materials).toEqual([{ id: "uuid-book", tier: "must", minutes: 40, note: null, chapter: 2, activity: "review" }]);
});
// revisePlanTree: mock the model the way lib/ai/dailyContent.test.ts mocks generateObject for generateDailyContent
// (vi.mock("ai", …) with a generateObject that returns { object, usage }); the existing tests in this file do not call it.
it("drops a duplicated chapter and a bare book id after one call, with facts", async () => {
  const two = layout(makeRoot([
    makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, materials: [{ id: "aie", tier: "must", minutes: 107, note: null, chapter: 1 }] }),
    makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1 }),
  ]));
  mockedGenerateObject.mockResolvedValueOnce({
    object: { units: [
      { ref: "n1", title: "A", summary: "a", days: 1, materials: [{ id: "M1.1", tier: "must", minutes: 107 }] },
      { ref: "n2", title: "B", summary: "b", days: 1, materials: [{ id: "M1.1", tier: "must", minutes: 20 }, { id: "M1", tier: "should", minutes: 10 }, { id: "M3", tier: "should", minutes: 79 }] },
    ] },
    usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
  } as never);
  const calls: ModelCall[] = [];
  const { tree } = await revisePlanTree({ topic: "t", materials: AIE_MATERIALS, granularity: "day", tree: two, lockBefore: 0, changeRequest: "x", log: { onCall: (c) => void calls.push(c) } });
  expect(calls).toHaveLength(1);
  expect(calls[0].facts).toEqual(expect.arrayContaining(["breach: Day 2 reads M1.1, which Day 1 holds", "breach: Day 2 refers to M1 as a whole; use its chapters", "dropped M1.1 from Day 2: overlap", "dropped M1 from Day 2: whole-book"]));
  expect(tree.children![1].materials).toEqual([{ id: "evals", tier: "should", minutes: 79, note: null, chapter: null, activity: "read" }]);
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run lib/ai/planRevision.test.ts`
Expected: FAIL — no `chapter` on the resolved ref; no drops.

- [ ] **Step 3: Implement**

`applyRevision` needs no change beyond the resolvers already setting `chapter`. `loggedGenerateObject` already takes `check?: (object: T) => string[]`, run on the validated object and appended to the call's facts. `revisePlanTree` passes one: it runs `applyRevision` on the object, then `treeChecks(tree, input.materials, { hoursPerWeek: input.hoursPerWeek, readingShare: readingShareOf(input.split) })`, then `dropBreaches(checks.nodes, checks.breaches)`, keeps the tree in a closure, and returns `[...checks.facts, ...checks.breaches.map((b) => \`breach: ${b.text}\`), ...dropped]`. The function then returns the closure's tree. One call, one log row, the facts on it.

- [ ] **Step 4: Run and type-check**

Run: `npx vitest run lib/ai/planRevision.test.ts lib/materials.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/planRevision.ts lib/ai/planRevision.test.ts lib/materials.ts lib/materials.test.ts
git commit -m "feat(revision): chapter ids resolve and breaching rows are dropped with facts"
```

---

### Task 9: The lesson prompt names the chapter and its sections

**Files:**
- Modify: `lib/ai/dailyContent.ts:9-34, 54-60`, `app/tracks/[id]/nodes/[nodeId]/actions.ts:28-40`
- Test: `lib/ai/dailyContent.test.ts`

**Interfaces:**
- Consumes: `chapterAt`, `RefActivity`, `Chapter` (Task 1); `getNodeReadList` rows with `chapter` and `activity` and `source.toc` (Task 2).
- Produces: `LessonMaterial.chapter?: Pick<Chapter, "n" | "title" | "sections"> | null`, `LessonMaterial.activity?: RefActivity`; row copy below; lead sentence addition when any row is a review.

- [ ] **Step 1: Write the failing tests**

```ts
it("names the chapter, its sections from the note or the list, and reviews", () => {
  const base = { url: "https://example.com/aie", type: "link" as const, title: "AI Engineering", tier: "must" as const, minutes: 35 };
  const ch2 = { n: 2, title: "Understanding Foundation Models", sections: ["Training Data", "Modeling", "Post-Training", "Sampling"] };
  const prompt = buildDailyContentPrompt({ title: "D", summary: "s", materials: [
    { ...base, note: "Post-Training; Sampling", chapter: ch2 },
    { ...base, note: null, chapter: ch2, tier: "should", minutes: 140 },
    { ...base, note: null, chapter: { n: 1, title: "Introduction", sections: [] }, activity: "review", tier: "should", minutes: 20 },
    { ...base, note: null, chapter: { n: null, title: "Untitled part", sections: [] } },
  ] });
  expect(prompt).toContain('- AI Engineering (https://example.com/aie) — ch. 2 "Understanding Foundation Models" · sections: Post-Training; Sampling — must, 35 min');
  expect(prompt).toContain('- AI Engineering (https://example.com/aie) — ch. 2 "Understanding Foundation Models" · sections: Training Data; Modeling; Post-Training; Sampling — should, 140 min');
  expect(prompt).toContain('- AI Engineering (https://example.com/aie) — review of ch. 1 "Introduction" — should, 20 min');
  expect(prompt).toContain('- AI Engineering (https://example.com/aie) — "Untitled part" — must, 35 min');
  expect(prompt).toContain("Rows marked review revisit material the learner read earlier: recap and connect it to today, do not teach it afresh.");
  expect(buildDailyContentPrompt({ title: "D", summary: "s", materials: [{ ...base, note: "Ch. 4 §2" }] })).not.toContain("Rows marked review");
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run lib/ai/dailyContent.test.ts`
Expected: FAIL — rows print `note` in the meta and no chapter.

- [ ] **Step 3: Implement**

`row`: `part` = `${activity === "review" ? "review of " : ""}${n !== null ? \`ch. ${n} \` : ""}"${title}"` plus ` · sections: ${note ?? sections.join("; ")}` when either exists, for rows with a chapter; a whole-resource review's part is `review`; `meta` keeps `[tier, minutes, chapter ? null : note]`. Append the review sentence to the reading-list lead when any row has `activity === "review"`. In the action, map `chapter: chapterAt(r.source.toc, r.chapter || null)` and `activity: r.activity`.

- [ ] **Step 4: Run and type-check**

Run: `npx vitest run lib/ai/dailyContent.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/dailyContent.ts lib/ai/dailyContent.test.ts "app/tracks/[id]/nodes/[nodeId]/actions.ts"
git commit -m "feat(lesson): rows name the chapter, its sections and reviews"
```

---

### Task 10: The UI shows chapter titles and review rows from data

**Files:**
- Modify: `components/pensieve/ReadTable.tsx:5-18, 95-110, 130-160`, `components/pensieve/PlanTree.tsx:331-358`
- Test: `components/pensieve/ReadTable.test.ts` (new)

**Interfaces:**
- Consumes: `chapterAt`, `Chapter`, `RefActivity` (Task 1).
- Produces: `ReadRow { material; tier; minutes; note; chapter: Chapter | null; activity: RefActivity; key: string }`; `readRowsFor` fills `chapter` from `material.toc`, `activity` (`read` default) and `key = \`${id}#${ref.chapter ?? 0}\``; `chapterLabel(c: Chapter): string` = `Ch. ${n} ${title}` or `title`; `ReviewPill`; `CoversRow` chips `${title} · ch. 1–4` and `Review: ${title} · ch. 1–4`.

- [ ] **Step 1: Write the failing test**

```ts
import { readRowsFor, chapterLabel } from "./ReadTable";
it("fills chapter, activity and a key per row", () => {
  const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
  const rows = readRowsFor([{ id: "aie", tier: "must", minutes: 35, note: "Post-Training; Sampling", chapter: 2 }, { id: "aie", tier: "should", minutes: 20, note: null, chapter: 1, activity: "review" }, { id: "evals", tier: "should", minutes: 79, note: null }], byId);
  expect(rows.map((r) => [r.key, r.activity, r.chapter?.title ?? null])).toEqual([["aie#2", "read", "Understanding Foundation Models"], ["aie#1", "review", "Introduction to Building AI Applications with Foundation Models"], ["evals#0", "read", null]]);
  expect(chapterLabel(rows[0].chapter!)).toBe("Ch. 2 Understanding Foundation Models");
  expect(chapterLabel({ ...rows[0].chapter!, n: null })).toBe("Understanding Foundation Models");
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run components/pensieve/ReadTable.test.ts`
Expected: FAIL — `chapterLabel` not exported; rows have no `key`.

- [ ] **Step 3: Implement**

`ReadRows`: key by `r.key`; after the item link, ` · ${chapterLabel(chapter)}` then ` · ${note}`; a `ReviewPill` (same styling as the should pill, text `Review`) before the item link when `activity === "review"`. `ReadTable`: key by `r.key`; the Item cell's second line starts with `chapterLabel` when present; the Tier cell stacks the review pill under the tier pill. `CoversRow`: group covers by `material.id` and `activity`; a group's chip text is the title, plus ` · ch. ${runs}` when any ref has a chapter, where runs are the chapters' `n` values collapsed (`1–4`, `5–6`, `10`); review groups prefix `Review: `.

- [ ] **Step 4: Run tests, types and lint**

Run: `npx vitest run components && npx tsc --noEmit && npm run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/ReadTable.tsx components/pensieve/ReadTable.test.ts components/pensieve/PlanTree.tsx
git commit -m "feat(ui): read rows and reservation chips name chapters from the list; review rows marked"
```

---

### Task 11: The eval counts breaches; docs

**Files:**
- Modify: `evals/scripts/sample-plans.ts:40-66, 170-190`, `evals/research/README.md` (after the "Book chapters (Oct 17)" section), `docs/superpowers/specs/2026-10-18-chapter-resources-design.md` (status line)
- Test: none beyond the suite (the sampler is a script)

- [ ] **Step 1: Record breaches**

`Sample.breaches: number` = `checkFacts.filter((f) => f.includes(": breach: ")).length`; the stdout facts line gains ` · breaches N` when N > 0.

- [ ] **Step 2: README paragraph** "Chapters as resources (Oct 18)": every drafted level now reports breaches (`breach: …` in a call's facts) and drops (`dropped …`); the sampler counts them per sample; a plan whose months share a chapter, or whose days read outside their week's reservation, is a regression; spec path.

- [ ] **Step 3: Full verification**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all pass, clean.

- [ ] **Step 4: Commit**

```bash
git add evals/scripts/sample-plans.ts evals/research/README.md
git commit -m "docs(eval): breaches counted per sample; chapters-as-resources described"
```

The spec's status line is updated by the finishing step once the live check has run (the operator applies `0011_chapter_refs` first).
