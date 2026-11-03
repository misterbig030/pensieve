# Track page in three columns: design

Mock: `docs/mockups/plan-three-column.html`, version **T4** (the last one on the page).
Builds on: `docs/superpowers/specs/2026-10-31-plan-tabs-design.md` (the summary band, study calendar and materials panels it added).

## Why

The track page had three tabs: Plan, Materials and Activity. Materials and Activity each held one thing you want to see while you study: what to read, and whether you've kept at it. Behind tabs, you have to leave the plan to see either.

The user picked T4. It puts everything on one page. On the left are the outline and the pane. On the right, the study-days grid sits in the top corner and the materials list runs down the side. The materials the selected week uses are lit up, so the pane and the list point at the same things.

## Goals

- One track page with no tabs. The left part holds the header, strip, summary band, outline and pane. The right column holds the study-days card and the materials column.
- The study-days card sits in the top-right corner, level with the track title. The title, stats, day strip and summary band stop short of it.
- The materials column starts under the card, beside the outline and pane. It stays in view while the outline scrolls.
- The materials column shows which materials the selected unit uses, and where the rest come in the plan.

## Non-goals

- No change to the outline, the pane, planning, the header's stats or the summary band's content.
- No new data. Everything comes from the plan tree, the materials and the check-ins the page already loads.
- No editing materials here. Adding or removing them stays where it is today.

## Anti-goals

- The pane must not get so narrow that its lesson card and buttons wrap badly at 1280 px.
- The materials column must not push the outline below the fold on a laptop screen.
- The page must not show the same number twice: hours studied and the finish date are already in the header.

## Removed

- The tab bar, and the Materials and Activity tabs. `?tab=` is ignored, so old links such as `?tab=activity` open the track page.
- The check-in list, grouped by week with week totals, goes with the Activity tab. The user chose this. The grid's hover and focus labels still name what was done each day.
- Code that only those tabs used goes too, with its tests. That includes `TrackTabs`, `MaterialsTab`, `ActivityTab` and MaterialsList's `bare` mode if nothing else uses it. Keep any helper that something else still imports.

## Layout

- **Page:** two columns, `minmax(0,1fr)` and 340 px, with a 24 px gap.
- **Row 1, left:** the crumb, header, day strip and summary band (`PlanGlance`), stacked as today, with no tab bar.
- **Row 1, right:** the study-days card. It starts level with the crumb and stretches to the bottom of the band.
- **Row 2, left:** the outline and pane, as today. The outline narrows to about 300 px so the pane keeps at least about 470 px down to 1200 px wide. *Builder's call:* the exact outline widths above that.
- **Row 2, right:** the materials column, `sticky` about 20 px from the top. It is at most the viewport height minus 40 px, and its list scrolls inside it.
- **Below 1200 px:** one column. Order: header, strip, band, outline and pane, then the study-days card, then the materials column, which is not sticky and doesn't scroll on its own. *My call: at 1100 px the pane would be about 300 px.* Below 900 px the outline and pane stack, as today.

## Study-days card

- **Caption:** "Your study days".
- **Grid:** it lies sideways. The last 12 weeks run left to right as columns, oldest first. Monday to Sunday run top to bottom as rows.
  - The rows are labelled M, W and F. Month names ("Aug", "Sep") sit over the column where each month's first Monday falls.
  - It always shows 12 columns. Weeks and days before the track was created are blank. *My call: a fixed shape, so a new track doesn't show one lonely column.*
  - Squares are about 18 px with 4 px gaps, as in the mock.
- **Day states:** as today's calendar. Studied is filled green, a day with nothing is grey, and days before the track or after today are blank. Today has a ring.
- **Hover and focus:** studied days take keyboard focus and name the date and what was done, as today.
- **Under the grid,** one line: "Studied on N days". There is no hours or finish figure, because the header has both. *My call, from the anti-goal.* It differs from the mock, which repeated them.
  - N counts every distinct date studied on the track, as today's Activity tab does. For a track older than 12 weeks it reads "Studied on N days since you started", so it isn't taken for a count of the squares. *My call.*
- **No "Activity" link,** because the tab is gone.
- **Weeks and days are UTC,** as the streak and today's calendar use.

## Materials column

- **Header:**
  - "Materials" and the count.
  - One totals line: "≈ 17 h of reading · 22 h of practice". It adds "· N with no size" when some materials have no size.
  - The checked line, shortened, such as "all checked".
- **Switch:** two segments, the selected unit's short label (such as "Week 1" or "Day 3") and "All".
  - It defaults to the selected unit.
  - If the selected unit uses no materials, it defaults to All, and the unit segment says so on hover.
  - The choice doesn't survive a reload. Picking another unit in the outline puts the switch back on that unit, so the column always follows the pane. *My call.*
- **Places:**
  - A material's "use" is any unit that references it.
  - A use is named by the unit at the selected unit's level that holds it, written the way the pane already writes a full place (`fullLabelOf`, so month plans read "Month 2 · Week 1"). If the plan isn't detailed that far yet, the heading that reserves the material names it.
  - "from Week 3" means its uses on that side of the selected unit fall in more than one place. Otherwise the single place is named.
  - *My call.*
- **Unit view:**
  - **"Used in Week 1":** every material the selected unit or anything inside it references. That counts headings' `covers` and `practiceCovers`, and leaves' `materials` and `practice` with a non-null id. They are listed in plan order, are highlighted, and show which part is used where the refs say: chapters ("ch. 1–2") or practice items. *Builder's call:* reuse the pane's existing chapter and item formatting.
  - **"Later in the plan":** materials not used in the selected unit but used after it, dimmed. Each names its next use after the selected unit, even if it was also used before. Those the plan doesn't use at all come last and say "Not in the plan yet".
  - **"Earlier":** materials used only in units before the selected one, dimmed, each with the last place it was used. *My call.*
  - **Selecting a day:** "the selected unit" is that day. Another day of the same week is named as that day (for example "Week 1 · Day 5").
- **All view:** grouped by kind as the materials list is today (Backbone, Books, …). The selected unit's materials are highlighted in place.
- **Rows:**
  - A row is one line: an icon, the title (truncated), and under it the kind, size and the part or place.
  - Clicking a row opens it in place to show the author and year, the description, the size, and an "Open" link to the material. Clicking again closes it. One row can be open at a time.
- **No truncation:** every material is listed, with no "Show all".
- **No materials:** the column shows "This track has no materials."

## Out of scope, noted

- **Narrow screens:** the materials column drops under the plan. That is good enough below 1200 px. A drawer or sheet can come later.
- **Old links:** nothing in the app links to `?tab=materials` or `?tab=activity` (checked). Saved bookmarks open the track page.
