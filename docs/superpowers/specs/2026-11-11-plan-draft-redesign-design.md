# Plan draft page redesign

**Status:** approved by the owner on 2026-11-12. The owner is on a feature freeze until January and decides when the build runs.

**Mockup:** [`docs/mockups/plan-draft-redesign.html`](../../mockups/plan-draft-redesign.html). The "Decided" box at the top lists what was chosen. The screens to build from are **B1, B2, E1, E1b, F1, F2, G1, H1–H3 and I1–I3**. A shows today's page, C shows today's plan page for reference, and D, E2 and E3 were not chosen. Most of the mock's example plan is an import (`weekly-plan.md`). The import-only touches ("From your file", "no link", the import notes in the chat) belong to the import design, not this one.

## Why

The draft page (`components/pensieve/PlanWorkspace.tsx`) is where a learner reads a plan before saving it. It's used to make a new plan (`app/tracks/new/NewTrackForm.tsx`) and to change one already under way (`app/tracks/[id]/adjust/AdjustPlan.tsx`). Today the page stacks several things above the plan: a summary card, a time card and the materials list. The plan itself is a tree of cards, and the chat is a full-height rail on the right. It looks like a different product from the plan page (`app/tracks/[id]/`), where the learner spends the rest of the track.

The owner picked layout B because **it fits the plan page's style**. It uses the same stat strip, materials column and type, so drafting a plan and then using it feel like one place. The owner kept B's open-in-place week list rather than copying the plan page's outline-beside-a-pane (D). The plan page needs three columns because a day's content fills the middle one. A draft is read week by week, so one list is enough.

## Goals

- The draft page looks like it belongs with the plan page: the same strip, materials column, cards and type.
- The plan is the main thing on the page. Time controls, the summary and the materials take less room than they do today.
- Everything the page can do today it still does, in the new layout: draft, research, chat changes with Undo, splitting weeks into days, planning headings in detail, re-drafting for new hours, Adjust's locks, out-of-credits and error states, and the leave guard.

## Non-goals

- No new plan data. The redesign uses only what `PlanNode` and the materials already hold. There is **no "Done when" / exit-check box** (B's original mock had one, and the owner dropped it).
- No change to drafting, research, allocation, the chat's abilities or what Confirm saves (apart from the summary note below).
- The plan page itself doesn't change.
- **No check line and no "Undo split" after a split** (owner's decision). B2 in the mock shows a green line, "Every item Week 1 names is in a day…", with an Undo split button. Neither exists today, and both would be new logic, so they aren't part of this. Undoing a split stays a chat request, as today. They could come later as a follow-up.
- Plan import isn't part of this. When it's built, it uses this layout.

## Anti-goals

- **A draft page that looks like a separate tool from the plan page.** That's the problem being fixed.
- **Lit and dimmed materials on the draft page.** "Used this week" versus "later" belongs only to the plan page. Here the column is the whole list, and nothing is lit or dimmed (owner's words).
- **Opening something that costs credits.** Opening a heading that isn't planned yet only shows what it covers. A button plans it (owner's decision).

## The page

### Header

- The back link, the title and a **subtitle that is the plan's summary**: the same text the plan page shows in its summary band after Confirm (`summarizePlan` in `lib/planSummary.ts`). The **summary card goes away** (`PlanSummaryCard` is no longer used here). While the plan is drafting, the subtitle is a grey shimmer.
- **My call:** the summary on this page leaves out "Latest change: …" and, in Adjust, the lock sentence ("Days 1–12 locked."). The latest change lives in the chat next to Undo, and the lock gets its own line (see Adjust). For a new plan, the summary Confirm saves leaves the note out too. Adjust's save already ignores the page's summary and works it out again on the server, so nothing changes there.
- Titles stay as they are today ("Here's the plan for "…"", "Adjust your plan").

### Layout (wide screens, over 900 px)

There are two columns, as in B1:

- **Left, the plan:** the stat strip, then a status line while something is running, then the list of the plan's top-level units, then Confirm.
- **Right, 340 px:** the materials column on top and the chat under it.

### The stat strip, and changing the time (E1, E1b)

The strip reads: **length** (fixed) · **hours ✎** · **days a week ✎** · **reading share ✎** · source badge ("researched", or the file's name for an import).

Each ✎ number is a button. Clicking one opens a small popover with only that control:

| Button | Popover | On change |
|---|---|---|
| Hours ("13 h a week") | Today's presets (Casual 3 h · Part time 6 h · Full time 30 h) and a number field (`HOURS_PRESETS` in `lib/studyTime.ts`) | Re-drafts the open weeks once the learner stops changing it (`scheduleRedraft`, as today) |
| Days ("5 days a week") | Today's 1–7 picker (`DaysPerWeekPicker`), with today's note that weeks already split keep their days | `relength`, as today |
| Reading ("3% reading") | **The per-kind breakdown from today's time card** (bar and legend: Reading, Problems, Design, Mocks, Recall, Other), and under it the reading slider, 0–100 in steps of 5 | Re-drafts the open weeks, as today |

- A change applies as it's made, the same as today's time card. There's no Save button in the popover.
- The buttons are disabled whenever today's time card is disabled: while streaming, while busy and while confirming.
- **Days isn't shown for a plan of a week or less** (top level `day`), as today. In that case the hours read "in all" (my call).
- Until the draft has set the split, the reading button reads "deciding…" and is disabled. Today's card shows the same state with `deciding`.
- `TimeSplitCard` is no longer used on this page. Its controls move into the popovers.

### Dates

**My call:** the page shows **no calendar dates**. Plans hold study-day positions, not dates, and this design adds no plan data. The mock's dates ("Nov 16 – Jan 10", "Week 3 · Nov 23–29", "Mon Nov 16", "Wednesday Nov 25") are illustration only. Instead:
- The strip shows the length ("8 weeks").
- Rows show their label and title ("Week 3 · publish + resume + narratives").
- A one-week plan's days are "Day 1"…"Day 5".
- Adjust's lock line counts in plan terms: "Weeks 1–2 and the first 2 days of Week 3 are done and stay as they are. Changes apply from Day 3 of Week 3."

### The plan list (B1, B2, H1–H3)

- **Each row is one of the plan's top-level units**: days, weeks or months, depending on `topLevelFor`. A closed row shows its label ("Week 3") and title, a short line under the title and its hours. That line follows today's rule in `PlanTree`: a unit with work shows what it reads and does, and a heading shows its summary.
- **Opening a row expands it in place.** In an open week:
  - **Read** and **Practice** sections hold one row per item, with its kind, the text (problem numbers as chips) and the time.
  - A **Week / Days toggle** appears when the week has days. A week with days opens on Days.
  - **Before a week is split**, a bar at the bottom offers the days stepper and **Split into days** (today's split, `expand(…, "split")`).
  - The week's summary sits under its title, as today.
  - **The Must / Should tags and the budget bar stay** (owner's decision), restyled to fit B's rows. Each Read row keeps its small tier pill (`TierPill`). A thin budget bar under the Read section (`BudgetBar`) shows required against optional reading, set against the week's hours, and how far it runs over. The mock leaves both out; that's a gap in the mock, not a decision to drop them.
- **An open month (H1)** shows its weeks as rows inside it, and each of those opens in the same way. H1 shows Month 1 open with Week 1 open inside it.
- **A heading that isn't planned yet (H2)** shows "Not planned in detail yet" on its row. Opened, it shows **What this … covers** (today's `CoversRow` lines: each material, what it's for, and how much) and a **Plan Month 3 week by week** button. It **does not plan itself when opened** (owner's decision). The button runs today's `expand`, and the new rows stream in place as in F2.
- **What opens by default:**
  - A new plan opens its first unit, and in a month plan that month's first week too.
  - Adjust opens the unit holding the learner's current day (`currentLeaf`).
- **Confirm** sits under the list, as today.
- **Chat changes:** the units a change touched get a light orange outline (today's `highlight` set), the same outline a newly drafted unit gets in F2. That replaces the summary card turning orange.

### The materials column

- **The whole list, grouped by kind** (Books, Practice, Tools, Other), **with nothing lit or dimmed** (owner's words). The backbone shows first in its group and is marked as the backbone.
- It keeps everything `MaterialsList` does today:
  - the research notice and **Research again** (new plans only, before Confirm)
  - remove × with the "where it's used" confirmation (while nothing is running)
  - the dropped and unused items
  - the coverage notice
  - "Show all" past the first few in each group
- **While research runs (F1), the column fills in live** as each item is verified, with a "Still looking…" line at the bottom. That replaces today's "Found so far" chips under the research card, so each item shows only once.

### The chat ("Talk it over")

- It sits under the materials column. The right column stays in view while the plan scrolls, and the chat fills the rest of the screen's height, so its history has room.
- It keeps what today's `ConversationRail` does: the messages, **Undo** on a change, the suggestion chips before the first message, the unread badge, and the lock hint "Available once the plan is drafted" while drafting.
- The rail can no longer collapse to a 56 px strip on wide screens, because the page has no full-height rail any more.

### While a new plan is made (F1, F2)

Only a new plan goes through these steps. Adjust and an import start ready to read.

- **Finding materials (F1):**
  - Today's research card (`ResearchProgress`, with counters and the live log) sits where the plan list will go. The "Found so far" chips are dropped (see the materials column). Grey slots stand in for the units under it.
  - The strip already shows the length, hours and days, with every ✎ disabled and the reading share on "deciding…".
  - The chat is locked.
- **Drafting (F2):**
  - The research card goes away.
  - A status line above the list reads "Drafting 3 of 8 weeks…" (today's `draftingText`), with "Week 1 is ready to read" next to it.
  - Units take the place of their grey slots as they arrive. The newest one has the light outline for a moment. **The first unit opens itself as soon as it lands**, so the learner can read it while the rest stream in.
  - Every ✎, Split into days, Confirm and the chat stay disabled until the draft finishes.
- The same status line shows today's other running states: "Planning in detail…", "Revising the plan…" and "Re-drafting the open weeks…".

### Adjust (G1)

- The subtitle is the summary.
- **A lock line above the list** replaces today's lock sentence in the summary. It reads "🔒 Weeks 1–2 and the first 2 days of Week 3 are done and stay as they are. Changes apply from Day 3 of Week 3." It's built from `lockBefore`.
- **Finished units are faded with a 🔒.** They open to be read but have no Week / Days toggle, split controls or plan button. Inside the current week, finished days are faded and locked too, and the current day has an orange edge and a "Today" tag.
- The ✎ controls work, but only re-draft what isn't locked, as today.
- The chat's first message says where the learner is ("You're on Day 3 of Week 3…").

### Narrow screens, 900 px and under (I1–I3)

- **One column:** the title, the summary cut to three lines with **More**, the strip (wrapping to two rows), the plan list, the materials, then Confirm.
- In an open week, each row's kind sits above its text, and the Week / Days toggle moves under the week title.
- **The materials are folded to one row** ("Materials · 11") that opens in place, so the weeks come first.
- **The chat is today's bottom sheet:** a 64 px strip with the unread badge, opening to about 78% of the screen. It holds the same things as the wide-screen box.
- The ✎ popovers can drop under the strip at this width.

## What stays as it is

- The leave guard, the out-of-credits alerts (at the top of the plan column), error messages, and everything Confirm saves except the two summary notes above.
- All the streaming, research, expand, split, re-draft and chat logic in `PlanWorkspace`. This is a layout change on top of it.

## Left to the builder

- How the components are cut. Reusing the plan page's pieces is encouraged where they fit, such as the materials column's look (`app/tracks/[id]/MaterialsColumn.tsx`) and the strip (`PlanGlance`). `PlanTree`'s logic can be kept or reshaped.
- Exact spacing, sizes and motion, within the mock's look.
- How long the "just changed" or "just arrived" outline stays.
- How the closed row's short line is worded, within today's rule.
- How many items each materials group shows before "Show all", and how the chat and materials share the right column's height. The chat must keep a usable height.
- Whether more than one unit can be open at once.
- Keyboard and screen-reader behaviour of the popovers and the open/close rows. They must be reachable and labelled.
