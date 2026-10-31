# App shell, tracks home and plan page redesign

**Status:** design, not built. Visual reference: `docs/mockups/home-redesign.html` (open it in a browser). The screens
this design picks are "B · Top tabs, tracks board with a stats rail", "B · Plan page, option 1: outline and day
preview", and "Lesson, case 1: its own page". The other screens in that file were options that weren't chosen.

## Summary

Pensieve today is a single centered 960px column on every page, with a small top bar and a grid of large rounded
cards. On a laptop it reads like a phone layout with empty margins. This redesign gives the app a real desktop shell
(a top bar with Tracks, Explore and Journey tabs), turns the dashboard into a Tracks home with richer cards and a stats
rail, and rebuilds the track page as an outline of the plan on the left with the selected day open on the right. The
lesson keeps its own page, restyled for reading.

## Why

The user's own words: the home page "looks so not like a web application opened from a laptop's browser." The app is
also about to grow sections: a marketplace-like place to browse plans other people liked (Explore) and a place for
learning history, streaks and archived tracks (Journey). The current layout has nowhere to put them. The track page
stacks summary, time split, materials and the plan tree in one long scroll, so the thing you came to do (today's
lesson) is far down the page.

## Goals, non-goals, anti-goals

Goals:

1. Every signed-in page sits in one shell with a persistent top bar and tabs, and uses the laptop's width.
2. The home page answers "what do I study next on each track?" without opening a track.
3. The plan page shows where you are in the whole plan and lets you look at any day without leaving the page.
4. Explore and Journey have a visible place in the shell now, so adding them later is adding a page, not a redesign.

Non-goals (this round):

- Building Explore or Journey themselves.
- Search. The mock shows a ⌘K search box; this round reserves its spot in the top bar but does not build it (see
  "Decided by the designer").
- Changing the new-track flow, the Adjust plan page, or any planning, drafting or lesson-writing logic. Those pages
  only move into the new shell.
- Changing a track's status. Nothing in the app moves a track out of `active` today, so this round shows active tracks
  only: no Active / Completed / Archived switch, no status tags, no archive action. The user decided these wait and
  arrive with Journey.
- A separate mobile design. Pages must still work on a narrow screen by stacking (see Constraints).
- Dark mode.

Anti-goals, which would make this a failure even if it technically works:

- The app still feels like a phone layout on a laptop: content in a narrow centered column with empty sides.
- The redesign loses something the current track page can do (expand, split, plan everything, see materials, see the
  time split, mark a day complete, log a week session).
- It looks like a generic dashboard template. It must keep Pensieve's look: cream background, terracotta primary,
  sage for done, Caprasimo headings, Figtree text, large soft radii.

## Constraints

- Next.js 16 App Router as already used in the repo. Read `node_modules/next/dist/docs/` before writing routing or
  layout code (AGENTS.md).
- Existing design tokens in `app/globals.css` (accent, accent-2 and neutral ramps, `--shadow-*`, fonts). New colors come
  from those ramps, not new hex values.
- Clerk auth stays as is (`proxy.ts` protects everything but sign-in and sign-up).
- The admin model-calls dock (`AdminDock`, mounted by `PageShell` today) must still mount on every page for admins.
- Plans are not tied to calendar dates. A day is "Day 9", not "Thursday". "Today's lesson" means the plan's current
  leaf, `currentLeaf(root)` in `lib/planTree.ts` (the first leaf not completed). Done-today means that leaf or another
  got a check-in today.
- Plans have two or three levels: month → week → day for long plans, week → day for short ones (`topLevelFor`), and
  on week-granularity tracks the leaves are weeks with logged sessions (`hours` on `check_ins`), not days.
- Streak day boundaries are UTC (`lib/streak.ts`); this redesign does not change that.
- Narrow screens (below roughly 900px) stack: rails move under the main content, the plan page's outline and day pane
  become one column with the outline first.

## The design

### Shell (every signed-in page)

Replaces `PageShell` and `TopNav`. A full-width top bar, about 60px tall, with a hairline bottom border:

- Left: the Pensieve mark and wordmark, linking home.
- Tabs: **Tracks** (active on home, plan and lesson pages), **Explore** and **Journey**. Explore and Journey carry a
  small "soon" badge and are not links yet.
- Right: the search box slot (not built this round), a streak chip (flame icon and the number, from
  `computeStreak(getCheckInDatesForUser)`), and the user's avatar. The avatar opens a menu with Settings and sign out.
  The admin toggle (`AdminToggle`) moves into that menu for admins.
- Page content below the bar uses the full width with 32px side padding. Pages decide their own inner grid; there is no
  global max-width column anymore (a reading column on the lesson page is fine).

Routes: `/` and `/dashboard` both land on the Tracks home. The canonical URL is the builder's choice (see
"Left to the builder").

### Tracks home

Main area plus a 320px right rail.

Main area:

- Header: "Your tracks" (Caprasimo, about 30px), a one-line status under it ("Two sessions left today. Pick up where
  you left off."), and a primary **New track** button on the right.
- Toolbar: the track count on the left and a sort menu on the right. Default sort is "Up next first" (tracks with an
  undone current leaf first, then done-today, then by last activity). The mock's Active / Completed / Archived switch
  is not built this round (see Non-goals); the toolbar keeps room for it.
- A grid of track cards, three across at 1280px, auto-filling narrower. Each card shows:
  - Pace ("Daily · 40 min" or "Weekly · 4 h"). No status tag and no overflow menu this round; the whole card links to
    the plan page.
  - Title.
  - The current leaf in a tinted inset: "Today · Day 9" or "This week · Week 2", its title, and **Start** (day tracks,
    goes to the lesson page) or **Log** (week tracks, opens the existing log-session flow). When that leaf or another
    got a check-in today, the inset turns sage and says "Done today".
  - This week's activity: one small square per study day of the current plan week, filled for done, outlined for the
    current leaf, with "3 of 5 this week" or "1.5 of 4 h" at the right.
  - A progress bar and a footer: "Day 8 of 30" (or "Week 2 of 8") and an estimated finish date.
- A dashed "Start a new track" card at the end of the grid.

Right rail:

- Streak: the current streak as a large number, and the longest streak.
- Two stat tiles: sessions this month and hours studied this month.
- A 12-week activity grid (7 rows by 12 columns, sage shades by check-ins that day, with a Less/More legend).
- Recently: the last three or four check-ins across tracks, each with the day or week title, the track and when.

The finish date is an estimate: remaining study days spread over the track's `daysPerWeek`, counted from today. "Hours
studied" sums `hours` on week sessions and each completed day's planned minutes; the builder may simplify if that's
awkward (see "Left to the builder").

### Plan page (`/tracks/[id]`)

Header (full width):

- Breadcrumb: Your tracks › track title.
- Title row: title (Caprasimo, about 28px), then a pace line ("Daily · 5 days a week · 3.5 h a week"). On the right:
  three inline stats (days done of total, hours studied of the plan's total hours, estimated finish date) and
  **Adjust plan** (goes to the existing adjust page). No status tag or overflow menu this round.
- Day strip: one small block per plan day across the full width, small gaps between weeks, colored done (sage), current
  (terracotta), lesson ready (light terracotta, `status = "generated"`), planned (neutral). On week-granularity tracks
  it is one block per week.
- Sub-tabs: **Plan** (default), **Materials** (with count), **Activity**, **About**. Tabs are URL-addressable.

Plan tab: a two-pane layout.

- Left, about 440px: the outline.
  - One row per top-level unit (week, or month with weeks inside), showing its label, title, and either "3 of 5", a
    done check, its hour budget for unsplit week leaves, or "not planned".
  - Finished units start collapsed and the unit holding the current leaf starts open (same rule as `TrackPlan`
    today). Rows toggle open and closed.
  - Open units list their leaves: a status circle (done, current, open), "Day 9", the title truncated to one line, and
    "Today" or "Ready" on the right.
  - The selected leaf is highlighted with a white fill and a terracotta left edge.
  - Planning actions live here: **Split into days** on an unsplit week, **Expand** on an unplanned unit, and a dashed
    "N weeks left to plan · Plan everything" row at the bottom, with the same confirm-and-cost flow as today.
- Right: the selected leaf, preselected to the current leaf, and kept in the URL (for example `?day=<nodeId>`) so a
  link opens a specific day.
  - Kicker ("Week 2 · Day 9 · Today"), title, and the node summary.
  - Actions: **Open lesson** (primary, to the lesson page), **Mark complete**, and the time line
    ("40 min · 15 reading, 25 practice").
  - Two boxes side by side: **Read** (the leaf's read rows with Must or Should tags, chapter and minutes, the same
    data as `ReadRows`) and **Do** (practice rows, as `DoRows`).
  - A lesson card: when a lesson exists, "Lesson ready · written from N materials" and the first paragraph; when not,
    the existing generate prompt and button.
  - Completion follows today's rules exactly (`LeafView`): **Mark complete** appears only once the leaf's lesson
    exists; before that, the primary action is the generate button. Week leaves on week-granularity tracks show their
    budget and sessions logged, with **Log session** next to Mark complete (both, as today). Logging alone never
    completes a week.
  - "Written from N materials" counts the leaf's Read rows, matching `LeafView`'s existing copy.
  - Selecting a unit row that has no leaves selected shows that unit's summary, budget and materials, with its
    planning action.

Materials tab: the full `MaterialsList`.

About tab: the plan summary (`PlanSummaryCard` content) and the time-split card (`TimeSplitCard`, read-only as it is on
the track page today). Hours, days and split stay editable only on the Adjust page.

Activity tab (new): this track's check-ins, newest first, grouped by week: the leaf's title, when, and hours for week
sessions. Data already exists in `check_ins`; no schema change.

### Lesson page (`/tracks/[id]/nodes/[nodeId]`)

Same route as today. Two columns inside the shell:

- Main column: breadcrumb (Your tracks › track › Day 9), kicker, title (about 32px), the summary as a lede, then the
  lesson in a reading column about 680px wide, offset from the left so it doesn't hug the edge. Before a lesson
  exists, the generate prompt sits where the lesson goes.
- Right rail, 300px, full height with a light tint:
  - **Today · 40 min**: the leaf's Read and Do rows as a checklist, replacing the Read/Do table that sits above the
    lesson today. Each row keeps the table's detail in compact form: title, Must or Should tag, chapter or part, and
    minutes, plus the budget total in the heading. A "Read the lesson" item comes first. Whether ticking items is
    stored or only visual is the builder's call (see "Left to the builder").
  - **Mark Day 9 complete** (primary, full width) once the lesson exists, as today. Week leaves also get the
    log-session controls.
  - **Sources**: the lesson's `citations` as a plain list of links. No numbering or inline markers this round; lessons
    don't contain any and adding them is a lesson-writing change.
  - Previous and next leaf, as two small cards at the bottom.
  - **Rewrite this lesson**: the existing regenerate action.
- Main column, besides the lesson: YouTube embeds, the "Where these come from" note and the cost line, as `LeafView`
  shows them today. Before a lesson exists, the generate prompt takes the lesson's place and the rail still shows the
  checklist.

### Pages that only move into the shell

`/tracks/new`, `/tracks/[id]/adjust` and `/settings` get the new top bar and lose the 960px wrapper's narrowness where
their own layouts allow. Their content and behavior don't change.

## Decided by the designer

These were the designer's calls during the design conversation, not the user's. They're reasonable defaults; flag any
you disagree with.

- Explore and Journey show as disabled tabs with a "soon" badge rather than being hidden.
- Search is out of scope this round; its place in the top bar is reserved.
- Settings and the admin toggle move into the avatar menu.
- `/dashboard` stops being a separate page; it and `/` land on the Tracks home.
- The Activity sub-tab is in scope because it uses only existing data.
- The selected day lives in the URL.
- The lesson page keeps its current route rather than moving to `/days/9` as the mock's address bar shows.
- "Recently" on the home rail lists check-ins only, not plan edits.
- Completion rules don't change: Mark complete needs a written lesson, and week leaves get Log session and Mark
  complete side by side.
- The time-split card stays read-only on the track page.
- The lesson page's rail checklist replaces the Read/Do table instead of repeating it; sources are an unnumbered list.
- Every "today", "this week" and "this month" figure (done today, sessions left today, the activity squares, the
  heatmap, monthly stats) uses the same UTC day boundary as the streak (`lib/streak.ts`), so they always agree with
  each other. Weeks run Monday to Sunday.
- On week-granularity cards the activity squares are the seven calendar days of this week, filled on days with a
  logged session; on day-granularity cards they are the current plan week's study days.

## Left to the builder

- Whether the Tracks home's canonical URL is `/` or `/tracks`, and how the other redirects.
- Component structure: whether the outline reuses pieces of `PlanTree` or is a new component. `PlanTree` stays as is for
  the create and adjust flows.
- Exact responsive breakpoints and how the rails and panes stack.
- How "hours studied" is computed if summing planned minutes for completed days is awkward; an approximation is fine
  if it's labeled consistently.
- Whether the lesson page checklist stores ticks or is visual only (no new table without asking).
- Sort options beyond "Up next first".
- Loading and empty states, following the existing skeleton style (`skeleton-bar`) and the current empty-state copy.
