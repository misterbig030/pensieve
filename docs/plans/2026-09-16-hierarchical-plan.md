# Hierarchical plan (months → weeks → days) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat day list with a tree of plan nodes so long tracks are planned as months/weeks first, expanded into days just in time, with week-level leaves for learners who log sessions instead of daily check-ins.

**Architecture:** One self-referential `plan_nodes` table replaces `outline_items`; a node with no children is a leaf and holds content and check-ins. Spans are computed server-side (`splitSpans`, no runt units); the model writes titles and summaries for units of a given span, and revises the tree through a depth-limited (3 level) schema that echoes node refs so completed nodes survive. The workspace, chat rail, track page and leaf page all render the same `PlanNode` tree from `lib/planTree.ts`.

**Tech Stack:** Next.js 16 App Router, React 19, Drizzle on Neon, AI SDK v7 (`streamObject`, `streamText` + tool), zod 4, vitest.

**Spec:** Claude Design project `3e941712-c90a-4ea5-b04a-440b235b745c`, file `Pensieve.dc.html` (2026-09-16), saved locally at `scratchpad/mock/Pensieve.dc.html`. Design discussion in this session (see summary): leaves at any span, dynamic depth, phases removed, derived progress, just-in-time expansion, Day/Week/Auto granularity, dangling-day rule (absorb short tails; units never shorter than half the nominal size).

## Status (2026-09-16)

Implemented and verified in the browser against the dev server: 30-day day-unit draft (weeks 7/7/8/8, Week 1 in days),
week-level swap via chat with tags/highlight/undo, expanding a heading in the draft, confirm → track page, lesson
generation + mark complete, "Plan week 3" on a saved track, adjust mode with Day 1 locked and a day-level change
confirmed with ids preserved, 180-day week-unit draft (6 months of 30, week leaves with budgets), split a week by hand,
logging a session on a week leaf, dashboard progress for migrated flat tracks. Migrations 0005/0006 applied to the dev
database. `tsc`, `eslint` and `vitest` (68 tests) pass. Not yet verified: mobile layout of the tree, revision requests
that change month spans ("last month should be 2 weeks").

## Global Constraints

- Depth is at most 3: `month → week → day`. Top level is `day` (≤14 days), `week` (15–70 days) or `month` (>70 days).
- Nominal unit sizes: week = 7 days, month = 28 days. `splitSpans(n, size)`: `count = ceil(n/size)`; if the tail `n - (count-1)*size` is shorter than `size/2` the tail is absorbed (`count -= 1`); the `n` days are then spread evenly with the surplus on the last spans. So 30 days → `7,7,8,8`; 31 → `7,8,8,8`; 180 days → six months of 30; 200 → `28,28,28,29,29,29,29`.
- Granularity `auto` resolves to `week` when days > 60, else `day`. Week granularity means weeks are leaves (with a time budget `≈ len*6/7` hours); day granularity means weeks are groups whose children are day leaves.
- Only the first branch is expanded at creation (first top-level unit, and if that unit's children are groups, its first child too). Later units are headings until expanded.
- A leaf with check-ins can't be split. Completed leaves and fully completed groups are locked in adjust mode; the server rejects a revision that drops or edits a locked node.
- Labels: `Day N` for day leaves; `Week k` / `Month k` by ordinal among siblings; span chip `Day a–b`.
- Summary text is deterministic (`summarizePlan`), with an optional `Latest change: …` clause.
- All model calls go through `generation_log` (callers: `outline` for creation/expansion, `outline_revision` for revisions, `chat` for chat turns, `daily` for leaf content).

---

### Task 1: Pure tree model — `lib/planTree.ts`

**Files:** Create `lib/planTree.ts`, `lib/planTree.test.ts`.

**Produces:**
```ts
export type PlanLevel = "month" | "week" | "day";
export type NodeStatus = "pending" | "generated" | "completed";
export interface PlanNode { id: string; level: PlanLevel; title: string; summary: string; len: number; status: NodeStatus; budgetHours: number | null; manualSplit: boolean; children: PlanNode[] | null; start: number; end: number; }
export function splitSpans(total: number, size: number): number[]
export function topLevelFor(days: number): PlanLevel            // day ≤14, week ≤70, month
export function resolveGranularity(g: "day"|"week"|"auto", days: number): "day"|"week"
export function childLevel(level: PlanLevel): PlanLevel | null  // month→week, week→day, day→null
export function childSpans(node: {level: PlanLevel; len: number}): number[]  // month→splitSpans(len,7), week→ones
export function layout(root: PlanNode, start = 1): PlanNode      // sets start/end in place, len of groups = sum(children)
export function walk(node, fn(node, parent, index))
export function findNode(root, id): PlanNode | null
export function parentOf(root, id): PlanNode | null
export function leavesOf(root): PlanNode[]
export function doneDays(node): number
export function labelOf(root, node): string        // "Day 9" | "Week 2" | "Month 1"
export function spanOf(node): string               // "Day 9" | "Day 8–14"
export function isLocked(node, lockBefore: number): boolean  // node.end <= lockBefore
export function cloneTree(root): PlanNode
export function makeRoot(children: PlanNode[]): PlanNode      // level "month" placeholder, id "root"
```
Tests: `splitSpans(30,7)→[7,7,8,8]`, `(28,7)→[7,7,7,7]`, `(31,7)→[7,8,8,8]`, `(10,7)→[10]`, `(180,28)→six 30s`, `(200,28)→[28,28,28,28,28,28,32]`; `layout` numbering; `doneDays` counts a completed week leaf as its span; `labelOf`.

### Task 2: Summary + diff — `lib/planSummary.ts`

Create `lib/planSummary.ts` (+ test). `summarizePlan(root, topic, note?)` mirrors the mock's `summarize`; `latestChangeNote(note)`; `diffChangedNodes(prev, next): { ids: string[]; level: PlanLevel; tags: string[] }` — nodes in `next` whose `(level,title,summary,len)` tuple is absent from `prev`; `level` is the highest level among them; tags are labels (a day tag is prefixed by its week label when nested). Delete `lib/outlineSummary.ts`, `lib/outlinePhases.ts` and their tests.

### Task 3: Schemas + chat types — `lib/schemas/plan.ts`, `lib/planChat.ts`

`lib/schemas/plan.ts`: `unitDraftSchema` `{ title, summary }`, `unitListSchema` `{ units: unitDraftSchema[] (1..40) }`, `revisedNodeSchema` (3 nested levels, each `{ ref?: string; title; summary; days: int ≥1; children?: [...] }`), `revisedTreeSchema` `{ units: revisedNodeSchema[] }`, `planNodeInputSchema` (client → server on confirm: `{ id?, level, title, summary, len, budgetHours?, manualSplit?, children? }`, 3 levels), `granularitySchema = z.enum(["day","week","auto"])`.

`lib/planChat.ts` (replaces `lib/outlineChat.ts`): `ChatMessage` change kind carries `{ level, nodeIds, tags, prevTree, prevNote }`; `PlanChatRequest { mode, topic, days, granularity: "day"|"week", instructions?, sources, tree: PlanNode, lockBefore?, trackId?, transcript }`; events `text | revising | revised { tree, changed: {ids, level, tags}, costUsd } | finish | error`; `PlanDraftRequest { topic, days, granularity, instructions?, sources }`; `PlanDraftEvent`: `node { parentId, node }` (a fully arrived node placed under `parentId`, `"root"` for top level) | `finish { root, costUsd }` | `error`; `PlanExpandRequest { topic, instructions?, sources, tree, nodeId, unit: PlanLevel }`; `PlanExpandEvent`: `child { node }` | `finish { children, costUsd }` | `error`. Keep `toTranscript`, `undoableChangeId`, `hasUserTurn`, `nextMessageId`.

### Task 4: Schema + migration + queries

`lib/db/schema.ts`: add `planNodes` (id, track_id, parent_id self-ref cascade, position, level, title, summary, len, status, budget_hours, manual_split, created_at; unique(track_id, parent_id, position) is not expressible with NULL parent → index only). `tracks.granularity text default 'day'`. `dailyContent.nodeId` (unique) and `checkIns.nodeId` + `checkIns.hours double precision` replace `outlineItemId`. Drop `outlineItems`.

Migration `drizzle/0005_plan_nodes.sql` (hand-written, then `drizzle-kit generate` snapshot): create `plan_nodes`; insert one root-level day leaf per `outline_items` row (`position = day_index - 1`, `len = 1`, keep id); add `node_id` columns, backfill from `outline_item_id`, set NOT NULL, drop old columns; drop `outline_items`; add `granularity` to tracks.

`lib/db/planQueries.ts`: `getPlanTree(trackId): PlanNode` (rows → tree, `layout`), `insertPlanTree(tx, trackId, root)`, `createTrackWithPlan`, `replacePlanTree(trackId, userId, root)` (adjust confirm: delete open nodes not in the new tree, upsert the rest by id, reposition), `insertChildren(trackId, userId, parentId, children)`, `markLeafComplete(nodeId, userId)`, `logSession(nodeId, userId, hours)`, `getLeafWithContent(nodeId, userId)`, `upsertLeafContent`. `getDashboardTracksForUser` computes `total/done` from the tree.

### Task 5: AI — `lib/ai/planDraft.ts`, `lib/ai/planRevision.ts`, `lib/ai/planChat.ts`

- `buildUnitsPrompt({ topic, instructions, sources, level, spans, parent?, before?, after? })` asks for exactly `spans.length` units in order, giving each unit's span. `streamUnits(prompt, spans, log)` → yields complete units (partial stream, last withheld), then finish with cost. `streamPlanDraft(req)` orchestrates: top-level, then first unit's children, then first grandchild if groups; emits `PlanDraftEvent`. `streamExpandNode(req)` for one node. Unit nodes get `level`, `len` from spans, `budgetHours` when the unit is a week leaf.
- `revisePlanTree({ topic, tree, lockBefore, changeRequest, ... })`: prompt renders the tree as indented text with refs `[n3]`, spans and locked marks; `generateObject(revisedTreeSchema)`; post-process: map refs to ids, new nodes get fresh ids, spans of children must sum to the parent (else scale the last child), locked nodes restored from the original; throws if a locked node is missing.
- `runPlanChat` = `runOutlineChat` with tool `revisePlan` calling `revisePlanTree`, emitting `revised { tree, changed }`.
- Delete `lib/ai/outline.ts`, `lib/ai/outlineDraftStream.ts`, `lib/ai/outlineChat.ts`, `lib/outlineRevision.ts` and tests; add `"expand"` to `GENERATION_CALLERS`? No — use `outline`.

### Task 6: Routes

`app/api/plan/draft`, `app/api/plan/expand`, `app/api/plan/chat` (NDJSON, Clerk guard, track ownership check). Delete `app/api/outline`.

### Task 7: UI — tree, workspace, rail

- `components/pensieve/PlanTree.tsx` (client): renders `PlanNode[]` recursively: `LeafChip` (kicker, lock, chevron toggle for summary, title, meta: budget tag, status tag, sessions, "Split into days"), `GroupCard` (kicker, title, span chip, Changed/Done/Split tags, lock, progress, chevron; body: children grid, skeleton slots while expanding, or empty row with Expand/"Plan week k"). Props: `nodes, root, mode: "create"|"adjust"|"track", highlight: Set<string>, lockBefore, currentLeafId, pending: Map<parentId, {count, groups}>, collapsed: Set<string>, onToggle, onExpand, onSplit, leafHref?`.
- `components/pensieve/PlanWorkspace.tsx` replaces `OutlineWorkspace`: state is `tree` + `pending` slots; draft stream places nodes by `parentId`; expand/split call `/api/plan/expand`; chat as before but with trees and `diffChangedNodes`; undo restores `prevTree`; confirm sends the tree.
- `ConversationRail.tsx`: change message shows `Plan changed · week level` + tags; brief shows `30 days · day units`.
- `TrackFormFields.tsx`: presets 7/30/90/180 and a Working unit row (Day/Week/Auto + hint). `NewTrackForm` passes `granularity`; `confirmTrackAction` accepts the tree.
- Delete `OutlineWorkspace.tsx`, `OutlinePlanEditor.tsx`, `PhaseBlock.tsx`, `DayChip.tsx`.

### Task 8: Track page, adjust page, leaf page

- `app/tracks/[id]/page.tsx`: header progress from `doneDays(root)`, Summary card, `TrackPlan` client component (PlanTree in track mode; Expand runs `expandNodeAction`, Split runs `splitLeafAction`; leaf chips link to `/tracks/[id]/nodes/[nodeId]`).
- `app/tracks/[id]/adjust`: passes the full tree + `lockBefore`; `confirmRevisionAction` calls `replacePlanTree`.
- `app/tracks/[id]/nodes/[nodeId]/page.tsx` + `LeafView.tsx` + `actions.ts`: kicker (`Day 9` or `Week 2 · Day 8–14`), session card for week leaves (budget, sessions logged, Log a session with hours), content generate/regenerate (prompt says "this week's material" for week leaves), Mark complete. Delete `app/tracks/[id]/day`.

### Task 9: Verify

`npx tsc --noEmit`, `npm run lint`, `npm test`, `npx drizzle-kit migrate`, then browser pass: new track 7 / 30 / 180 (day and week units), expand a week, split a week leaf, chat question + change + undo, confirm, track page expand, leaf page log session + complete, adjust mode.
