# Track Page in Three Columns: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The track page has no tabs. The study-days grid sits in the top-right corner, and a materials column below it follows the unit selected in the outline.

**Architecture:**
- A pure helper (`lib/materialUses.ts`) works out, on the server, which materials the selected unit uses and where the rest come in the plan.
- `page.tsx` becomes a two-column grid:
  - left: header, strip, band, then outline and pane;
  - right: `StudyDaysCard`, then the client `MaterialsColumn`, keyed by the selected unit so its switch resets when the selection changes.
- The tabs and their components are deleted.

**Tech Stack:** Next.js 16 App Router (server page, "use client" leaves), React 19, Tailwind 4, Vitest (node env, `renderToStaticMarkup`, effects don't run).

**Spec:** `docs/superpowers/specs/2026-10-31-plan-three-column-design.md` (mock: `docs/mockups/plan-three-column.html`, version T4)

## Global Constraints

- **Grid:** the page is `minmax(0,1fr)` and 340 px with a 24 px gap. It drops to one column below 1200 px.
- **Card copy:**
  - The caption is "Your study days".
  - The line under the grid is "Studied on N days", or "Studied on N days since you started" when the track is older than the 12 weeks shown.
  - The card has no hours, no finish date, and no "Activity" link.
- **Grid shape:** always 12 week columns, oldest left. Rows run Monday to Sunday and are labelled M, W and F. Squares are about 18 px with 4 px gaps. Days are UTC.
- **Materials copy:**
  - The header reads "Materials" with the count.
  - The totals line reads "≈ 17 h of reading · 22 h of practice", with "· N with no size" added when some materials have none.
  - The checked line is short ("all checked").
  - The switch shows the unit's short label and "All".
  - The groups are "Used in {label}", "Later in the plan" and "Earlier". A material with no use says "Not in the plan yet".
  - A track with no materials shows "This track has no materials."
- **Materials column behaviour:**
  - On wide screens it is `sticky` about 20 px from the top, at most `100dvh - 40px` tall, and scrolls inside.
  - Below 1200 px it is static and doesn't scroll on its own.
- **Avoid apostrophes in `//` comments near Tailwind class strings.** The class scanner skipped a class after one.

## Review Focus

1. **A material used before and after the selected unit but not in it** goes under "Later in the plan" and names its next use after the unit, not its first use. Test: Task 1.
2. **With a day selected,** another day of the same week is named "Week 1 · Day 5". In a month plan, a week is named "Month 2 · Week 1". Test: Task 1.
3. **A heading above the selected unit that reserves a material** (`covers` on its month or week) doesn't count as "used in" the selected unit. Test: Task 1.
4. **Track age:**
   - A track created this week still shows 12 columns, with the earlier ones blank.
   - A track older than 12 weeks says "since you started".
   - Test: Task 2.
5. **A selected unit that uses no materials:** the column opens on All, and the unit segment says why on hover. Test: Task 4.

---

### Task 1: Where each material is used

**Files:**
- Create: `lib/materialUses.ts`
- Test: `lib/materialUses.test.ts`

**Interfaces:**
- Consumes:
  - `walk`, `findNode` and `labelOf` from `lib/planTree.ts`;
  - `PlanNode`, which has `covers`, `materials`, `practiceCovers`, `practice`, `start`, `end`, `level` and `children`;
  - `Material` from `lib/schemas/material.ts`.
- Produces:
  ```ts
  export function placeLabel(root: PlanNode, node: PlanNode): string;
  export interface UsedMaterial { material: Material; part: string }
  export interface PlacedMaterial { material: Material; place: string }
  export interface MaterialPlacement { used: UsedMaterial[]; later: PlacedMaterial[]; earlier: PlacedMaterial[]; unused: Material[] }
  export function materialPlacement(root: PlanNode, materials: Material[], selected: PlanNode): MaterialPlacement;
  ```

**Rules the tests pin:**
- **Uses:** a use is any node other than the root whose `covers`, `materials`, `practiceCovers` or `practice` (with a non-null `id`) names the material.
- **Used in the selected unit:** the use's node is the selected node or a descendant of it. A use on an ancestor of the selected node is neither used, earlier nor later. Ignore it.
- **Before and after:** a use is before when `node.end < selected.start`, and after when `node.start > selected.end`.
- **Place:** the use's node is named by its ancestor-or-self at the selected node's level. If the use's node is shallower than that level, it names itself. The text comes from `placeLabel`.
- **`placeLabel`:** `labelOf` for each node on the path from below the root to the node, joined with " · ". Examples: "Week 3", "Week 1 · Day 5", "Month 2 · Week 1".
- **Used:** in order of first use. `part` lists:
  - the chapters from `materials` and `covers` refs, as "ch. 1–2" or "ch. 1–2, 5";
  - then practice item runs from `itemFrom`/`itemTo`, as "items 3–8";
  - each joined with " · ". It is an empty string when the refs carry neither.
- **Later:** a material not used in the selected unit that has at least one use after it. Its place is the first place after the unit. Prefix "from " when its after-uses fall in more than one distinct place. Sort by that first after-use's `start`.
- **Earlier:** a material whose uses are all before the selected unit. Its place is the last place it was used. Sort most recent first.
- **Unused:** materials with no use, in the order given.

- [ ] **Step 1: Write the failing tests** in `lib/materialUses.test.ts`. Build small trees by hand: a week plan with two weeks of days, and a month plan with weeks. Set `start` and `end` the way `layout` would, or build the tree with the planTree helpers the existing tests use. Tests:
  - `placeLabel names a day by its week` → `"Week 1 · Day 5"`. Also `names a week in a month plan` → `"Month 2 · Week 1"`.
  - `lists what the selected week uses, with its chapters and items` → `used` has the backbone with `part` `"ch. 1–2"` and NeetCode with `"items 3–8"`.
  - `names the next use after the selected unit for a material used before and after it` → it is under `later` with place `"Week 3"`, not `"Week 1"`.
  - `says from when later uses fall in more than one place` → `"from Week 3"`.
  - `puts a material used only before under earlier, with its last place`.
  - `with a day selected, names another day of its week` → place `"Week 1 · Day 5"`.
  - `ignores a reservation on a heading above the selected unit` → a month's `covers` naming a material doesn't put it in `used` when a week inside is selected.
  - `ignores practice rows with no source` → a `practice` ref with `id: null` adds nothing.
  - `lists materials the plan does not use as unused`.
- [ ] **Step 2: Run them.** `npx vitest run lib/materialUses.test.ts`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `placeLabel` and `materialPlacement`** in `lib/materialUses.ts`, following the rules above. Collect uses in one `walk`, then sort them into groups.
- [ ] **Step 4: Run them again.** `npx vitest run lib/materialUses.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add lib/materialUses.ts lib/materialUses.test.ts
  git commit -m "feat(materials): where each material is used, around the selected unit"
  ```

### Task 2: A fixed 12-week calendar and the card

**Files:**
- Modify: `lib/activity.ts` (`studyCalendar`; add `monthLabels`)
- Modify: `app/tracks/[id]/StudyCalendar.tsx` (sideways grid)
- Create: `app/tracks/[id]/StudyDaysCard.tsx`
- Test: `lib/activity.test.ts`, `app/tracks/[id]/StudyDaysCard.test.ts`

**Interfaces:**
- Consumes: `CalendarWeek`, `CalendarDay` and `studyDates` from `lib/activity.ts`.
- Produces:
  ```ts
  // studyCalendar now always returns `weeks` weeks ending this week; days before `start` are "before".
  export function studyCalendar(rows: { completedAt: Date; nodeTitle: string }[], start: Date, today: Date, weeks = 12): CalendarWeek[];
  /** Column indexes that start a new month, with its short name: the first column, and each column whose Monday's month differs from the column before. */
  export function monthLabels(weeks: CalendarWeek[]): { index: number; label: string }[];
  export function StudyDaysCard(props: { rows: { completedAt: Date; nodeTitle: string }[]; createdAt: Date; today: Date }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests.**
  - **In `lib/activity.test.ts`, change the existing `studyCalendar` cases to the fixed shape:**
    - `always shows 12 weeks, blank before the track` → a track created on Thu 29 Oct 2026 with today Sat 31 Oct gives 12 weeks, the first `monday` is 10 Aug, and every day before 29 Oct is `"before"`.
    - Keep the cases for "older than 12 weeks" and "two check-ins on one date".
  - **Add `monthLabels`:** `names the first column and each new month` → `[{index:0,label:"Aug"},{index:4,label:"Sep"},{index:8,label:"Oct"}]` for the weeks of 10 Aug to 26 Oct.
  - **In `StudyDaysCard.test.ts`:**
    - `shows the caption, 12 columns of 7 days and the days studied` → contains "Your study days" and 84 `data-state=` cells, and reads "Studied on 2 days".
    - `says since you started for a track older than the grid` → created 1 Jan 2026 reads "Studied on 2 days since you started".
    - `shows no hours, finish or Activity link` → no " h", "finish" or "Activity".
    - `lets the keyboard reach a studied date` → the studied cell has `tabindex="0"`, `role="img"` and `aria-label="Fri 30 Oct · …"`, carried over from the current calendar.
- [ ] **Step 2: Run them.** `npx vitest run lib/activity.test.ts "app/tracks/[id]/StudyDaysCard.test.ts"`. Expected: FAIL on the shape, `monthLabels`, and the missing card.
- [ ] **Step 3: Implement.**
  - **`studyCalendar`:** `first = last - (weeks-1) weeks`. The state rules are unchanged.
  - **`monthLabels`:** months come from `toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })`.
  - **`StudyCalendar`:** it now draws weeks as columns. The grid is `grid-cols-[18px_repeat(12,18px)]`, with a 14 px month row above seven 18 px rows and `gap-1`. Row labels M, W and F go in rows 1, 3 and 5. Month labels span to the next label. Keep the cells' `data-state`, `data-today`, `title`, focus and ring.
  - **`StudyDaysCard`:** the caption, `StudyCalendar`, then the studied line. It is "since you started" when `createdAt` is before the first column's Monday.
- [ ] **Step 4: Run them again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add lib/activity.ts lib/activity.test.ts "app/tracks/[id]/StudyCalendar.tsx" "app/tracks/[id]/StudyDaysCard.tsx" "app/tracks/[id]/StudyDaysCard.test.ts"
  git commit -m "feat(activity): a 12-week study-days card that lies on its side"
  ```

### Task 3: Materials column, pure parts

**Files:**
- Create: `app/tracks/[id]/materialsColumn.ts`
- Modify: `components/pensieve/MaterialsList.tsx` (export `KIND_ICON`, `groupLabel` and `byline`; nothing else changes yet)
- Test: `app/tracks/[id]/materialsColumn.test.ts`

**Interfaces:**
- Consumes: `materialTotals`, `materialGroups` and `approxDuration`.
- Produces:
  ```ts
  /** "≈ 17 h of reading · 22 h of practice", with " · 2 with no size" when some have none; one part when the other is zero. */
  export function columnTotals(materials: Material[]): string;
  /** "all checked", "11 checked · 2 yours" or "2 yours". */
  export function checkedShort(materials: Material[]): string;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `columnTotals sums reading and practice` → `"≈ 17 h of reading · 22 h of practice"`, built from fixture minutes that add up to those totals.
  - `columnTotals names materials with no size` → the line ends with `"· 1 with no size"`.
  - `columnTotals leaves out a zero part` → `"≈ 5 h of reading"`.
  - `checkedShort` → `"all checked"`, `"11 checked · 2 yours"`, `"2 yours"`.
- [ ] **Step 2: Run them.** `npx vitest run "app/tracks/[id]/materialsColumn.test.ts"`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement both functions,** and export the three helpers from `MaterialsList.tsx`.
- [ ] **Step 4: Run them again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add "app/tracks/[id]/materialsColumn.ts" "app/tracks/[id]/materialsColumn.test.ts" components/pensieve/MaterialsList.tsx
  git commit -m "feat(materials): the materials column's totals and checked lines"
  ```

### Task 4: The materials column

**Files:**
- Create: `app/tracks/[id]/MaterialsColumn.tsx` (`"use client"`)
- Test: `app/tracks/[id]/MaterialsColumn.test.ts`

**Interfaces:**
- Consumes:
  - `MaterialPlacement` (Task 1);
  - `columnTotals` and `checkedShort` (Task 3);
  - `KIND_ICON`, `groupLabel`, `byline` and `materialGroups` from `MaterialsList.tsx`.
- Produces:
  ```ts
  export function MaterialsColumn(props: { materials: Material[]; unitLabel: string; placement: MaterialPlacement }): JSX.Element;
  ```

**Behaviour:**
- **Switch:** `useState<"unit" | "all">`. It starts on `"unit"` when `placement.used.length > 0`, else on `"all"`. When `used` is empty, the unit segment is disabled with `title="Nothing in {unitLabel} uses a material yet"`.
- **Unit view:**
  - "Used in {unitLabel}": highlighted rows (`bg-accent-100` with a 2 px primary inset on the left). Each row's second line is the kind, then the part.
  - "Later in the plan" and "Earlier": dimmed rows. Each row's second line is the kind, then the place.
  - The unused materials come last in "Later in the plan", reading "Not in the plan yet".
  - A group with no rows is left out.
- **All view:** grouped by `groupLabel` in `materialGroups` order. Used materials are highlighted in place.
- **Row:**
  - It is a `button` with `aria-expanded`. Its first line is the title, truncated. Its second line is small text: the kind, the size (`approxDuration` of `minutes`, else `practiceTag`), and the part or place.
  - Clicking it opens it in place to show `byline`, `why`, and an "Open" link (`target="_blank"`, `rel="noreferrer"`).
  - One row is open at a time.
- **Header:** "Materials" and the count, `columnTotals`, `checkedShort`, then the switch.
- **No materials:** "This track has no materials."

- [ ] **Step 1: Write the failing tests** with `renderToStaticMarkup`, using a hand-made `MaterialPlacement`.
  - `opens on the selected unit with its materials first` → contains "Used in Week 1", the used title, its part "ch. 1–2", and "Later in the plan" with "from Week 3".
  - `opens on All when the unit uses nothing, and says why` → no "Used in", contains the group labels, and contains `title="Nothing in Week 2 uses a material yet"` on a `disabled` segment.
  - `marks materials the plan does not use` → "Not in the plan yet".
  - `shows totals and the checked line` → contains `columnTotals(...)` and "all checked".
  - `lists every material, with no Show all` → 15 materials give 15 row buttons and no "Show all".
  - `says when the track has no materials` → "This track has no materials."
- [ ] **Step 2: Run them.** `npx vitest run "app/tracks/[id]/MaterialsColumn.test.ts"`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `MaterialsColumn`** following the behaviour above, styled like the T4 mock's rail. The panel uses `elev-sm rounded-[18px] bg-neutral-100`, and the list area is `overflow-y-auto` inside a flex column.
- [ ] **Step 4: Run them again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add "app/tracks/[id]/MaterialsColumn.tsx" "app/tracks/[id]/MaterialsColumn.test.ts"
  git commit -m "feat(materials): a materials column that follows the selected unit"
  ```

### Task 5: The page in three columns, with no tabs

**Files:**
- Modify: `app/tracks/[id]/page.tsx`
- Delete:
  - `app/tracks/[id]/TrackTabs.tsx`;
  - `app/tracks/[id]/MaterialsTab.tsx` and its test;
  - `app/tracks/[id]/ActivityTab.tsx` and its test.
- Modify: `components/pensieve/MaterialsList.tsx`, to drop the `bare` prop and its branches, which no caller uses any more.
- Modify: `lib/activity.ts`, to drop `weekTotal` and `byWeek` if nothing imports them after the deletions. Also drop their tests.

**Interfaces:**
- Consumes: `materialPlacement` and `placeLabel` (Task 1), `StudyDaysCard` (Task 2), and `MaterialsColumn` (Task 4).

**Layout (`page.tsx`):**
- **Outer grid:** `grid grid-cols-[minmax(0,1fr)_340px] gap-x-6 gap-y-[18px] max-[1199px]:grid-cols-1`.
- **Row 1, left:** the crumb, `TrackHeader` and `DayStrip` as today, with no `TrackTabs`, then `PlanGlance`.
- **Row 1, right:** `<StudyDaysCard rows={checkInRows} createdAt={track.createdAt} today={today} />`, with `max-[1199px]:order-3`. The card stretches to the row's height.
- **Row 2, left:** the outline and pane grid as today, with the outline at `grid-cols-[300px_minmax(0,1fr)]` up to 1440 px and 360 px above.
- **Row 2, right:** `<MaterialsColumn key={selected.id} materials={materials} unitLabel={placeLabel(root, selected)} placement={materialPlacement(root, materials, selected)} />`.
  - It sits inside an aside with `sticky top-5 max-h-[calc(100dvh-40px)] self-start max-[1199px]:static max-[1199px]:order-4 max-[1199px]:max-h-none`.
- **Below 900 px:** the outline and pane stack as today.
- **Clean-up:** remove `active`, `tab` and the `ActivityTab`/`MaterialsTab` branches. `?tab=` is no longer read.
- **Band (builder's call):** if the band's 470 px split column crowds the summary in the narrower left part, it may drop to 420 px.

- [ ] **Step 1: Confirm nothing else imports the files being deleted.** `grep -rn "TrackTabs\|MaterialsTab\|ActivityTab\|weekTotal\|byWeek\|bare" app components lib`. Expected: only the files being deleted or changed here.
- [ ] **Step 2: Make the changes above.**
- [ ] **Step 3: Run the suite, type-check and lint.** `npm test`, `npx tsc --noEmit` and `npm run lint`. Expected: all pass, with the deleted tabs' tests gone.
- [ ] **Step 4: Live check (read only),** on localhost:3001 in a fresh Chrome tab. **The database is production: click nothing that writes.**
  - The track page shows no tabs, the card top right level with the title, and the column under it.
  - Selecting another week in the outline moves "Used in" to that week.
  - "All" switches the view, and a row opens and closes.
  - `?tab=activity` opens the page.
  - There are no console errors.
  - Check every new arbitrary Tailwind class is in the dev CSS.
- [ ] **Step 5: Commit.**
  ```bash
  git add -A "app/tracks/[id]" components/pensieve/MaterialsList.tsx lib/activity.ts lib/activity.test.ts
  git commit -m "feat(track): one page in three columns; no Materials or Activity tabs"
  ```

### Task 6: Ship

- [ ] **Step 1: Check the PR is still open.** `gh pr view 32 --json state`. Expected: `"OPEN"`. If it's merged, cut a new branch from main instead.
- [ ] **Step 2: Push, and add the change to the PR description.**
