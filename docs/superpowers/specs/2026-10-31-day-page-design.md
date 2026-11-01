# Day page: tasks first, then a step-by-step lesson

**Status:** design, not built. Visual reference: `docs/mockups/day-page.html` (open it in a browser). The chosen
screens are "B1 · Tasks beside the lesson, before the lesson is written" and "B2 · The same page while you follow the
lesson". Screens A and C were options that weren't chosen.

## Summary

The lesson page (`/tracks/[id]/nodes/[nodeId]`) becomes the day page: everything assigned for one day (or one week
leaf) in one place. A fixed column on the left lists the day's tasks, each with what to do, how long it takes, and a
button that opens it. The right side holds the lesson in a centred reading column. Lessons change shape too: Pensieve
writes them as a walk-through of the day's tasks, with numbered step cards that link back to the task they're about.

## Why

The user opened a lesson on a wide window (about 2400 px) and found the middle of the page blank: the reading column
was pinned left at 680 px and the checklist rail sat at the far right edge. Asked how they use the page, they said a
day's page should have all the day's materials on it, and that they want to "see the assigned tasks first, then
generate the lesson and follow it." Today the tasks are squeezed into a narrow rail and the lesson is free prose that
mentions the tasks only in passing.

## Goals, non-goals, anti-goals

Goals:

1. Opening a day shows its assigned tasks first, in full: what to read (which chapter, which sections) or solve, how
   long, and a way to open each one.
2. The lesson reads as a guide through those tasks, step by step, and each step links to its task.
3. The page uses the window's width with no dead strip: the task column is fixed, the reading column is centred.

Non-goals (this round):

- Opening books or problems inside Pensieve. The materials live on other sites (Open Library, LeetCode and so on) that
  block embedding; the page links out to them.
- Rewriting existing lessons automatically. Lessons already written keep their text and render as they do today.
  "Rewrite this lesson" produces the new step style.
- Changing the plan page, the outline, or how materials and practice are assigned to a day.

Anti-goals (a failure even if it works):

- The page loses something the current lesson page can do: generate, rewrite, Mark complete, log a session on a week
  leaf, sources, previous and next day, the admin cost line, collapsed recall answers.
- A step card that points at the wrong task, or a step that silently disappears because the model named a task that
  doesn't exist.
- Ticks that look saved but vanish on reload.

## The page

Two columns below the top bar, as in B1/B2:

- **Left, the task column (about 360 px, full height, stays in place while the lesson scrolls).** Heading "Today's
  tasks" (or "This week's tasks" on a week leaf) with the day's total time.
  - One card per Read row: a Read tag, Must or Should, minutes; the material's short title and chapter; the note
    (which sections, what to focus on); an "Open chapter" button to the chapter's page or the material's URL (the
    current `rowHref`). Review rows say Review.
  - One card per practice row: its format tag (Problem, Recall, and so on), the item's group and difficulty when it
    has them, minutes; the item ("49. Group Anagrams") or the task text; the done-when line and source; "Open problem"
    and "Solution" buttons when the item has those URLs.
  - Once a lesson exists, a "Read today's lesson" card (minutes estimated from the lesson's length).
  - Each card has a tick circle. A progress line under the cards ("1 of 3 done").
  - At the bottom: on a week leaf, the log-a-session form; then "Mark Day 2 complete" (always available; it becomes the
    primary button once every task is ticked); then previous and next day links.
- **Right, the lesson.** Breadcrumb, kicker ("Week 1 · Day 2 · Today"), title, and the day's summary as the lede, all
  in a reading column of about 700 px centred in the space.
  - Before a lesson exists (B1): a card that says what the lesson will take the learner through, built from the
    tasks (one line per task, in order), with "Write today's lesson" and a note on time and that it uses their key.
    Generation errors and the Settings link show here as they do today.
  - After (B2): the lesson. Step cards render inline. Under the lesson: Sources, "Rewrite this lesson", and the admin
    cost line, as today, and "Where these come from".
- **Below 900 px:** one column, tasks first, then the lesson; the task column no longer stays fixed.
- **Days with no assigned reading or practice** (plans saved before materials were assigned; the user's answer): the
  task column says no tasks were assigned to this day and keeps the "Read today's lesson" card once there is a
  lesson, the log-a-session form on week leaves, Mark complete and the day links. The lesson is written the old way,
  as prose from the track's sources with no step cards, and the B1 card has no task list to preview.

## Step cards

A step is a numbered card inside the lesson: "STEP 1 · Read chapter 2 up to the worked example. Copy the latency table
onto paper. · 25 min", with the task's name as a link to the same place its task card's button goes. A step carries a
tick that is the same tick as its task card: ticking either ticks both.

- The lesson writer is told the day's tasks with a short identifier each, and writes each step as a marked block that
  names one task by its identifier, the way recall answers already use a fenced block with the info string `answers`.
- Identifiers come from the task's content, not its position: a Read task from its source and chapter, a practice
  task from its source and item (or its text when it has no item). A plan revision deletes and re-inserts a day's
  material and practice rows, so positional names (R1, P2) or row ids would point steps at the wrong task afterwards.
  The page and the generator build the day's tasks from one shared list, so every identifier the writer sees is a
  task the page shows.
- Several steps may point at the same task (read the first half, then the second). A task with no step is fine.
- If a step names a task that doesn't exist, the step still shows as a card, without a link or tick. It is never
  dropped.
- If any step names a task the day no longer has (the plan was revised after the lesson was written), a note above
  the lesson says the day's tasks changed since it was written, next to "Rewrite this lesson".
- Minutes on a step are the writer's estimate and are only shown, never added up.
- Prose, tables, code and recall answers between steps render as they do today.
- Week leaves: the same, with the lesson organised as parts the learner picks up over the week.

## Ticks

Ticks on a day are remembered in this browser for that day and survive a reload. They don't sync between devices and
don't count as progress anywhere else; only Mark complete and logged sessions do. (Designer's call; see below.)

- Each step has its own tick. A task that has steps is ticked once all its steps are; ticking the task card ticks all
  its steps, and unticking it unticks them. A task with no steps is ticked on its card.
- "1 of 3 done" counts tasks, not steps.
- Ticks are stored under the same content identifiers as the steps, so they survive a plan revision for tasks that
  are still there.

## Decided by the designer

- Ticks are kept in the browser, per day, not in the database: the user asked for the layout and the step lesson, not
  progress tracking, and per-device ticks need no schema change.
- "Read today's lesson" gets minutes from the lesson's word count at about 200 words a minute, rounded to 5.
- Mark complete stays available before every task is ticked: the learner may skip a Should reading.
- Sources and "Rewrite this lesson" move under the lesson, since the rail they lived in is gone.
- Step identifiers come from content, and a revised day shows unlinked steps plus a "tasks changed" note rather than
  storing a copy of the task list with the lesson (no schema change).
- Per-step ticks, with a task's tick following its steps (reading in two halves is two ticks, not one).

## Left to the builder

- The exact marker syntax for a step and the task identifiers, as long as the rules above hold.
- How "what the lesson will take you through" is phrased from the task list.
- Spacing and type sizes, following `docs/mockups/day-page.html`.
