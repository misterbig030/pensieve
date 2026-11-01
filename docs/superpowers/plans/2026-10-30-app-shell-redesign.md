# App shell, Tracks home and plan page redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pensieve a full-width desktop shell with Tracks / Explore / Journey tabs, a Tracks home with rich cards and a stats rail, a plan page with an outline and a day pane, and a two-column lesson page.

**Architecture:** Pure date and plan math goes in tested `lib/` modules (`lib/activity.ts`, `lib/trackProgress.ts`, additions to `lib/planTree.ts`), check-in reads in a tested `lib/db/activity.ts`. Pages stay server components that compute view data from those modules. Client components are limited to what needs state: the nav tabs, the account menu, the plan outline, and the existing lesson view. The selected day and the plan page's sub-tab live in search params (`?day=`, `?tab=`), so the day pane renders on the server.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind 4, `@base-ui/react` (Menu), Clerk, Drizzle, Vitest (node environment, pglite for DB tests), lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-30-app-shell-redesign-design.md`. Visual reference: `docs/mockups/home-redesign.html` (open it in a browser). The chosen screens are "B · Top tabs, tracks board with a stats rail", "B · Plan page, option 1: outline and day preview", and "Lesson, case 1: its own page". Ignore the other screens and any Completed/Archived controls in them.

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing routing, layout or `searchParams` code (AGENTS.md). Page `params` and `searchParams` are Promises.
- No new dependencies. Menus use `@base-ui/react/menu` as `components/pensieve/PlanTree.tsx` does; icons from `lucide-react`.
- Colors only from the tokens in `app/globals.css` (`accent-*`, `accent-2-*`, `neutral-*`, `primary`, `secondary`, `--shadow-*`). Headings `font-heading` (Caprasimo), text Figtree. Large soft radii as today (cards 22–28px, pills `rounded-full`).
- Active tracks only: no status tags, no Completed/Archived switch, no archive action anywhere.
- Every "today", "this week", "this month" figure uses UTC days, as `lib/streak.ts` does. Weeks run Monday to Sunday.
- Day labels follow the existing helpers: `labelOf` / `fullLabelOf` ("Week 2 · Day 4"), not the mock's plan-wide "Day 9". Counts like "8 of 30 days" use `doneDays(root)` and `root.len`.
- Completion rules don't change: Mark complete shows only once a leaf's lesson exists; week leaves get Log session and Mark complete side by side; logging never completes.
- Fixed copy: tabs "Tracks", "Explore", "Journey", badge "soon"; "Your tracks"; "New track"; "Start a new track"; "Tell Pensieve what you want to learn"; sort "Up next first"; "Done today"; "Lesson ready"; "Ready"; "Today"; "not planned"; "Plan everything"; "Split into days"; "Open lesson"; "Mark complete"; "Log session"; "Read the lesson"; "Rewrite this lesson"; sub-tabs "Plan", "Materials", "Activity", "About".
- Narrow screens (below 900px) stack to one column: rails go under the main content, the outline above the day pane.
- Verify UI on your own dev server at `localhost:3001` started from the worktree, in the user's signed-in Chrome (the built-in browser has no Clerk session). Never use the user's server on 3000.
- The local `DATABASE_URL` is the production database. During UI checks, do not click Mark complete, Log session, generate, rewrite, or any planning action on real tracks. Check those paths with tests and by reading the code.
- Commands: `npm test`, `npx tsc --noEmit`, `npm run lint`. All three pass at the end of every task.

## Review Focus

1. A track whose current leaf is an unplanned heading (all planned days done, later weeks not planned): `currentLeaf` returns the heading. Cards and the pane must offer planning it, never Start or Open lesson. Pinned in Task 2 (`cardAction`) and Task 7 (pane).
2. A finished track (`currentLeaf` is null): the card says "All days done" with no button, the header shows no finish date, and the outline selects the last leaf. Pinned in Task 2 (`finishDate`, `resolveSelected`).
3. `?day=` set to garbage, the root, or a node from another track: the plan page falls back to the current leaf, never 404s. Pinned in Task 2 (`resolveSelected`).
4. Week-granularity tracks everywhere: one strip block per week, the card shows hours and Log, the pane shows the budget, Log session and Mark complete. Pinned in Task 2 (`dayStrip`, `weekActivity`).
5. Three-level plans (month → week → day): the outline nests months, weeks open on the path to the current leaf, and strip week gaps fall at week boundaries. Pinned in Task 2 (`initialOpen`, `dayStrip`).

---

### Task 1: Activity math

**Files:**
- Create: `lib/activity.ts`
- Create: `lib/activity.test.ts`
- Modify: `lib/streak.ts` (export the day key, add `longestStreak`)
- Modify: `lib/streak.test.ts`

**Interfaces:**
- Produces:
  - `lib/streak.ts`: `export function dayKey(d: Date): string` (rename of the private `toDayKey`, UTC `YYYY-MM-DD`), `export function longestStreak(dates: Date[]): number`.
  - `lib/activity.ts`:
    - `export interface StudyEvent { at: Date; hours: number }`
    - `export function weekStart(today: Date): Date`: Monday 00:00 UTC of today's week.
    - `export function thisWeekKeys(today: Date): string[]`: 7 day keys, Monday first.
    - `export function heatmapWeeks(dates: Date[], today: Date, weeks?: number): number[][]`: `weeks` (default 12) columns, oldest first, each 7 check-in counts Monday first; days after today are `-1`.
    - `export function monthTotals(events: StudyEvent[], today: Date): { sessions: number; hours: number }`: events in today's UTC calendar month; hours rounded to the nearest 0.5.

- [ ] **Step 1: Write the failing tests**

In `lib/streak.test.ts` add a `describe("longestStreak")`:
- `longestStreak([])` is `0`.
- Dates on 2026-10-01, 02, 03, 05, 06 (any hour UTC) give `3`.
- Two check-ins on the same UTC day count once: 2026-10-01T01:00Z and 2026-10-01T23:00Z, plus 2026-10-02 give `2`.

In `lib/activity.test.ts` (today is `new Date("2026-10-30T12:00:00Z")`, a Friday):
- `weekStart(today).toISOString()` is `"2026-10-26T00:00:00.000Z"`; for Sunday `2026-11-01T23:30:00Z` it is still `"2026-10-26T00:00:00.000Z"`.
- `thisWeekKeys(today)` equals `["2026-10-26", …, "2026-11-01"]` (7 keys).
- `heatmapWeeks([2026-10-30T08:00Z, 2026-10-30T20:00Z, 2026-10-27T10:00Z], today)` has length 12; the last column is `[0, 1, 0, 0, 2, -1, -1]`; the first column starts on Monday 2026-08-10.
- `monthTotals([{ at: 2026-10-02, hours: 0.75 }, { at: 2026-10-29, hours: 1.5 }, { at: 2026-09-30T23:59Z, hours: 4 }], today)` is `{ sessions: 2, hours: 2.5 }`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run lib/streak.test.ts lib/activity.test.ts`
Expected: FAIL (`longestStreak` and `lib/activity` not found).

- [ ] **Step 3: Implement**

Rename `toDayKey` to exported `dayKey` in `lib/streak.ts` and use it in `computeStreak`. `longestStreak` walks the sorted unique day keys. `lib/activity.ts` imports `dayKey`; all date math uses `getUTCDay`, `setUTCDate`, `Date.UTC`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run lib/streak.test.ts lib/activity.test.ts`
Expected: PASS, including the existing `computeStreak` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/streak.ts lib/streak.test.ts lib/activity.ts lib/activity.test.ts
git commit -m "feat(activity): UTC week, heatmap, month totals and longest streak"
```

---

### Task 2: Plan progress math

**Files:**
- Modify: `lib/planTree.ts` (add `isHeading`, `workLeaves`, `neighbours`, `resolveSelected`, `initialOpen`)
- Modify: `components/pensieve/PlanTree.tsx` (import `isHeading` instead of its private copy)
- Modify: `lib/planTree.test.ts`
- Create: `lib/trackProgress.ts`
- Create: `lib/trackProgress.test.ts`

**Interfaces:**
- Consumes: `StudyEvent`, `thisWeekKeys`, `dayKey` from Task 1; existing `currentLeaf`, `leavesOf`, `parentOf`, `findNode`, `weeksOf`, `daysInWeekOf`, `doneDays`; `dayMinutes`, `totalHours` from `lib/studyTime.ts`.
- Produces in `lib/planTree.ts`:
  - `export function isHeading(node: PlanNode): boolean`, moved verbatim from `PlanTree.tsx`: a childless non-day node with no budget.
  - `export function workLeaves(root: PlanNode): PlanNode[]`: `leavesOf(root)` without headings.
  - `export function neighbours(root: PlanNode, id: string): { prev: PlanNode | null; next: PlanNode | null }`: among `workLeaves`.
  - `export function resolveSelected(root: PlanNode, id: string | undefined): PlanNode`: the node with that id if it exists and isn't the root; else `currentLeaf(root)`; else the last work leaf; else the first child of the root.
  - `export function initialOpen(root: PlanNode, currentLeafId: string | null): Set<string>`: ids of every ancestor of the current leaf below the root.
- Produces in `lib/trackProgress.ts`:
  - `export type CellState = "done" | "current" | "ready" | "planned"`
  - `export interface StripCell { state: CellState; weekStart: boolean }`
  - `export function dayStrip(root: PlanNode, granularity: Granularity): StripCell[]`
  - `export function finishDate(root: PlanNode, daysPerWeek: number, today: Date): Date | null`
  - `export interface CheckIn { nodeId: string; completedAt: Date; hours: number | null }`
  - `export function studyEvents(root: PlanNode, checkIns: CheckIn[], hoursPerWeek: number, daysPerWeek: number): StudyEvent[]`
  - `export function plannedHours(root: PlanNode, hoursPerWeek: number, daysPerWeek: number): number`
  - `export interface WeekActivity { cells: ("done" | "current" | "open")[]; label: string }`
  - `export function weekActivity(root: PlanNode, granularity: Granularity, checkIns: CheckIn[], today: Date, hoursPerWeek: number): WeekActivity`
  - `export function doneToday(checkIns: Pick<CheckIn, "completedAt">[], today: Date): boolean`
  - `export type CardAction = { kind: "start" | "log"; node: PlanNode } | { kind: "plan"; node: PlanNode } | { kind: "finished" }`
  - `export function cardAction(root: PlanNode, granularity: Granularity): CardAction`
  - `export type SortKey = "next" | "recent" | "newest"`
  - `export function sortTracks<T extends { createdAt: Date; lastStudied: Date | null; action: CardAction; doneToday: boolean }>(cards: T[], key: SortKey): T[]`

Build the test trees with the existing helpers `makeNode` / `makeRoot` / `layout` from `lib/planTree.ts`, as `lib/planTree.test.ts` already does.

- [ ] **Step 1: Write the failing tests**

`lib/planTree.test.ts`, on a tree of Week 1 (Days 1–3, all completed), Week 2 (Day 1 completed, Day 2 generated, Day 3 pending), and Week 3 (an unplanned heading, len 3):
- `workLeaves` has 6 entries; the heading isn't one of them.
- `neighbours(root, week2day2.id)` gives `prev` week2day1 and `next` week2day3. The first leaf's `prev` is null.
- `resolveSelected(root, "nope")`, `resolveSelected(root, "root")` and `resolveSelected(root, undefined)` all return week2day2 (the current leaf). `resolveSelected(root, week1.id)` returns week1.
- With every leaf completed and Week 3 removed, `resolveSelected(root, undefined)` returns the last day.
- `initialOpen(root, week2day2.id)` equals `new Set([week2.id])`. On a month → week → day tree it holds the month id and the week id.

`lib/trackProgress.test.ts`:
- `dayStrip` on the tree above, `"day"` granularity: 9 cells with states `done, done, done, done, current, planned, planned, planned, planned` (Week 2 Day 2 is the current leaf, so `current` wins over `generated`). `weekStart` is true at indexes 0, 3 and 6 only.
- `dayStrip` with a `generated` leaf after the current one marks it `ready`.
- `dayStrip` on a week-granularity tree (three week leaves: completed, current, pending): 3 cells `done, current, planned`, all `weekStart: true`.
- `dayStrip` on a month → week → day tree puts `weekStart` at each week's first day, not only at the month's.
- `finishDate(root, 5, today)` with 10 days left is `today + 14 days`, and with 3 days left it is `today + 5 days` (`Math.ceil(remaining / daysPerWeek * 7)` calendar days). With nothing left it is `null`.
- `studyEvents`: a day check-in becomes `dayMinutes(hoursPerWeek, daysInWeekOf(…)) / 60` hours; a week session keeps its `hours`.
- `weekActivity` on the day tree with Week 2 Day 1 done: cells `["done", "current", "open"]`, label `"1 of 3 this week"`.
- `weekActivity` on a week-granularity tree, today 2026-10-30, sessions of 1 h on Tue 2026-10-27 and 0.5 h on Fri 2026-10-30, `hoursPerWeek` 4: cells `["open", "done", "open", "open", "done", "open", "open"]`, label `"1.5 of 4 h"`.
- `cardAction`: a day current leaf gives `{ kind: "start" }`, a week leaf gives `{ kind: "log" }`, a heading current gives `{ kind: "plan", node: heading }`, and an all-completed tree gives `{ kind: "finished" }`.
- `sortTracks(cards, "next")`: a start/log card not done today comes first, then done-today cards, then plan cards, then finished cards. Ties go by `lastStudied` descending (null last), then `createdAt` ascending. `"recent"` sorts by `lastStudied` only; `"newest"` by `createdAt` descending.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run lib/planTree.test.ts lib/trackProgress.test.ts`
Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement**

`dayStrip` walks the tree in order: a day leaf emits one cell; a week leaf on `"day"` granularity or a heading emits `len` cells with one state; on `"week"` granularity each week leaf or week heading emits one cell. The state comes from `status` (`completed` → done, the current leaf's id → current, `generated` → ready, else planned). A cell starts a week when it is the first day emitted under a week node, or any cell on week granularity. `plannedHours` is `totalHours(weeksOf(root, root, daysPerWeek), hoursPerWeek)`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run lib/planTree.test.ts lib/trackProgress.test.ts && npx tsc --noEmit`
Expected: PASS; `PlanTree.tsx` compiles with the moved `isHeading`.

- [ ] **Step 5: Commit**

```bash
git add lib/planTree.ts lib/planTree.test.ts lib/trackProgress.ts lib/trackProgress.test.ts components/pensieve/PlanTree.tsx
git commit -m "feat(progress): day strip, finish date, week activity, card actions and sorting"
```

---

### Task 3: Check-in queries

**Files:**
- Create: `lib/db/activity.ts`
- Create: `lib/db/activity.test.ts`
- Modify: `lib/db/queries.ts` (`DashboardTrack`, `getDashboardTracksForUser`)
- Modify: `app/dashboard/page.tsx` (only to compile against the new `DashboardTrack`)

**Interfaces:**
- Consumes: `CheckIn` from Task 2.
- Produces:
  - `lib/db/activity.ts`:
    - `export interface CheckInRow extends CheckIn { nodeTitle: string; nodeLevel: PlanLevel; trackId: string; trackTitle: string }`
    - `export async function getUserCheckIns(userId: string): Promise<CheckInRow[]>`: newest first, only the user's tracks.
    - `export async function getTrackCheckIns(trackId: string, userId: string): Promise<CheckInRow[]>`: newest first; empty for another user's track.
  - `lib/db/queries.ts`: `DashboardTrack` becomes `{ track; root: PlanNode; checkIns: CheckInRow[] }`. `getDashboardTracksForUser` builds `root` with `rowsToTree(nodeRows…)` as now, and `checkIns` from one `getUserCheckIns` call filtered by `trackId`. `total`, `done` and `checkInDates` go away; callers derive them.

- [ ] **Step 1: Write the failing test**

`lib/db/activity.test.ts` mocks `./client` with `createTestDb` exactly as `lib/db/userApiKeys.test.ts` does, then inserts rows directly with `db.insert`: two tracks for `u1`, one for `u2`; a day node and a week node; check-ins at 2026-10-28 (day, `hours` null) and 2026-10-29 (week, `hours` 1.5).
- `getUserCheckIns("u1")` returns 2 rows, newest first, with `trackTitle`, `nodeTitle`, `nodeLevel`, and `hours` `1.5` / `null`.
- `getUserCheckIns("u2")` returns only `u2`'s rows.
- `getTrackCheckIns(u1TrackId, "u2")` is `[]`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run lib/db/activity.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement both queries and the `getDashboardTracksForUser` change**

Join `check_ins` → `plan_nodes` → `tracks`, filter on `tracks.userId`, order by `checkIns.completedAt` descending. In `app/dashboard/page.tsx`, compute `total = root.len`, `done = doneDays(root)` and the streak from `checkIns.map((c) => c.completedAt)`, so it still renders until Task 4 replaces it.

- [ ] **Step 4: Run tests and the typecheck**

Run: `npx vitest run lib/db/activity.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/activity.ts lib/db/activity.test.ts lib/db/queries.ts app/dashboard/page.tsx
git commit -m "feat(db): check-in rows per user and per track; dashboard tracks carry their tree"
```

---

### Task 4: App shell and routes

**Files:**
- Modify: `components/pensieve/PageShell.tsx`
- Create: `components/pensieve/TopBar.tsx` (server)
- Create: `components/pensieve/NavTabs.tsx` (client)
- Create: `components/pensieve/AccountMenu.tsx` (client)
- Delete: `components/pensieve/TopNav.tsx`
- Modify: `app/page.tsx` (becomes the home; for now it renders the old dashboard body, moved over unchanged)
- Modify: `app/dashboard/page.tsx` (becomes `redirect("/")`)
- Modify: every `"/dashboard"` reference: `app/tracks/[id]/actions.ts` (3), `app/tracks/new/actions.ts`, `app/tracks/new/NewTrackForm.tsx`, `app/settings/ApiKeyCard.tsx`, `app/tracks/[id]/page.tsx`. Each becomes `"/"`.
- Modify: `PageShell` callers to keep their widths: `app/settings/page.tsx` → `className="mx-auto max-w-[960px]"`; `app/tracks/new/page.tsx` and `app/tracks/[id]/adjust/page.tsx` (were `wide`) → `className="mx-auto max-w-[1280px]"`; `app/tracks/[id]/page.tsx` and `app/tracks/[id]/nodes/[nodeId]/page.tsx` → `className="mx-auto max-w-[960px]"` until Tasks 6 and 8.

**Interfaces:**
- Produces:
  - `export function PageShell({ children, className }: { children: ReactNode; className?: string })`: renders `<TopBar />`, then `<main className={cn("px-8 pt-6 pb-24 max-[640px]:px-4", className)}>`, then `<AdminDock />`. The `wide` prop is removed.
  - `export async function TopBar()`: a 60px full-width bar with a bottom hairline (`border-b border-border`). From left: the brand (`size-7 rounded-full bg-primary` mark plus "Pensieve" in `font-heading`) linking to `/`, then `<NavTabs />`; on the right (`ml-auto`), a streak chip (lucide `Flame`, the number, `bg-accent-100 text-accent-800 rounded-full`) from `computeStreak(getCheckInDatesForUser(userId))`, then `<AccountMenu admin={isAdminUserId(userId)} />`. The search box's spot stays empty this round.
  - `export function NavTabs()`: uses `usePathname()`. "Tracks" links to `/` and is active when the path is `/` or starts with `/tracks`. Active style: `font-semibold` with a 2.5px `border-primary` bottom border. "Explore" and "Journey" are `<span aria-disabled="true">` with muted text and a "soon" pill. Icons: `Route`, `Compass`, `History`.
  - `export function AccountMenu({ admin }: { admin: boolean })`: a base-ui `Menu`. The trigger is the user's avatar (`useUser().user?.imageUrl`, initials as fallback, 28px circle). Items: "Settings" (link to `/settings`); for admins only, the existing `<AdminToggle />` in an item that doesn't close the menu; "Sign out" (`useClerk().signOut({ redirectUrl: "/sign-in" })`).

- [ ] **Step 1: Make the changes listed above**

`app/page.tsx` takes over the current dashboard JSX and data loading as they are after Task 3, so the home still works before Task 5.

- [ ] **Step 2: Check it**

Run: `npm test && npx tsc --noEmit && npm run lint && grep -rn '"/dashboard"' app components lib`
Expected: all pass; the grep prints only `app/dashboard/page.tsx`'s own redirect, or nothing.

Then on `localhost:3001` in Chrome: `/` shows the top bar with Tracks active; `/dashboard` lands on `/`; a track page and `/settings` keep the bar, with Tracks active on the track page and none active on settings. The avatar menu opens with Settings and Sign out (don't click Sign out). Explore and Journey don't navigate.

- [ ] **Step 3: Commit**

```bash
git add -A components/pensieve app
git commit -m "feat(shell): full-width top bar with Tracks, Explore and Journey tabs; home at /"
```

---

### Task 5: Tracks home

**Files:**
- Modify: `app/page.tsx`
- Create: `components/pensieve/home/TrackCard.tsx`
- Create: `components/pensieve/home/StatsRail.tsx`
- Create: `components/pensieve/home/Heatmap.tsx`
- Create: `components/pensieve/home/SortMenu.tsx` (client)

**Interfaces:**
- Consumes: `getDashboardTracksForUser`, `getUserCheckIns` (Task 3); `cardAction`, `weekActivity`, `finishDate`, `doneToday`, `studyEvents`, `sortTracks`, `SortKey` (Task 2); `heatmapWeeks`, `monthTotals` (Task 1); `computeStreak`, `longestStreak`; `dayMinutes`, `formatDayTime`, `fullLabelOf`, `labelOf`.
- Produces:
  - `export interface TrackCardData { id: string; title: string; pace: string; action: CardAction; actionLabel: string; actionTitle: string; doneToday: boolean; week: WeekActivity; progress: { done: number; total: number; unit: "Day" | "Week" }; finish: Date | null; createdAt: Date; lastStudied: Date | null }`
  - `export function TrackCard({ card }: { card: TrackCardData })`
  - `export function StatsRail({ streak, longest, month, heatmap, recent }: { streak: number; longest: number; month: { sessions: number; hours: number }; heatmap: number[][]; recent: CheckInRow[] })`
  - `export function SortMenu({ value }: { value: SortKey })`: options "Up next first" (`next`), "Last studied" (`recent`), "Newest" (`newest`); writes `?sort=` with `router.replace`.

Page (`app/page.tsx`, `searchParams: Promise<{ sort?: string }>`):

- Layout: `grid grid-cols-[minmax(0,1fr)_320px] gap-0` with the rail separated by a left hairline and a light tint; one column below 900px.
- Header: `<h1>` "Your tracks", a status line, and a primary **New track** button linking to `/tracks/new`. The status line counts start/log cards not done today: 0 → "You're done for today.", 1 → "One session left today. Pick up where you left off.", n → "{n} sessions left today. Pick up where you left off."
- Toolbar: "{n} tracks" on the left, `<SortMenu>` on the right.
- Grid: `grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4`, the cards in `sortTracks` order, then a dashed card linking to `/tracks/new` with "Start a new track" and "Tell Pensieve what you want to learn".
- No tracks: keep today's empty state (title "No tracks yet", its body copy, and the New track button), centered in the main column, with the rail still shown.

TrackCard (see the mock's B home):

- The whole card links to `/tracks/{id}` through a stretched `after:absolute` link, as `PlanTree`'s `LeafChip` does. The inset's button sits above it (`relative z-10`).
- Top line: pace, as "Daily · {formatDayTime(dayMinutes(hoursPerWeek, daysPerWeek))}" or "Weekly · {hoursPerWeek} h". Then the title in `font-heading`, about 19px.
- Inset (`bg-secondary rounded-2xl`):
  - start / log: a kicker "Today · {fullLabelOf}" or "This week · {labelOf}", the leaf title, and **Start** or **Log** linking to `/tracks/{id}/nodes/{leafId}`.
  - Done today: the inset turns `bg-accent-2-100 text-accent-2-800` with a check, "Done today" and the title, and no button.
  - plan: "{labelOf} isn't planned yet" with **Plan it** linking to `/tracks/{id}?day={headingId}`.
  - finished: "All days done", sage, no button.
- Week squares: 14px rounded squares (`done` sage, `current` dashed terracotta outline, `open` faint) with `week.label` on the right.
- Progress bar (`components/ui/progress`), then a footer "{unit} {done} of {total}" and "Ends {finish, formatted "MMM d"}" when `finish` isn't null.

StatsRail: the streak in `font-heading` 40px with "days · longest {n}"; two tiles, "{sessions} sessions this month" and "{hours} h studied this month"; the 12-week `Heatmap`, a CSS grid of 7 rows flowing by column, with cell colors by count (0 faint, 1 `accent-2-200`, 2 `accent-2-400`, 3 or more `accent-2-600`, -1 transparent) and a Less/More legend; "Recently": the first 4 `recent` rows, each with a sage check, "Finished {nodeTitle}" (days) or "Logged {hours} h on {nodeTitle}" (weeks), and "{trackTitle} · {relative day}" underneath.

- [ ] **Step 1: Build the page and components as specified**

- [ ] **Step 2: Check it**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: pass.

On `localhost:3001`: the home matches the mock's B home layout at 1280px wide; `?sort=recent` and `?sort=newest` reorder the cards; the Start button opens the lesson page and the rest of the card opens the plan page. At 800px wide the rail moves below the grid.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx components/pensieve/home
git commit -m "feat(home): track cards with today's lesson and week activity, stats rail"
```

---

### Task 6: Plan page frame and the Materials, Activity and About tabs

**Files:**
- Modify: `app/tracks/[id]/page.tsx`
- Create: `app/tracks/[id]/TrackHeader.tsx`
- Create: `components/pensieve/DayStrip.tsx`
- Create: `app/tracks/[id]/TrackTabs.tsx`
- Create: `app/tracks/[id]/ActivityTab.tsx`

**Interfaces:**
- Consumes: `getTrackDetail`, `getTrackCheckIns`; `dayStrip`, `finishDate`, `studyEvents`, `plannedHours`; `weekStart`; the existing `MaterialsList`, `PlanSummaryCard`, `TimeSplitCard`, `TrackPlan`.
- Produces:
  - `export type TrackTab = "plan" | "materials" | "activity" | "about"`
  - `export function TrackTabs({ trackId, active, materialsCount }: { trackId: string; active: TrackTab; materialsCount: number })`: Links to `?tab=`, with plan as the default and no param.
  - `export function DayStrip({ cells }: { cells: StripCell[] })`: a full-width flex row of 10px-tall rounded blocks, `ml-1.5` on a `weekStart` cell after the first. Colors: done `accent-2-500`, current `primary`, ready `accent-300`, planned `foreground/8`.
  - `export function TrackHeader(props: { title: string; pace: string; done: number; total: number; studied: number; planned: number; finish: Date | null; adjustHref: string })`

Page (`searchParams: Promise<{ tab?: string; day?: string }>`):

- `PageShell` with no width cap (remove Task 4's temporary class).
- The breadcrumb "Your tracks › {title}" links to `/`.
- `TrackHeader`: the title (`font-heading` about 28px), the pace line "Daily · {daysPerWeek} days a week · {hoursPerWeek} h a week" (or "Weekly · …"), and on the right three inline stats, "{done} / {total}" days done, "{studied} h" of "{planned} h", and "{MMM d}" finish (omitted when null). Then **Adjust plan** (secondary, links to `/tracks/{id}/adjust`).
- `DayStrip`, then `TrackTabs`.
- Tab bodies:
  - plan: the existing `<TrackPlan …>` with its current props (replaced in Task 7).
  - materials: `<MaterialsList topic={title} materials={materials} initialShown={12} />`.
  - about: `PlanSummaryCard` and `TimeSplitCard` side by side (stacked below 900px), read-only, with the same props as today's page.
  - activity: `<ActivityTab rows={…} />`.
- An unknown `tab` falls back to plan.

ActivityTab: rows grouped by `weekStart(completedAt)`, newest week first, each group headed "Week of {d MMM}". A row: a sage check, the node title, then "{weekday}, {time}" and "· {hours} h" for sessions. Empty state: "No check-ins yet. Finished days and logged sessions show up here."

- [ ] **Step 1: Build as specified**

- [ ] **Step 2: Check it**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: pass.

On `localhost:3001`, open a real track and check each tab. The strip's block count equals the header's day total (or the week count on a week track). An unknown `?tab=x` shows Plan.

- [ ] **Step 3: Commit**

```bash
git add app/tracks/[id] components/pensieve/DayStrip.tsx
git commit -m "feat(plan-page): full-width header, day strip, and Materials, Activity and About tabs"
```

---

### Task 7: Plan tab, outline and day pane

**Files:**
- Create: `app/tracks/[id]/usePlanning.ts` (client hook extracted from `TrackPlan.tsx`)
- Create: `app/tracks/[id]/PlanOutline.tsx` (client)
- Create: `app/tracks/[id]/DayPane.tsx` (server)
- Create: `components/pensieve/leaf/MarkCompleteButton.tsx`, `components/pensieve/leaf/LogSessionForm.tsx`, `components/pensieve/leaf/GenerateLessonButton.tsx`, `components/pensieve/leaf/PlanUnitButton.tsx` (all client)
- Create: `lib/lessonPreview.ts` and `lib/lessonPreview.test.ts`
- Modify: `app/tracks/[id]/page.tsx` (plan tab)
- Delete: `app/tracks/[id]/TrackPlan.tsx`, and `components/pensieve/StreakChip.tsx` once nothing imports it

**Interfaces:**
- Consumes: `isHeading`, `workLeaves`, `resolveSelected`, `initialOpen`, `currentLeaf`, `labelOf`, `fullLabelOf`, `spanOf`, `doneDays` (planTree); `readRowsFor`, `practiceRowsFor`, `ReadRows`, `DoRows`, `sumMinutes`, `sumPracticeMinutes` (ReadTable); `getLeafWithContent` (planQueries); `expandNodeAction`, `markCompleteAction`, `logSessionAction` (`app/tracks/[id]/actions.ts`); `generateLeafContentAction`.
- Produces:
  - `export interface PlanAll { total: number; done: number; costUsd: number }` (moved from `TrackPlan.tsx`).
  - `export function usePlanning(input: { trackId: string; root: PlanNode; granularity: Granularity; daysPerWeek: number }): { run(nodeId: string, reason: "expand" | "split", splitDays?: number): void; pending: Record<string, PendingSlots>; isPending: boolean; error: string | null; errorLink: boolean; lastCost: number | null; stepsLeft: number; planAll: PlanAll | null; planning: boolean; nextStepLabel: string | null; confirming: boolean; setConfirming(v: boolean): void; startAll(): void; stopAll(): void }`. Lift the logic from `TrackPlan.tsx` unchanged: the run, plan-all loop, `STEP_COST_USD` and the error handling.
  - `export function PlanOutline(props: { trackId: string; root: PlanNode; granularity: Granularity; daysPerWeek: number; selectedId: string; currentLeafId: string | null })`
  - `export async function DayPane(props: { trackId: string; root: PlanNode; node: PlanNode; currentLeafId: string | null; materials: Material[]; hoursPerWeek: number; daysPerWeek: number; userId: string })`
  - `export function MarkCompleteButton({ nodeId, completed, onDone }: { nodeId: string; completed: boolean; onDone?: () => void })`: calls `markCompleteAction`, then `onDone` or else `router.refresh()`.
  - `export function LogSessionForm({ nodeId, budgetHours, sessions, onLogged }: { nodeId: string; budgetHours: number | null; sessions: { hours: number }[]; onLogged?: (hours: number) => void })`: the hours input and "Log session", lifted from `LeafView`'s `sessionCard`, with its validation (0.25–24) and its "Time budget about … · N sessions, X h logged" line.
  - `export function GenerateLessonButton({ trackId, nodeId, unit }: { trackId: string; nodeId: string; unit: "day" | "week" })`: calls `generateLeafContentAction`, pushes model calls, then `router.refresh()`. Same labels and the same Settings link on a key error as `LeafView`.
  - `export function PlanUnitButton({ trackId, nodeId, reason, label }: { trackId: string; nodeId: string; reason: "expand" | "split"; label: string })`
  - `lib/lessonPreview.ts`: `export function firstParagraph(markdown: string, max?: number): string`: the first paragraph that isn't a heading, code fence, list or quote, with inline markdown (`**`, `_`, backticks, `[text](url)` → text) stripped, cut at a word boundary to `max` (default 320) with "…".

Layout of the plan tab: `grid grid-cols-[440px_minmax(0,1fr)]`, the outline with a right hairline, one column below 900px.

PlanOutline (see the mock's option 1):

- A top-level row per unit: the label in `font-heading` 11px `text-accent-700`, the title on one line, and on the right "{done} of {len}", a sage check when all done, "{budgetHours} h" for an unsplit week leaf, or "not planned" for a heading. Plus a chevron button that toggles open.
- Open state starts from `initialOpen(root, currentLeafId)`. Fully done units start closed (the rule `TrackPlan` uses today); the chevron toggles.
- The unit title is a `Link` to `?day={unitId}` (`scroll={false}`), keeping any `tab` param.
- An open unit lists its children: nested units recurse with the same row; leaves get a status circle (done sage check / current terracotta dot / open ring), the label, the title truncated to one line, and "Today" (the current leaf) or "Ready" (`generated`) on the right. Each is a `Link` to `?day={leafId}`.
- The `selectedId` row gets `bg-neutral-100 shadow-sm` and an inset 3px left `primary` edge.
- While `pending[unitId]` is set, render `count` skeleton rows (`skeleton-bar`) under that unit.
- Inline actions on rows: **Split into days** on a week leaf that has no sessions and isn't done or busy (`run(id, "split")`), and on a heading the label `Plan {label}` (`run(id, "expand")`).
- Bottom: when `stepsLeft > 0`, a dashed row "{stepsLeft} weeks left to plan" with **Plan everything**, then the same confirm, progress, stop and cost states as `TrackPlan` (same copy). The error line and "Open Settings" link show under it.

DayPane (server):

- A leaf:
  - The kicker `fullLabelOf` plus " · Today" when it's the current leaf, uppercase 11px `text-primary`. The title (`font-heading` 26px) and the summary.
  - An action row: **Open lesson** (primary, `/tracks/{trackId}/nodes/{id}`). `MarkCompleteButton` only when a lesson exists, or "Completed" when done. On week leaves, `LogSessionForm` alongside. Then a time line, "{total} min · {read} reading, {practice} practice", from the rows' minutes.
  - Two `bg-secondary rounded-[20px]` boxes, "Read" with `<ReadRows rows>` and "Do" with `<DoRows rows>`, each headed with its minutes; one box only when one list is empty.
  - The lesson card: with content, "Lesson ready · written from {readRows.length} materials" (or "Lesson ready" when there are none) and `firstParagraph(content)`; without content, the prompt copy from `LeafView` and `GenerateLessonButton`.
- A unit (group or heading): the label, title and summary, `spanOf`, the budget for a week leaf, and `PlanUnitButton` with "Split into days" or "Plan {label}" when the outline would offer it. A done unit says "Done".

Page: `const selected = resolveSelected(root, day)`. Render `<PlanOutline selectedId={selected.id} … />` and `<DayPane node={selected} … />`. Attach `node.sessions` the way the page does today.

- [ ] **Step 1: Write the failing `firstParagraph` tests**

- `"# Title\n\nFirst **bold** para with [a link](https://x).\n\nSecond."` gives `"First bold para with a link."`.
- A leading fenced code block and a list are skipped.
- A 400-character paragraph is cut to 320 or fewer characters, ends with "…", and doesn't split a word.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run lib/lessonPreview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `firstParagraph`, then build the hook, components and page as specified, and delete `TrackPlan.tsx`**

- [ ] **Step 4: Check it**

Run: `npm test && npx tsc --noEmit && npm run lint && grep -rn "TrackPlan\|StreakChip" app components`
Expected: all pass; the grep prints nothing.

On `localhost:3001`, open a real track. The current leaf is selected and its unit is open. Clicking another day updates the pane and the URL without scrolling to the top. `?day=garbage` shows the current leaf. Open lesson goes to the lesson page. A week-granularity track (if you have one) shows Log session in the pane. Don't click planning, completion or logging actions (Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add -A app/tracks/[id] components/pensieve lib/lessonPreview.ts lib/lessonPreview.test.ts
git commit -m "feat(plan-page): outline with day pane; planning actions move into the outline"
```

---

### Task 8: Lesson page

**Files:**
- Modify: `app/tracks/[id]/nodes/[nodeId]/page.tsx`
- Modify: `app/tracks/[id]/nodes/[nodeId]/LeafView.tsx`

**Interfaces:**
- Consumes: `neighbours`, `fullLabelOf` (planTree); `MarkCompleteButton`, `LogSessionForm` (Task 7); `ReadRow`, `PracticeRow`, `TierPill`, `partLabel`, `sumMinutes`, `sumPracticeMinutes` (ReadTable).
- Produces: `LeafView` gains `prev: LeafLink | null` and `next: LeafLink | null`, where `export interface LeafLink { href: string; label: string; title: string }`. Its other props stay. It now renders the whole two-column body.

Page: `PageShell` with no width cap. The breadcrumb is "Your tracks › {track title} › {fullLabelOf}", with links to `/` and `/tracks/{id}`. Below it, the kicker `fullLabelOf` (plus " · Today" when it is `currentLeaf`), the `<h1>` title (about 32px) and the summary as a muted lede. `prev`/`next` come from `neighbours(root, nodeId)`, with each href `/tracks/{id}/nodes/{nodeId}`.

LeafView: `grid grid-cols-[minmax(0,1fr)_300px]`, one column below 900px.

- Main column: content capped at `max-w-[680px]` with `pl-[clamp(0px,6vw,96px)]`.
  - With a lesson: `LessonMarkdown`, then "Related video", the cost line and `WhereTheseComeFrom`, all as today.
  - Without one: the existing "isn't written yet" card with the generate button, its error and the Settings link, then `WhereTheseComeFrom`.
  - The Read table and the session card no longer render here.
- Rail (`bg-[color-mix(in_srgb,var(--secondary)_45%,var(--background))]` with a left hairline, full height):
  - A heading "Today · {formatDayTime(budgetMinutes)}" (or "This week · …" for a week). A checklist: first "Read the lesson", then each read row (title, `TierPill`, `partLabel` underneath, minutes on the right), then each practice row (label and task, minutes). Ticks live in `useState` only and aren't saved.
  - With a lesson: `MarkCompleteButton` (full width, label "Mark {fullLabelOf} complete") with `onDone={() => setCompleted(true)}`, showing "Completed" when done. Week leaves get `LogSessionForm` above it, with `onLogged` appending to `sessions`.
  - "Sources": `content.citations` as a plain list of links (`title`, opening in a new tab). Hidden when there are none.
  - At the bottom: `prev` and `next` as two small cards ("← {label}" / "{label} →" above the title), then a ghost **Rewrite this lesson** button (`RefreshCw` icon) that calls the existing `handleGenerate`. Shown only when a lesson exists.

- [ ] **Step 1: Build as specified**

- [ ] **Step 2: Check it**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: pass.

On `localhost:3001`, open a lesson that exists and one that doesn't (read-only). Check the layout against the mock's "Lesson, case 1" at 1280px, that prev/next navigate, that the rail drops below at 800px, and that `WhereTheseComeFrom` still shows.

- [ ] **Step 3: Commit**

```bash
git add "app/tracks/[id]/nodes/[nodeId]"
git commit -m "feat(lesson): reading column with a rail for today's checklist, completion, sources and day links"
```

---

### Task 9: Whole-app pass

**Files:** any touched above, for fixes only.

- [ ] **Step 1: Run the full check**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 2: Walk the app on `localhost:3001`**

Go home → a track → each tab → a day → its lesson → the next day → back home, at 1280px and at 800px. Then `/tracks/new`, `/tracks/{id}/adjust` and `/settings`: they work as before inside the new bar. Check the Review Focus items you can see without changing data (an unknown `?day=`, an unknown `?tab=`, a week-granularity track and a three-level plan if your account has them).

- [ ] **Step 3: Commit any fixes**

```bash
git add -A app components lib
git commit -m "fix(shell): issues found in the whole-app pass"
```
