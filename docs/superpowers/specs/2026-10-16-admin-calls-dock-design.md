# Admin model-calls dock: one panel for the whole app

**Status:** design, 2026-10-16. Follows the research in the session of 2026-10-16: two model calls on saved tracks
never reached the panel, and the panel itself lived on two pages only.

## Summary

Today the admin's model-calls panel is a piece of the plan workspace. It exists on the new-track and adjust pages,
fills from `call` events that three streaming routes interleave into their NDJSON responses, and keeps its list in
that component's React state. Two model calls never reach it: planning a heading in detail or splitting a week on a
saved track (`expandNodeAction`), and writing a day's or week's lesson (`generateLeafContentAction`). Both are
server actions that return one value, and the pages they run on have no panel. Confirming a draft redirects to the
track page and unmounts the workspace, so the draft's research and outline calls vanish with it.

After this change there is one dock for the whole app. It is mounted once, in `PageShell`, for admins. Every page
that calls a model pushes its calls into one client store that lives for the tab: in memory, mirrored to session
storage, capped. The streaming routes are unchanged; the workspace pushes their `call` events into the store instead
of its own state. The two server actions collect their calls through a helper and return them to an admin in their
result; the pages push those into the store too. Nothing new is written to the database.

## Background: how calls are captured today

Every generator already emits a whole `ModelCall` (the log row plus label, prompt, response, finish reason and facts)
through `GenerationLogContext.onCall`: outline drafting, expand and split through `streamUnits`; research loop
steps and the candidate step; the chat answer; the revision inside chat; the daily lesson through
`loggedGenerateObject`. Capture is solved everywhere. What is missing is transport from two server actions and a
panel on the pages they run from.

`withCallEvents` (lib/ai/callEvents.ts) is the transport for streams: it wraps the log context so each call is queued
and yielded as a `{ type: "call" }` event before the generator's next event. `ModelCallsPanel` renders the list and
sets the `--admin-dock` CSS variable so the body pads for it. `AdminToggle` in the top nav flips a per-browser
switch (`lib/adminMode.ts`); the server decides on every request whether the caller is an admin
(`isAdminUserId`, `ADMIN_USER_IDS`).

## Goals and non-goals

Goals:

- Every model call the app makes on a page reaches the panel when an admin has it switched on, including the two
  from server actions.
- The list survives navigation within the tab, including the redirect after confirming a draft or an adjustment,
  and a reload of the tab.
- The server alone decides who receives call bodies, as today.

Non-goals:

- History across tabs, devices or sessions. Prompts and responses are still never written to the database;
  `generation_log` keeps tokens and cost only.
- Showing calls to non-admins, changing what a `ModelCall` contains, or touching the eval harness.
- Converting the two server actions into streaming routes.

## Decisions

1. **One dock, mounted once.** `PageShell` renders an `AdminDock` after its children. It is an async server component
   that checks `isAdminUserId` and renders nothing for anyone else. Every signed-in page uses `PageShell`, so the
   panel appears wherever the switch is on, with an empty state on pages that have made no calls.
2. **One client store for the tab.** `lib/modelCalls.ts` holds the calls in memory, mirrors them to
   `sessionStorage`, and notifies subscribers. Session storage is per tab and per origin: the list survives
   navigation and reload, and dies with the tab. Clear empties both.
3. **Streams unchanged.** The draft, expand and chat routes keep `withCallEvents`. The workspace pushes each `call`
   event into the store and no longer owns a list or mounts the panel.
4. **Server actions return calls.** `expandNodeAction` and `generateLeafContentAction` collect calls through a helper
   when the server confirms the caller is an admin, and return them as an optional `calls` field on both the success
   and the refusal branch of their result. A non-admin's result has no such field. The pages push the field into the
   store.
5. **Caps.** The store keeps at most 200 calls; pushing beyond that drops the oldest. Persistence is best effort:
   the newest calls that fit in about 2.5 MB of JSON are written, oldest dropped first, and a storage error leaves
   the in-memory list intact.
6. **The daily call gets a label.** `generateDailyContent` passes `Lesson · <title>` so the panel names the day,
   as every other call is named.
7. **Copy follows the new lifetime.** "this session" becomes "this tab"; the empty state names the four ways to make
   a call; the footer says the list is kept in this tab until it is closed or cleared.

## The store: `lib/modelCalls.ts`

A plain module with no React dependency except the hook at the end, so it is testable in Node.

```ts
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export interface ModelCallStore {
  getSnapshot(): ModelCall[];           // same reference until the list changes
  subscribe(onChange: () => void): () => void;
  push(calls: ModelCall[]): void;       // appends, caps, persists, notifies
  clear(): void;                        // empties memory and storage, notifies
}

export function createModelCallStore(options?: { storage?: StorageLike | null; maxCalls?: number; maxStoredBytes?: number }): ModelCallStore;

export const STORAGE_KEY = "pensieve.modelCalls";
export const MAX_CALLS = 200;
export const MAX_STORED_BYTES = 2_500_000;

export const modelCallStore: ModelCallStore;          // built on window.sessionStorage when it exists, else memory only
export function pushModelCalls(calls: ModelCall[]): void;
export function clearModelCalls(): void;
export function useModelCalls(): ModelCall[];         // useSyncExternalStore; the server snapshot is an empty array
```

Behaviour:

- Storage holds `{ "v": 1, "calls": ModelCall[] }` under `STORAGE_KEY`. The store reads it once, lazily, on the first
  `getSnapshot` or `subscribe`, and starts empty when the item is missing, unparsable, of another version, or when
  reading throws.
- `push` builds a new array (never mutates the old one), drops the oldest beyond `maxCalls`, writes storage, then
  notifies. Writing serialises the newest calls that fit in `maxStoredBytes`; a call too large to fit on its own is
  kept in memory only. A throwing `setItem` (quota, private mode) is caught and the memory list stands.
- `clear` sets an empty array, removes the storage item (errors caught), notifies.
- The hook's server snapshot is a constant empty array, so server rendering and hydration agree; the client re-renders
  with the hydrated list afterwards.

## The dock: `components/pensieve/AdminDock.tsx`

```tsx
// Server component. Nothing reaches a non-admin's HTML.
export async function AdminDock() {
  const { userId } = await auth();
  if (!isAdminUserId(userId)) return null;
  return <ModelCallsDock />;
}
```

`ModelCallsDock` (`components/pensieve/ModelCallsDock.tsx`, a client component in its own file, since a file with `"use client"` cannot also export a server component) reads `useAdminMode()` and `useModelCalls()`, renders
nothing while the switch is off, and otherwise `<ModelCallsPanel calls={calls} onClear={clearModelCalls} onClose={() => writeAdminMode(false)} />`.
`PageShell` renders `<AdminDock />` after `{children}`. `ModelCallsPanel`'s props do not change; only its copy does.

## Server actions: `lib/ai/collectCalls.ts`

```ts
/** The server-action twin of withCallEvents: a log context whose calls land in `sink` when `enabled`. */
export function collectCalls(enabled: boolean, log: GenerationLogContext, sink: ModelCall[]): GenerationLogContext;
```

Disabled, it returns `log` unchanged. Enabled, it returns a copy whose `onCall` pushes into `sink` and still forwards
to `log.onCall` when there is one. The action keeps `sink` in scope, so calls made before a refusal are returned
with the refusal.

```ts
export type ExpandNodeResult =
  | { ok: true; costUsd: number; calls?: ModelCall[] }
  | { ok: false; message: string; code: KeyErrorKind; calls?: ModelCall[] };

export type GenerateLeafContentResult =
  | { ok: true; contentMarkdown: string; citations: { title: string; url: string }[]; costUsd: number; calls?: ModelCall[] }
  | { ok: false; message: string; code: KeyErrorKind; calls?: ModelCall[] };
```

Both actions compute `const admin = isAdminUserId(userId)`, build the log with
`collectCalls(admin, { userId, trackId, onLog: insertGenerationLog, keyOwner }, calls)`, and return
`...(admin ? { calls } : {})` on each branch. `ModelCall` is plain data (strings, numbers, nulls, a string array),
so it crosses the server-action boundary as is.

## Client wiring

- `PlanWorkspace`: delete the `calls` state, the panel mount and the admin-mode imports; each of the three
  `event.type === "call"` branches becomes `pushModelCalls([event.call])`. The comment at the top of the admin block
  now says the dock lives in `PageShell`.
- `TrackPlan`: after `expandNodeAction` resolves, `if (result.calls) pushModelCalls(result.calls)` before reading
  `ok`.
- `LeafView`: the same after `generateLeafContentAction`.

## Copy

- Header chip: "this tab".
- Empty state: "No model calls yet in this tab. Draft a plan, expand or split a unit, ask the plan a question or
  generate a lesson, and each call shows up here."
- Footer (expanded view): "Kept in this tab until you close it or clear the list. Nothing here is written to the
  database."

## Testing

Unit, in Vitest (Node environment, as the suite runs today):

- `lib/modelCalls.test.ts`, against `createModelCallStore` with a fake `StorageLike`: push appends and notifies
  once per push; the snapshot reference changes only on change; clear empties memory and removes the item;
  the store hydrates from a valid item and starts empty on a missing, unparsable or wrong-version item; the count
  cap drops the oldest; the byte cap writes only the newest that fit and keeps the full list in memory; a throwing
  storage leaves the memory list working.
- `lib/ai/collectCalls.test.ts`: disabled returns the same context; enabled fills the sink and forwards to the
  original `onCall`; other fields pass through.
- `lib/ai/dailyContent.test.ts`: the call's label names the lesson.

Type-check and lint as usual. The two actions have no unit tests (none of the server actions do; they need Clerk and
the database), so the live check covers them.

Live check, in Chrome against the local app as an admin: a draft on the new-track page shows its research and outline
calls; confirming redirects to the track page and the same calls are still listed; "Split into days" adds an outline
call; opening a day and generating the lesson adds a daily call labelled with the day; a reload keeps the list; Clear
empties it; a new tab starts empty. Signed in as a non-admin, no dock and no `calls` field in action results.

## Mechanics

- Branch `feat/admin-calls-dock` from `main`, which includes the user-API-keys work (PR 8, merged 2026-10-16) that
  introduced the two result types this design extends.
- No migration, no new environment variable, no change to the streaming routes or to `generation_log`.

## Follow-ups, not in this version

- A label on the chat call that names the question, as the revision already names the change request.
- Tests for the server actions once a pattern for mocking Clerk and the database exists.
