# Admin Model-Calls Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One admin model-calls panel for the whole app, fed by every page that calls a model, surviving navigation within the tab.

**Architecture:** A per-tab client store (`lib/modelCalls.ts`, memory mirrored to session storage) replaces the workspace's local list. The panel mounts once in `PageShell` behind a server-side admin check. The streaming routes are untouched; the two server actions that call a model collect their calls through a helper (`lib/ai/collectCalls.ts`) and return them to an admin.

**Tech Stack:** Next.js 16 App Router (server components, server actions), React 19 `useSyncExternalStore`, Vitest (Node environment), Clerk `auth()`.

**Spec:** `docs/superpowers/specs/2026-10-16-admin-calls-dock-design.md`

## Global Constraints

- `STORAGE_KEY = "pensieve.modelCalls"`, `MAX_CALLS = 200`, `MAX_STORED_BYTES = 2_500_000`; storage item is `{ "v": 1, "calls": ModelCall[] }`.
- The server alone decides who receives call bodies: `isAdminUserId(userId)` from `lib/admin.ts`, never a client flag.
- Nothing new is written to the database; `generation_log`, the three streaming routes and `withCallEvents` are unchanged.
- Panel copy, verbatim: header chip "this tab"; empty state "No model calls yet in this tab. Draft a plan, expand or split a unit, ask the plan a question or generate a lesson, and each call shows up here."; footer "Kept in this tab until you close it or clear the list. Nothing here is written to the database."
- Daily call label: `Lesson · <title>`.
- A file with `"use client"` exports no server component; `AdminDock` (server) and `ModelCallsDock` (client) are separate files.
- Commits are conventional (`feat:`, `fix:`, `docs:`), end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run `npx vitest run`, `npx tsc --noEmit`, `npm run lint` before the final commit.

## Review Focus

1. Session storage over quota during a long research draft: the in-memory list must keep every call and the panel must keep showing them (Task 2, "a throwing storage leaves the memory list working").
2. A foreign or corrupt item under the storage key: the page must load with an empty list, never throw during render (Task 2, "starts empty on a missing, unparsable or wrong-version item").
3. A refused user key in the middle of an expand: the outline calls made before the refusal must still reach the admin (Task 1, "keeps calls pushed before the work throws"; Task 5 returns `calls` on the refusal branch).
4. A non-admin's server action result must carry no `calls` field at all (Task 5 spreads the field only when `admin`; live check signed in as a non-admin).
5. Hydration: the server renders no panel and the client's first render must agree, or React logs a mismatch (Task 2's hook returns a constant empty array on the server; Task 7 checks the console).

---

### Task 1: `collectCalls`, the server-action twin of `withCallEvents`

**Files:**
- Create: `lib/ai/collectCalls.ts`
- Test: `lib/ai/collectCalls.test.ts`

**Interfaces:**
- Consumes: `GenerationLogContext`, `ModelCall` from `lib/ai/logged.ts`.
- Produces: `collectCalls(enabled: boolean, log: GenerationLogContext, sink: ModelCall[]): GenerationLogContext`.

- [ ] **Step 1: Write the failing tests**

Reuse the `call(label)` fixture shape from `lib/ai/callEvents.test.ts` (copy it; the two tests stay independent).

```ts
describe("collectCalls", () => {
  it("returns the context unchanged when disabled", () => {
    const log = { userId: "u1", onCall: vi.fn() };
    const sink: ModelCall[] = [];
    expect(collectCalls(false, log, sink)).toBe(log);
  });
  it("fills the sink and still forwards to the original onCall", () => {
    const onCall = vi.fn(); const onLog = vi.fn();
    const sink: ModelCall[] = [];
    const log = collectCalls(true, { userId: "u1", trackId: "t1", keyOwner: "user", onLog, onCall }, sink);
    log.onCall?.(call("a")); log.onCall?.(call("b"));
    expect(sink.map((c) => c.label)).toEqual(["a", "b"]);
    expect(onCall).toHaveBeenCalledTimes(2);
    expect(log).toMatchObject({ userId: "u1", trackId: "t1", keyOwner: "user", onLog });
  });
  it("keeps calls pushed before the work throws", async () => {
    const sink: ModelCall[] = [];
    const log = collectCalls(true, {}, sink);
    await expect((async () => { log.onCall?.(call("first")); throw new Error("refused"); })()).rejects.toThrow("refused");
    expect(sink.map((c) => c.label)).toEqual(["first"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/ai/collectCalls.test.ts`
Expected: FAIL, cannot resolve `./collectCalls`.

- [ ] **Step 3: Implement `collectCalls` in `lib/ai/collectCalls.ts`**

Disabled returns `log`. Enabled returns `{ ...log, onCall: (c) => { log.onCall?.(c); sink.push(c); } }`. Doc comment names it the server-action twin of `withCallEvents`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/ai/collectCalls.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/collectCalls.ts lib/ai/collectCalls.test.ts
git commit -m "feat(admin): collectCalls gathers a server action's model calls for an admin"
```

### Task 2: The per-tab store, `lib/modelCalls.ts`

**Files:**
- Create: `lib/modelCalls.ts`
- Test: `lib/modelCalls.test.ts`

**Interfaces:**
- Consumes: `ModelCall` from `lib/ai/logged.ts`.
- Produces, all exported: `StorageLike`, `ModelCallStore` (`getSnapshot(): ModelCall[]`, `subscribe(onChange: () => void): () => void`, `push(calls: ModelCall[]): void`, `clear(): void`), `createModelCallStore(options?: { storage?: StorageLike | null; maxCalls?: number; maxStoredBytes?: number }): ModelCallStore`, `STORAGE_KEY`, `MAX_CALLS`, `MAX_STORED_BYTES`, `modelCallStore: ModelCallStore`, `pushModelCalls(calls: ModelCall[]): void`, `clearModelCalls(): void`, `useModelCalls(): ModelCall[]`.

- [ ] **Step 1: Write the failing tests**

A `fakeStorage()` helper returns `{ items: Map<string,string>, getItem, setItem, removeItem }` as a `StorageLike`. `call(label, pad = "")` builds a fixture with `prompt: pad` to control size.

```ts
describe("createModelCallStore", () => {
  it("push appends, replaces the snapshot and notifies once per push", () => {
    const store = createModelCallStore({ storage: fakeStorage() });
    const onChange = vi.fn(); store.subscribe(onChange);
    const before = store.getSnapshot();
    store.push([call("a")]); store.push([call("b"), call("c")]);
    expect(store.getSnapshot().map((c) => c.label)).toEqual(["a", "b", "c"]);
    expect(store.getSnapshot()).not.toBe(before);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(before).toEqual([]);
  });
  it("returns the same snapshot reference until something changes", () => {
    const store = createModelCallStore({ storage: fakeStorage() });
    store.push([call("a")]);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
  it("persists under the key as a versioned item and hydrates from it", () => {
    const storage = fakeStorage();
    createModelCallStore({ storage }).push([call("a")]);
    expect(JSON.parse(storage.items.get(STORAGE_KEY)!)).toMatchObject({ v: 1, calls: [{ label: "a" }] });
    expect(createModelCallStore({ storage }).getSnapshot().map((c) => c.label)).toEqual(["a"]);
  });
  it("starts empty on a missing, unparsable or wrong-version item", () => {
    for (const item of [undefined, "{not json", JSON.stringify({ v: 2, calls: [call("x")] }), JSON.stringify({ calls: [] })]) {
      const storage = fakeStorage(); if (item !== undefined) storage.items.set(STORAGE_KEY, item);
      expect(createModelCallStore({ storage }).getSnapshot()).toEqual([]);
    }
  });
  it("clear empties memory, removes the item and notifies", () => {
    const storage = fakeStorage(); const store = createModelCallStore({ storage });
    const onChange = vi.fn(); store.subscribe(onChange);
    store.push([call("a")]); store.clear();
    expect(store.getSnapshot()).toEqual([]);
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
  it("drops the oldest beyond maxCalls", () => {
    const store = createModelCallStore({ storage: fakeStorage(), maxCalls: 2 });
    store.push([call("a"), call("b")]); store.push([call("c")]);
    expect(store.getSnapshot().map((c) => c.label)).toEqual(["b", "c"]);
  });
  it("writes only the newest calls that fit in maxStoredBytes and keeps the full list in memory", () => {
    const storage = fakeStorage();
    const store = createModelCallStore({ storage, maxStoredBytes: 1200 });
    store.push([call("a", "x".repeat(500)), call("b", "y".repeat(500)), call("c", "z".repeat(500))]);
    expect(store.getSnapshot()).toHaveLength(3);
    const stored = JSON.parse(storage.items.get(STORAGE_KEY)!).calls.map((c: ModelCall) => c.label);
    expect(stored).toEqual(["c"]);
  });
  it("keeps a call too large to store in memory only", () => {
    const storage = fakeStorage();
    const store = createModelCallStore({ storage, maxStoredBytes: 100 });
    store.push([call("huge", "x".repeat(1000))]);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(JSON.parse(storage.items.get(STORAGE_KEY)!).calls).toEqual([]);
  });
  it("a throwing storage leaves the memory list working", () => {
    const storage: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
    const store = createModelCallStore({ storage });
    store.push([call("a")]); store.clear(); store.push([call("b")]);
    expect(store.getSnapshot().map((c) => c.label)).toEqual(["b"]);
  });
  it("works with no storage at all", () => {
    const store = createModelCallStore({ storage: null });
    store.push([call("a")]);
    expect(store.getSnapshot()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/modelCalls.test.ts`
Expected: FAIL, cannot resolve `./modelCalls`.

- [ ] **Step 3: Implement the store in `lib/modelCalls.ts`**

`createModelCallStore` holds `calls: ModelCall[]`, a `Set` of listeners and a `hydrated` flag; `hydrate()` runs once on the first `getSnapshot` or `subscribe`, inside try/catch, accepting only `{ v: 1, calls: Array }`. `push` slices to the newest `maxCalls`, calls `persist()`, notifies. `persist()` walks newest to oldest, adding each call's `JSON.stringify` length plus a separator to a running total, and writes `{ v: 1, calls }` of those that fit, in original order; `setItem` errors are caught. `clear` sets `[]`, `removeItem` in try/catch, notifies. Module-level: `const EMPTY: ModelCall[] = []` as the server snapshot; `modelCallStore = createModelCallStore({ storage: typeof window === "undefined" ? null : window.sessionStorage })` (accessing `window.sessionStorage` itself in try/catch); `useModelCalls` is `useSyncExternalStore(modelCallStore.subscribe, modelCallStore.getSnapshot, () => EMPTY)`. The file imports `useSyncExternalStore` from `react` and nothing else from React; it carries no `"use client"` (the hook is only called from client components).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/modelCalls.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/modelCalls.ts lib/modelCalls.test.ts
git commit -m "feat(admin): a per-tab store for model calls, mirrored to session storage"
```

### Task 3: The dock in `PageShell`, and the panel's copy

**Files:**
- Create: `components/pensieve/AdminDock.tsx` (server), `components/pensieve/ModelCallsDock.tsx` (client)
- Modify: `components/pensieve/PageShell.tsx`, `components/pensieve/ModelCallsPanel.tsx:60-63,87,118-120`

**Interfaces:**
- Consumes: `useModelCalls`, `clearModelCalls` (Task 2); `useAdminMode`, `writeAdminMode` from `lib/adminMode.ts`; `isAdminUserId` from `lib/admin.ts`; `auth` from `@clerk/nextjs/server`.
- Produces: `AdminDock(): Promise<JSX.Element | null>` mounted in `PageShell`; `ModelCallsDock(): JSX.Element | null`.

- [ ] **Step 1: Write `ModelCallsDock.tsx`**

`"use client"`. Reads `useAdminMode()` and `useModelCalls()`; returns `null` while the switch is off, else `<ModelCallsPanel calls={calls} onClear={clearModelCalls} onClose={() => writeAdminMode(false)} />`.

- [ ] **Step 2: Write `AdminDock.tsx`**

Async server component: `const { userId } = await auth(); if (!isAdminUserId(userId)) return null; return <ModelCallsDock />;`. Doc comment: nothing reaches a non-admin's HTML.

- [ ] **Step 3: Mount it in `PageShell`**

Render `<AdminDock />` after `{children}` inside the shell's `div`.

- [ ] **Step 4: Update the panel copy**

In `ModelCallsPanel.tsx`: the header chip text "this session" becomes "this tab"; the empty-state paragraph and the expanded-view footer become the exact strings in Global Constraints.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean. (No component tests exist; Task 7 checks it live.)

- [ ] **Step 6: Commit**

```bash
git add components/pensieve/AdminDock.tsx components/pensieve/ModelCallsDock.tsx components/pensieve/PageShell.tsx components/pensieve/ModelCallsPanel.tsx
git commit -m "feat(admin): mount one model-calls dock in PageShell for admins"
```

### Task 4: The workspace pushes into the store

**Files:**
- Modify: `components/pensieve/PlanWorkspace.tsx:9,18,24,125-127,187-189,286-288,403-405,687`

**Interfaces:**
- Consumes: `pushModelCalls` (Task 2). The dock from Task 3 now renders the panel.

- [ ] **Step 1: Remove the workspace's own panel**

Delete the `ModelCallsPanel` import (line 9), the `useAdminMode, writeAdminMode` import (18), the `ModelCall` type from the `@/lib/planChat` import (24), the `adminOn` and `calls` state with their comment (125-127), and the panel mount (687). Add `import { pushModelCalls } from "@/lib/modelCalls";`.

- [ ] **Step 2: Push call events**

Each of the three `event.type === "call"` branches (draft, expand, chat) becomes `pushModelCalls([event.call]);`. Leave `debug: true` on the requests and the comment explaining the server honours it only for admins.

- [ ] **Step 3: Type-check, lint and run the suite**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: clean; all tests pass (no test imports the workspace).

- [ ] **Step 4: Commit**

```bash
git add components/pensieve/PlanWorkspace.tsx
git commit -m "feat(admin): the plan workspace pushes its call events into the shared store"
```

### Task 5: Server actions return their calls; the pages push them

**Files:**
- Modify: `app/tracks/[id]/actions.ts:68-116` (`ExpandNodeResult`, `expandNodeAction`), `app/tracks/[id]/nodes/[nodeId]/actions.ts:15-80` (`GenerateLeafContentResult`, `generateLeafContentAction`), `app/tracks/[id]/TrackPlan.tsx:53-66`, `app/tracks/[id]/nodes/[nodeId]/LeafView.tsx:52-66`

**Interfaces:**
- Consumes: `collectCalls` (Task 1), `pushModelCalls` (Task 2), `isAdminUserId`, `ModelCall` type from `@/lib/ai/logged`.
- Produces:
  ```ts
  export type ExpandNodeResult =
    | { ok: true; costUsd: number; calls?: ModelCall[] }
    | { ok: false; message: string; code: KeyErrorKind; calls?: ModelCall[] };
  export type GenerateLeafContentResult =
    | { ok: true; contentMarkdown: string; citations: { title: string; url: string }[]; costUsd: number; calls?: ModelCall[] }
    | { ok: false; message: string; code: KeyErrorKind; calls?: ModelCall[] };
  ```

- [ ] **Step 1: `expandNodeAction`**

After `auth()`: `const admin = isAdminUserId(userId); const calls: ModelCall[] = [];`. Build the log as `collectCalls(admin, { userId, trackId: input.trackId, onLog: insertGenerationLog, keyOwner: models.outline.keyOwner }, calls)`. Define `const extra = admin ? { calls } : {};` and spread it into the refusal return and the success return. Update the result type as in Produces.

- [ ] **Step 2: `generateLeafContentAction`**

Same shape: `admin`, `calls`, `collectCalls(admin, { trackId: input.trackId, userId, onLog: insertGenerationLog, keyOwner: models.content.keyOwner }, calls)`, `extra` spread into both returns; result type as in Produces.

- [ ] **Step 3: Pages push**

`TrackPlan.tsx`, right after `const result = await expandNodeAction(...)`: `if (result.calls) pushModelCalls(result.calls);`. `LeafView.tsx`, right after `const result = await generateLeafContentAction(...)`: the same line. Both import `pushModelCalls` from `@/lib/modelCalls`.

- [ ] **Step 4: Type-check, lint, suite**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: clean; all pass.

- [ ] **Step 5: Commit**

```bash
git add "app/tracks/[id]/actions.ts" "app/tracks/[id]/nodes/[nodeId]/actions.ts" "app/tracks/[id]/TrackPlan.tsx" "app/tracks/[id]/nodes/[nodeId]/LeafView.tsx"
git commit -m "feat(admin): split, expand and lesson actions return their model calls to an admin"
```

### Task 6: The lesson call carries a label

**Files:**
- Modify: `lib/ai/dailyContent.ts:129-142`
- Test: `lib/ai/dailyContent.test.ts:93-112`

- [ ] **Step 1: Extend the existing test**

In "generates on the content model it is given and records who paid", add `expect(calls[0].label).toBe("Lesson · Day 1");`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/ai/dailyContent.test.ts`
Expected: FAIL, received "daily".

- [ ] **Step 3: Pass the label**

Add `label: \`Lesson · ${input.title}\`` to the `loggedGenerateObject` options in `generateDailyContent`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/ai/dailyContent.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/dailyContent.ts lib/ai/dailyContent.test.ts
git commit -m "feat(admin): the lesson call names its day in the model-calls panel"
```

### Task 7: Live check and spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-admin-calls-dock-design.md:3-4` (status line)

- [ ] **Step 1: Full verification**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: every test passes, both clean.

- [ ] **Step 2: Live check in Chrome as the admin (dev server on localhost:3000)**

In order, each a checkable result: new-track draft with Admin on shows research and outline calls in the dock; confirming lands on the track page with the same calls still listed; "Split into days" adds an outline call; opening a day and "Generate today's lesson" adds a call labelled "Lesson · <day title>"; reloading keeps the list; Clear empties it and a reload stays empty; a new tab starts empty; the browser console shows no hydration warning. Note what could not be run (a non-admin account, if none is at hand).

- [ ] **Step 3: Record the outcome in the spec**

Replace the status line with "implemented 2026-10-16" plus the live-check result in one paragraph, including anything not run.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-admin-calls-dock-design.md
git commit -m "docs(spec): admin dock implemented; live check results"
```
