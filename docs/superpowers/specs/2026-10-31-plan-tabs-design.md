# Plan page tabs: the plan at a glance, Materials and Activity

Mock: `docs/mockups/plan-tabs.html`. The chosen options are P1, M1, and A1 with A2's grid in place of A1's right column.

## Why

The track page has four tabs: Plan, Materials, Activity and About.

- **About** holds two things the learner wants while looking at the plan: the summary and how the hours split. Hiding
  them behind a tab means nobody sees them.
- **Materials and Activity** are a single column. Materials runs lines the full width of the page, and Activity is a
  narrow list beside an empty page.

## Goals

- The About tab is gone. Its summary and time split become a small, brief band at the top of the Plan tab.
- Materials and Activity each get a second column on the right, so the page is used without long lines or empty space.
- The Activity tab's right column is a calendar of real dates since the track started, filled on the days the learner
  studied.

## Non-goals

- **No study schedule.** Plan days are not tied to dates, and the learner doesn't pick weekdays. The grid shows only
  the past and today. A schedule, where future days land on dates, is separate work for later.
- No change to how the split is chosen or edited. Editing stays in Adjust plan.
- No change to the materials list used while drafting a new track.

## Anti-goals

- The band must not grow into a card that pushes the outline out of view. It is about 80 px tall on a desktop width.
- The grid must not suggest dates the plan doesn't have, such as future days or weekday names on plan days.

## Plan tab: the band (P1)

A band sits between the tabs and the outline/pane grid, across the full width. It has a light card background and a
small shadow, like the mock.

**Left: "The plan".** The track's summary, cut to two lines. "More" shows the whole summary in place, and "Less" folds
it again. A summary short enough for two lines has no "More". The summary is the stored one, or the generated fallback
the About tab uses today.

**Right: "How the N h split".**
- **The heading.** N is the plan's total hours, the figure the header shows as "of N h".
- **The bar.** A thin stacked bar: reading first, then each practice format. The shares and labels are the same as
  the About tab's card shows today, from `track.split`. The colours are the shades that card already uses.
- **The legend.** One line under the bar, wrapping if needed: a swatch, a short label, and the percent.
- **Whose call.** Beside the heading: "The plan's call", or "Your call" when the learner set it. These are the words the split card in Adjust plan
  already uses.
- **Why.** "Why" opens the split's reason in a small popover. When there is no reason, there is no "Why".
- **Old splits.** A split from before practice formats existed shows reading and its one practice label.

**Edge cases.**
- **No split** (plans saved before splits existed): the right side is left out, and the summary takes the full width.
- **Narrow screens** (below 900 px): the two sides stack, summary first.

The About tab, its `?tab=about` value and its content go away. An old `?tab=about` link opens the Plan tab, as an
unknown tab does today. The time split's editing controls are untouched; only the read-only About card goes.

## Materials tab (M1)

**Layout.** Two columns:
- **Left:** the materials list, filling the width up to the right column, with its groups as today. On a wide screen its rows flow into two or three columns.
- **Right:** a 320 px column that stays in place while the list scrolls.

**The right column has three panels.**
1. **"N materials".** Reading hours and practice hours as two large figures, from the same totals the list's header
   line uses today. Under them, one row per kind with a count and a small bar of its share of the materials.
2. **"Checked".** The verification line the list shows today, such as "All 13 opened and checked", with the sentence
   that sizes are for the part the plan uses.
3. **"Jump to".** One link per group in the list (backbone, each kind, practice), each scrolling to its group.

The list's own header line, with its totals and verification count, moves into the right column. It is not shown twice.

This tab shows the whole list, with no "Show all" limit, so every jump link has a group to scroll to. The limit stays
where the list is used while drafting a track. *(My call.)*

**Narrow screens** (below 900 px): one column, with the right column's panels above the list. "Jump to" is left out.

## Activity tab (A1 with A2's grid)

**Layout.** Two columns:
- **Left (filling the width up to the right column):** check-ins grouped by calendar week as today, newest first, as cards that sit side by side on a wide screen. Each week heading gets
  the week's total on the right, such as "2 days · 2.5 h" or "3 sessions · 4 h". Hours count as the header's studied
  hours do: a finished day counts its share of the week's hours, and a session counts its logged hours. *(My calls:)*
  - "days" counts finished days, meaning check-ins with no hours, and "sessions" counts logged sessions.
  - A week with both says both, such as "1 day · 2 sessions · 4 h".
  - A part that is zero is left out.
- **Right (320 px, stays in place):** one panel, "Your study days".

**The grid.**
- **Shape.** One row per calendar week, Monday to Sunday, with headers M T W T F S S. The first row is the week the
  track was created. The last row is this week. Each row is labelled with its Monday's date, such as "26 Oct".
- **Filled cells.** A day with at least one check-in on the track is filled in the done colour. Hovering or focusing
  it names what was done, such as "Fri 30 Oct · The Senior Loop and Scaling Basics", one line per check-in.
- **Other cells.**
  - Today is outlined.
  - Days before the track was created, and days after today, are blank (no cell colour).
  - Every other past day is the empty colour.
- **Length.** At most the last 12 weeks are shown, newest at the bottom. Older weeks are still in the list on the left.
- **Days.** Days are UTC days, the same as the streak and the rest of the stats.
- **Under the grid:**
  - hours studied on this track, the same figure as the header;
  - the number of dates studied: the distinct dates filled in the whole grid's range, counted since the track started,
    such as "on 9 days". This is the same on day-based and week-based tracks. *(My call. It matches the grid, and it
    doesn't repeat the header's "days done".)*
  - the header's estimated finish date, worded as an estimate, such as "Estimated finish: 26 Dec". It's left out when
    the plan is finished. *(My call. It reuses `finishDate`, the planned pace counted from today, and makes no new
    projection from real pace.)*

**No check-ins yet.** The left column shows today's empty message. The grid still shows, with today outlined.

**Narrow screens:** the grid panel goes above the list.

## Left to the builder

- Component boundaries. For example, whether `MaterialsList` takes a prop to hide its header line, or the header is
  pulled out.
- Exact spacing, sizes and colours within the existing tokens; the mock is the guide.
- How "More" and "Why" are built (a disclosure button and the existing popover), as long as they work from the keyboard.
- Tests in the project's style: `renderToStaticMarkup`, and pure helpers for the grid and the week totals.

## Calls I made (not yet confirmed)

- The streak is left out of the Activity tab: it covers all tracks, not this one.
- The grid shows at most 12 weeks, the same as the home page's grid.
- The weekly total on each heading, and how it counts days and sessions.
- The Materials tab shows the whole list, with no "Show all".
- Under the grid: the number of dates studied, and the header's finish date as an estimate.
- On narrow screens, the Materials summary goes above the list and the jump links are dropped.
