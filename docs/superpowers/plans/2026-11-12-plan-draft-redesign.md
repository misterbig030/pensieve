# Plan Draft Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the plan draft page (`PlanWorkspace`) in the plan page's style:
- a stat strip whose ✎ numbers edit the time in place
- the plan as one list that opens in place
- the whole materials list with the chat under it
- the plan's summary as the subtitle

**Architecture:** This is a layout change on top of `PlanWorkspace`'s existing streaming, research, expand, split, re-draft and chat logic. None of that logic changes. New presentational parts live in `components/pensieve/draft/`, and the decisions they share are pure functions in `lib/draftPage.ts`. `PlanTree`, `TimeSplitCard` and `PlanSummaryCard` stop being used on this page and are removed. The plan page (`app/tracks/[id]/`) looks exactly as before. It only gets its split breakdown from a shared component.

**Tech Stack:** Next.js 16.3 (App Router, client components), React 19.2, Tailwind 4, `@base-ui/react` 1.7 (Popover, Menu), lucide-react, Vitest 4. Tests run in the `node` environment and render with `renderToStaticMarkup` from `.test.ts` files using `createElement`, with no JSX in tests, as in the existing tests.

**Spec:** `docs/superpowers/specs/2026-11-11-plan-draft-redesign-design.md`. The mockup is `docs/mockups/plan-draft-redesign.html`; build from screens B1, B2, E1, E1b, F1, F2, G1, H1–H3 and I1–I3. Read both before starting.

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing code (AGENTS.md: this Next.js has breaking changes).
- **No new plan data.** Use only what `PlanNode`, `Material` and the existing workspace state hold.
- **No calendar dates anywhere on the page.** Labels are "Week 3", "Day 1", "Day 3 of Week 3".
- **The plan page must not change visibly.** Don't restyle `ReadRows` / `DoRows` in `ReadTable.tsx`, since the plan page re-exports them through `app/tracks/[id]/PaneRows.tsx`.
- The breakpoint is 900 px, as today: `max-[900px]:` / `min-[901px]:`.
- Wide layout: `grid-cols-[minmax(0,1fr)_340px]`.
- The materials column groups the whole list by kind, with **nothing lit or dimmed**.
- **Opening a heading never plans it.** Only its button does.
- **No "Done when" box, no check line after a split, no "Undo split".**
- **Must / Should tags and the budget bar stay** in an open week's Read section.
- The summary shown and saved leaves out "Latest change: …" and the lock sentence: call `summarizePlan(tree, topic, daysPerWeek)` with no note.
- Commit message style: `feat(draft-page): …` / `refactor(draft-page): …`, ending with the repo's co-author line.
- Run tests with `npx vitest run <path>`. Typecheck with `npx tsc --noEmit`. Lint with `npm run lint`.

## Review Focus

1. **Adjust on a track where every day is done.** The lock line and the first chat message must still read sensibly rather than naming a "next day" that doesn't exist. Test in Task 1.
2. **An older plan saved with no split** (`split === null`, not drafting). The reading button must read "not split", and its popover must offer "Divide the time between reading and practice" as today. Tests in Tasks 2 and 3.
3. **A plan with no materials** (research found nothing and the learner gave none). The materials column must say so in one line, and the chat must still get the column's height. Test in Task 6.
4. **A chat change that only touches units inside a closed month or week.** The closed row must show the change outline, or the learner never sees where the change went. Test in Task 5.
5. **A one-week plan before any day has arrived** (`tops` empty, level `day`). The strip must say "1 week", show the hours as "in all", and show no days button. Tests in Tasks 1 and 3.

---

### Task 1: Shared decisions in `lib/draftPage.ts`

**Files:**
- Create: `lib/draftPage.ts`
- Test: `lib/draftPage.test.ts`

**Interfaces:**
- Consumes (existing, `lib/planTree.ts`): `PlanNode`, `PlanLevel`, `labelOf`, `parentOf`, `leavesOf`, `isLocked`, `isHeading`, `weeksOf`, `budgetFor`, `topSpans`, `topLevelFor`, `initialOpen`. From `components/pensieve/ReadTable.tsx`: `readRowsFor`, `practiceRowsFor`, `rowBrief`.
- Produces:
  - `lengthLabel(weeks: number, daysPerWeek: number, tops: PlanNode[]): string`
  - `unitHours(root: PlanNode, node: PlanNode, hoursPerWeek: number, daysPerWeek: number): number`
  - `rowLine(node: PlanNode, byId: ReadonlyMap<string, Material>): string`
  - `defaultOpen(root: PlanNode, mode: "create" | "adjust", currentLeafId: string | null): Set<string>`
  - `openRows(root: PlanNode, mode: "create" | "adjust", currentLeafId: string | null, toggles: ReadonlyMap<string, boolean>): Set<string>`
  - `nextLeafLabel(root: PlanNode, lockBefore: number): string | null`
  - `lockLine(root: PlanNode, lockBefore: number): string | null`
  - `touches(node: PlanNode, ids: ReadonlySet<string>): boolean`

- [ ] **Step 1: Write the failing tests**

Build trees with `makeNode` / `makeRoot` / `layout` from `lib/planTree.ts`, as `PlanTree.test.ts` does. Fixture: `plan3` is three weeks of five days each, with weeks `w1`–`w3` and days `w1d1`…`w3d5`.

```ts
describe("lengthLabel", () => {
  it("counts the top units once they exist", () => {
    expect(lengthLabel(26, 5, sixMonths.children!)).toBe("6 months");
    expect(lengthLabel(1, 5, fiveDays.children!)).toBe("5 days");
  });
  it("falls back to the length the learner set before anything is drafted", () => {
    expect(lengthLabel(8, 5, [])).toBe("8 weeks");
    expect(lengthLabel(1, 5, [])).toBe("1 week");
  });
});

describe("unitHours", () => {
  it("uses a week's own budget, else its share of the weekly hours", () => {
    expect(unitHours(root, weekWithBudget13, 6, 5)).toBe(13);
    expect(unitHours(root, headingMonthOf4Weeks, 6, 5)).toBe(24);
  });
});

describe("rowLine", () => {
  it("shows a heading's summary", () => {
    expect(rowLine(heading /* summary "Genki I lessons 5–8" */, byId)).toBe("Genki I lessons 5–8");
  });
  it("shows what a unit with work reads and does, not its summary", () => {
    const line = rowLine(weekWithReadAndPractice, byId);
    expect(line).toContain(rowBrief(firstReadRow).head);
    expect(line).toContain("Problems");
    expect(line).not.toContain(weekWithReadAndPractice.summary);
  });
});

describe("defaultOpen", () => {
  it("opens a new plan's first unit, and in a month plan its first week too", () => {
    expect([...defaultOpen(weekPlan, "create", null)]).toEqual(["w1"]);
    expect([...defaultOpen(monthPlan, "create", null)].sort()).toEqual(["m1", "m1w1"]);
  });
  it("opens the way to the current day in Adjust", () => {
    expect(defaultOpen(plan3, "adjust", "w3d3")).toEqual(new Set(["w3", "w3d3"]));
  });
});

describe("openRows", () => {
  it("lays the learner's own opening and closing over the defaults", () => {
    expect(openRows(weekPlan, "create", null, new Map([["w1", false], ["w2", true]]))).toEqual(new Set(["w2"]));
  });
});

describe("lockLine and nextLeafLabel", () => {
  // plan3, with w1–w2 and the first two days of w3 completed: lockBefore = 12
  it("names the finished weeks and days and where changes start", () => {
    expect(lockLine(plan3, 12)).toBe("Weeks 1–2 and the first 2 days of Week 3 are done and stay as they are. Changes apply from Day 3 of Week 3.");
    expect(nextLeafLabel(plan3, 12)).toBe("Day 3 of Week 3");
  });
  it("uses the singular for one finished unit", () => {
    expect(lockLine(plan3, 5)).toBe("Week 1 is done and stays as it is. Changes apply from Day 1 of Week 2.");
  });
  it("says nothing when nothing is done", () => {
    expect(lockLine(plan3, 0)).toBeNull();
  });
  it("says so when every day is done", () => {
    expect(lockLine(plan3, 15)).toBe("Every day of this plan is done, so there is nothing left to change.");
    expect(nextLeafLabel(plan3, 15)).toBeNull();
  });
  it("names a leaf week by its own label", () => {
    expect(nextLeafLabel(weekLeavesPlan, 5)).toBe("Week 2");
  });
});

describe("touches", () => {
  it("is true when the node or anything under it is in the set", () => {
    expect(touches(findNode(plan3, "w3")!, new Set(["w3d4"]))).toBe(true);
    expect(touches(findNode(plan3, "w2")!, new Set(["w3d4"]))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run lib/draftPage.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `lib/draftPage.ts`**

- `lengthLabel`: the level is `tops[0]?.level ?? topLevelFor(weeks)`. The count is `tops.length`, or `topSpans(weeks, daysPerWeek).length` when there are no tops yet. Output `${n} ${level}${n === 1 ? "" : "s"}`. When there are no tops and the level is `day`, fall back to `weeksLabel(weeks)` from `lib/studyTime.ts`.
- `unitHours`: `node.budgetHours ?? budgetFor(weeksOf(root, node, daysPerWeek), hoursPerWeek)`.
- `rowLine`:
  - When the node has no assigned rows (`readRowsFor(node.materials)` and `practiceRowsFor(node.practice)` are both empty), return `node.summary`.
  - Otherwise join the unique `rowBrief(r).head` of the read rows, then the unique practice labels with their counts (for example "Problems (7)"), using `" · "`.
- `defaultOpen`:
  - `create`: open `tops[0]`, plus `tops[0].children?.[0]` when `tops[0].level === "month"`.
  - `adjust`: `initialOpen(root, currentLeafId)` plus `currentLeafId` itself.
- `openRows`: start from `defaultOpen`, then add each toggle that is `true` and delete each one that is `false`.
- `nextLeafLabel`: find the first leaf with `start === lockBefore + 1`, or return null if there isn't one. Return `Day N of Week M` for a day whose parent is a week, else `labelOf(root, leaf)`.
- `lockLine`:
  - Return null for `lockBefore === 0`.
  - Return the "Every day …" sentence when there's no next leaf.
  - Otherwise list the parts. The first part is the prefix of fully locked top units, as "Week 1" or "Weeks 1–2". The second part, when the next leaf's top unit started on or before `lockBefore`, is "the first K days of <its label>", with K = `lockBefore - top.start + 1`.
  - Use the singular sentence only for exactly one locked unit and no partial part.
- `touches`: true if `node.id` is in `ids` or any descendant's id is.

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `npx vitest run lib/draftPage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/draftPage.ts lib/draftPage.test.ts
git commit -m "feat(draft-page): shared decisions for the redesigned draft page"
```

---

### Task 2: The time panels and the shared split breakdown

**Files:**
- Create: `components/pensieve/SplitBreakdown.tsx` (moved from `app/tracks/[id]/PlanGlance.tsx`: `Split` → `SplitBreakdown`, and `Why`)
- Modify: `app/tracks/[id]/PlanGlance.tsx` (import `SplitBreakdown`; delete the local `Split` / `Why`)
- Create: `components/pensieve/draft/TimePanels.tsx`
- Test: `components/pensieve/draft/TimePanels.test.ts`

**Interfaces:**
- Produces:
  - `SplitBreakdown({ split, totalHours, materials }: { split: PlanSplit; totalHours: number; materials: Pick<Material, "id" | "practice" | "minutes">[] })`. It renders exactly what `PlanGlance`'s `Split` renders today: "How the N h split", Your call / The plan's call, Why, the bar and the legend.
  - `HoursPanel({ hoursPerWeek, disabled, onChange }: { hoursPerWeek: number; disabled: boolean; onChange: (hours: number) => void })`
  - `DaysPanel({ daysPerWeek, disabled, onChange }: { daysPerWeek: number; disabled: boolean; onChange: (days: number) => void })`
  - `ReadingPanel({ split, deciding, totalHours, materials, disabled, onChange }: { split: PlanSplit | null; deciding: boolean; totalHours: number; materials: Pick<Material, "id" | "practice" | "minutes">[]; disabled: boolean; onChange: (split: PlanSplit) => void })`

- [ ] **Step 1: Write the failing tests**

These carry over `TimeSplitCard.test.ts`'s copy checks. That file is deleted in Task 9.

```ts
const reading = (split: PlanSplit | null, materials = [], deciding = false) =>
  renderToStaticMarkup(createElement(ReadingPanel, { split, deciding, totalHours: 72, materials, disabled: false, onChange: () => {} })).replace(/<!-- -->/g, "");

it("shows the per-kind breakdown above the reading slider", () => {
  const html = reading({ readingShare: 65, practice: "building projects", reason: "r" });
  expect(html).toContain("How the 72 h split");
  expect(html.indexOf("How the 72 h split")).toBeLessThan(html.indexOf('type="range"'));
  expect(html).toContain("Reading and watching: 65% of your time");
});
it("says a pick with no source is drafted as reading", () => {
  const pick = (format: "problem-set" | "design-exercise", share: number) => ({ format, share, focus: "f", reason: "" });
  const html = reading({ readingShare: 50, practice: "problems and design", reason: "r", formats: [pick("problem-set", 50), pick("design-exercise", 50)] }, [{ id: "M1", minutes: 600 }]);
  expect(html).toContain("Problems · no source found, so its time is reading");
});
it("has no slider on an all-reading plan, and says why", () => {
  const html = reading({ readingShare: 100, practice: "reading", reason: "Nothing to practise.", formats: [] });
  expect(html).not.toContain('type="range"');
  expect(html).toContain("All reading: no practice was picked for this topic, so there is no share to move.");
});
it("offers to divide the time on a plan saved with no split", () => {
  expect(reading(null)).toContain("Divide the time between reading and practice");
});
it("says the split is coming while the draft decides it", () => {
  expect(reading(null, [], true)).toContain("The plan decides how to divide this between reading and practice as it drafts the first units.");
});
it("offers today's hour presets and says the open weeks get re-drafted", () => {
  const html = renderToStaticMarkup(createElement(HoursPanel, { hoursPerWeek: 13, disabled: false, onChange: () => {} }));
  expect(html).toContain("Casual · 3 h");
  expect(html).toContain("Full time · 30 h");
  expect(html).toContain("The open weeks get re-drafted for it.");
});
it("keeps today's note on days already split", () => {
  const html = renderToStaticMarkup(createElement(DaysPanel, { daysPerWeek: 5, disabled: false, onChange: () => {} }));
  expect(html).toContain("Applies to weeks you split from now on. Weeks already split keep their days.");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run components/pensieve/draft/TimePanels.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Move the split breakdown, and implement the panels in `TimePanels.tsx`.**

- Move `Split` and `Why` into `SplitBreakdown.tsx` unchanged. `PlanGlance` renders `<SplitBreakdown …/>` where it rendered `<Split …/>`.
- Take the panels' controls from `TimeSplitCard.tsx`'s edit section: the preset buttons, the number `Input` with `clampHours`, `DaysPerWeekPicker`, the range input (0–100, step 5, `reason: SPLIT_SET_BY_LEARNER`), and the "Divide the time" button.
- `ReadingPanel` renders `SplitBreakdown`, then the `toReading` lines from `splitBar`, then the slider.

- [ ] **Step 4: Run the tests and confirm they pass, along with the plan page's tests.**

Run: `npx vitest run components/pensieve/draft app/tracks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/SplitBreakdown.tsx components/pensieve/draft/TimePanels.tsx components/pensieve/draft/TimePanels.test.ts "app/tracks/[id]/PlanGlance.tsx"
git commit -m "feat(draft-page): time panels for the strip; share the split breakdown with the plan page"
```

---

### Task 3: The stat strip (E1, E1b)

**Files:**
- Create: `components/pensieve/draft/StatStrip.tsx`
- Test: `components/pensieve/draft/StatStrip.test.ts`

**Interfaces:**
- Consumes: Task 2's panels. Read `node_modules/@base-ui/react/popover` for the Popover parts (`Popover.Root`, `Trigger`, `Portal`, `Positioner`, `Popup`). `PlanTree`'s `SplitControl` shows how this repo uses base-ui's Menu with the same pattern.
- Produces:
  ```ts
  export interface StatStripProps {
    lengthLabel: string;           // from lengthLabel()
    topLevel: PlanLevel;
    hoursPerWeek: number;
    daysPerWeek: number;
    split: PlanSplit | null;
    deciding: boolean;             // drafting && !split
    totalHours: number;
    materials: Material[];
    sourceLabel: string | null;    // "researched" when any material has origin "research"; null otherwise
    disabled: boolean;             // streaming || busy || confirming
    onChangeHours: (hours: number) => void;
    onChangeDays?: (days: number) => void;  // omitted for topLevel "day"
    onChangeSplit: (split: PlanSplit) => void;
  }
  export function StatStrip(props: StatStripProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const strip = (over: Partial<StatStripProps> = {}) => renderToStaticMarkup(createElement(StatStrip, { lengthLabel: "8 weeks", topLevel: "week", hoursPerWeek: 13, daysPerWeek: 5, split: { readingShare: 3, practice: "practice", reason: "r" }, deciding: false, totalHours: 104, materials: [], sourceLabel: "researched", disabled: false, onChangeHours: () => {}, onChangeDays: () => {}, onChangeSplit: () => {}, ...over })).replace(/<!-- -->/g, "");

it("shows the length and three edit buttons", () => {
  const html = strip();
  expect(html).toContain("8 weeks");
  expect(html).toMatch(/aria-label="Change hours a week"/);
  expect(html).toMatch(/aria-label="Change days a week"/);
  expect(html).toMatch(/aria-label="Change the reading share"/);
  expect(html).toContain("3% reading");
  expect(html).toContain("researched");
});
it("has no days button on a one-week plan, and counts its hours in all", () => {
  const html = strip({ topLevel: "day", lengthLabel: "1 week", onChangeDays: undefined });
  expect(html).not.toContain("Change days a week");
  expect(html).toContain("in all");
});
// The opening tag of the button with this label, whatever order its attributes come in.
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

it("reads deciding, disabled, while the draft sets the split", () => {
  const html = strip({ split: null, deciding: true });
  expect(html).toContain("deciding…");
  expect(button(html, "Change the reading share")).toContain("disabled");
});
it("reads not split on a plan saved with no split", () => {
  expect(strip({ split: null })).toContain("not split");
});
it("disables every button while the plan is busy", () => {
  const html = strip({ disabled: true });
  for (const label of ["Change hours a week", "Change days a week", "Change the reading share"]) expect(button(html, label)).toContain("disabled");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run components/pensieve/draft/StatStrip.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `StatStrip`**

- Use the mock's `.glance` look: `elev-sm rounded-[18px] bg-neutral-100`, Caprasimo numbers with small captions.
- Each ✎ cell is a `Popover.Trigger` holding its panel.
- The reading cell's text is:
  - `${split.readingShare}% reading` with the caption "the rest practice", or "all reading" when `isAllReading`
  - "deciding…" when `deciding`
  - "not split" otherwise
- The hours caption is "a week", or "in all" for `topLevel === "day"`.
- The source badge sits at the right when `sourceLabel` is set.
- At `max-[900px]:` the strip is a 2×2 grid and each popover opens under it, full width.

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `npx vitest run components/pensieve/draft/StatStrip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/draft/StatStrip.tsx components/pensieve/draft/StatStrip.test.ts
git commit -m "feat(draft-page): the stat strip, each number editing itself"
```

---

### Task 4: An open unit's rows and day cards

**Files:**
- Create: `components/pensieve/draft/UnitRows.tsx`
- Test: `components/pensieve/draft/UnitRows.test.ts`

**Interfaces:**
- Consumes (existing, `ReadTable.tsx`): `ReadRow`, `PracticeRow`, `TierPill`, `FormatPill`, `BudgetBar`, `partLabel`, `rowBrief`, `itemLabel`, `sumMinutes`, `sumPracticeMinutes`. From `lib/researchProgress.ts`: `formatDuration`. From `lib/schemas/material.ts`: `KIND_LABEL`.
- Produces:
  - `ReadSection({ rows, budgetMinutes, practiceMinutes }: { rows: ReadRow[]; budgetMinutes: number; practiceMinutes: number })`: the "Read" caption, one row per item (kind, `TierPill`, title with part, `rowBrief(r).detail` small, time), and `BudgetBar` under it.
  - `PracticeSection({ rows }: { rows: PracticeRow[] })`: the "Practice" caption, one row per item (`FormatPill`, `itemLabel(item)` with its group or the task, time).
  - `DayCards({ root, week, byId, lockBefore, currentLeafId }: { root: PlanNode; week: PlanNode; byId: ReadonlyMap<string, Material>; lockBefore: number; currentLeafId: string | null })`: one card per day, with `labelOf`, one line per row, and the day's time. A locked day is faded with a "Done" tag, and the current day has an orange edge and a "Today" tag.

- [ ] **Step 1: Write the failing tests.** Reuse `PlanTree.test.ts`'s fixtures: the `nc` bank with `LISTED_PROBLEMS`, and the `listed` and `plainRow` practice refs.

```ts
it("shows a listed item as number and title with its group, and other rows by their task", () => {
  const out = html(createElement(PracticeSection, { rows: practiceRowsFor([listed, plainRow], byId) }));
  expect(out).toMatch(/217\. Contains Duplicate<span[^>]*>Arrays &amp; Hashing<\/span>/);
  expect(out).not.toContain("problem 1");
  expect(out).toContain("One mock round");
});
it("keeps the tier pill on each read row and the budget bar under them", () => {
  const out = html(createElement(ReadSection, { rows: readRowsFor([{ id: "aie", note: null, chapter: 3, tier: "must", minutes: 60 }], byId), budgetMinutes: 780, practiceMinutes: 300 }));
  expect(out).toContain(">Must<");
  expect(out).toContain(budgetLine({ readingMinutes: 60, practiceMinutes: 300, budgetMinutes: 780 }));
});
it("marks finished days done and the current day today", () => {
  const out = html(createElement(DayCards, { root: plan3, week: findNode(plan3, "w3")!, byId, lockBefore: 12, currentLeafId: "w3d3" }));
  expect(out.match(/>Done</g)).toHaveLength(2);
  expect(out.match(/>Today</g)).toHaveLength(1);
});
```

`html(el)` is `renderToStaticMarkup(el).replace(/<!-- -->/g, "")`. `BudgetBar`'s compact variant prints `budgetLine`'s text, so the second assertion holds once the bar is there.

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run components/pensieve/draft/UnitRows.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `UnitRows.tsx`**

Use the mock's `.rw` row grid (kind 118 px · text · time 64 px) and its `.day` cards. At `max-[900px]:`, the kind sits above the text.

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `npx vitest run components/pensieve/draft/UnitRows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/draft/UnitRows.tsx components/pensieve/draft/UnitRows.test.ts
git commit -m "feat(draft-page): an open unit's read and practice rows, and its day cards"
```

---

### Task 5: The plan list (B1, B2, F2, G1, H1–H3)

**Files:**
- Create: `components/pensieve/draft/PlanList.tsx`
- Test: `components/pensieve/draft/PlanList.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `rowLine`, `unitHours`, `touches`.
  - Task 4: `ReadSection`, `PracticeSection`, `DayCards`.
  - Existing: `CoversRow` and `PendingSlots` from `PlanTree.tsx`; `readRowsFor`, `practiceRowsFor`, `coverPracticeRows`, `sumPracticeMinutes` from `ReadTable.tsx`; `keptReadTable` and `budgetMinutes` from `lib/materials.ts`; `formatUnitTime` from `lib/studyTime.ts`; `labelOf`, `isLocked`, `isHeading`, `childLevel` and `MAX_DAYS_PER_WEEK` from `lib/planTree.ts`.
- Produces:
  ```ts
  export type WeekView = "week" | "days";
  export interface PlanListProps {
    root: PlanNode;
    materials: Material[];
    hoursPerWeek: number;
    daysPerWeek: number;
    open: ReadonlySet<string>;                 // from openRows()
    weekView: ReadonlyMap<string, WeekView>;   // a week with days defaults to "days"
    highlight: ReadonlySet<string>;            // chat changes
    lockBefore: number;
    currentLeafId: string | null;
    pending: Readonly<Record<string, PendingSlots>>;
    busy: boolean;                             // streaming || busy || redrafting
    onToggleOpen: (id: string) => void;
    onSetView: (id: string, view: WeekView) => void;
    onExpand: (id: string) => void;            // plan a heading in detail
    onSplit: (id: string, days: number) => void;
  }
  export function PlanList(props: PlanListProps): JSX.Element
  ```

**What it renders:** one row per top unit, then the root's pending slots.

- **A closed row** shows `labelOf`, the title, `rowLine`, and `${unitHours} h`. A heading prefixes its line with "Not planned in detail yet · ".
- **An open row** shows a header (label, title, `node.summary`, and `formatUnitTime(node.time)` when set) and a body:
  - **A heading:** `CoversRow`, and unless it's locked or busy, a button labelled `Plan ${label} ${childLevel === "week" ? "week by week" : "day by day"}` that calls `onExpand`. The note beside it reads "Or leave it: the plan page has the same button."
  - **A month with children:** its children as nested rows, each one opening the same way.
  - **A week:**
    - When it has days and isn't locked, a Week / Days toggle.
    - The "days" view shows `DayCards`.
    - The "week" view shows `ReadSection` and `PracticeSection`. A leaf week uses its own `materials` and `practice`. A `manualSplit` week uses its kept tables (`keptReadTable(covers)` and `coverPracticeRows(practiceCovers)`). Any other week with days uses every day's rows together.
    - A leaf week that isn't locked and has no days shows a split bar: "Not split into days yet.", a − n days + stepper (1…`MAX_DAYS_PER_WEEK`, starting at `daysPerWeek`), and a **Split into days** button that calls `onSplit(id, n)`. The button is disabled while busy.
  - **A day at the top** (a one-week plan): `ReadSection` and `PracticeSection`, with no toggle and no split bar.
- **Locked units** are faded (`opacity-50`) with a lucide `Lock` icon. They open to be read, with no toggle, split or plan button.
- **Change outline:** a row with `touches(node, highlight)` gets the orange outline (`border-accent-400`) whether it's open or closed.
- **Arrival:** every row mounts with a short outline animation. Its duration is the builder's call (see the spec).
- **Pending slots** are grey rows (`.slot` in the mock). The first slot of a parent pulses.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows a closed heading's summary and that it isn't planned yet", () => {
  const out = list({ open: new Set() });
  expect(out).toContain("Not planned in detail yet · Genki I lessons 5–8");
});
it("opens a heading to what it covers and a plan button, without planning it", () => {
  const out = list({ open: new Set(["m3"]) });
  expect(out).toContain("Plan Month 3 week by week");
  expect(out).toContain("Or leave it: the plan page has the same button.");
});
it("has no plan button on a locked heading or while busy", () => {
  expect(list({ open: new Set(["m3"]), busy: true })).not.toContain("Plan Month 3");
});
it("offers a split on an open leaf week, and none on a locked one", () => {
  expect(list({ root: weekLeaves, open: new Set(["w2"]) })).toContain("Split into days");
  expect(list({ root: weekLeaves, open: new Set(["w1"]), lockBefore: 5 })).not.toContain("Split into days");
});
it("shows a week with days on Days by default, with the toggle", () => {
  const out = list({ root: plan3, open: new Set(["w1"]) });
  expect(out).toMatch(/aria-pressed="true"[^>]*>Days</);
});
it("outlines a closed row when a change touched something inside it", () => {
  const out = list({ root: plan3, open: new Set(), highlight: new Set(["w3d4"]) });
  expect(out).toMatch(/data-unit="w3"[^>]*data-changed="true"/);
});
it("shows a week's unit time under its title", () => {
  expect(list({ root: weekWithTime, open: new Set(["w1"]) })).toContain("2 h 30 min reading · 3 h Problems");
});
it("draws one grey slot per pending unit", () => {
  expect(list({ root: oneWeekArrived, pending: { root: { count: 7, groups: false } } }).match(/data-slot/g)).toHaveLength(7);
});
```

`list(over)` renders `PlanList` with defaults: the six-month fixture (`m1` with weeks, `m2`–`m6` headings with `covers`), `mode` "create", empty sets and maps, `lockBefore` 0, `busy` false, and no-op handlers.

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run components/pensieve/draft/PlanList.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `PlanList`**

Put `data-unit`, then `data-changed`, in that order on each row element, and `data-slot` on each slot, so the tests and the live check can find them. At `max-[900px]:` the Week / Days toggle moves under the week title (I1).

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `npx vitest run components/pensieve/draft/PlanList.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/draft/PlanList.tsx components/pensieve/draft/PlanList.test.ts
git commit -m "feat(draft-page): the plan as one list that opens in place"
```

---

### Task 6: The materials column (B1, F1, I2)

**Files:**
- Modify: `components/pensieve/MaterialsList.tsx` (only the draft page renders the component; `MaterialsColumn` and `columnLines` import only its helpers, which stay as they are)
- Test: `components/pensieve/MaterialsList.test.ts` (keep every existing test passing, and add the ones below)

**Interfaces:**
- Consumes: `FoundMaterial` from `lib/researchProgress.ts`.
- Produces: two new props on `MaterialsListProps`:
  - `found?: FoundMaterial[]`: set while research runs. The column then lists these, grouped by `KIND_LABEL`, with a "Still looking…" line, and nothing else.
  - `fold?: boolean`: wraps the column in a `<details>` that starts closed, with the summary "Materials · N" (narrow screens).
- Restyle to the plan page's column look (`MaterialsColumn.tsx`): `elev-sm rounded-[18px] bg-neutral-100`, a "Materials N" heading, `checkedLine` under it, group captions, and rows with an icon tile, title and small line. Keep the remove ×, the Show all button, the totals line, the coverage chips, the research notice with Research again, and both dropped groups. **Nothing is lit or dimmed.**

- [ ] **Step 1: Write the failing tests**

```ts
it("lists what research has found so far, with a still-looking line", () => {
  const html = render({ materials: [], found: [{ id: "a", title: "Genki I", kind: "book", backbone: false, yours: false }] });
  expect(html).toContain("Genki I");
  expect(html).toContain("Still looking…");
});
it("starts folded on a narrow screen", () => {
  const html = render({ fold: true });
  expect(html).toMatch(/<details(?![^>]*\bopen\b)/);
  expect(html).toContain("Materials");
});
it("says so in one line when the plan has no materials", () => {
  expect(render({ materials: [] })).toContain("No materials yet.");
});
it("neither lights nor dims any material", () => {
  expect(render({})).not.toMatch(/opacity-60|bg-accent-100 shadow-\[inset_2px/);
});
```

`render(props)` is the existing `createElement(MaterialsList, { topic: "T", materials: [...], ...props })` helper in this file.

- [ ] **Step 2: Run the tests and confirm the new ones fail.**

Run: `npx vitest run components/pensieve/MaterialsList.test.ts`
Expected: the new tests FAIL and the old ones PASS.

- [ ] **Step 3: Implement the restyle and the two props.** Today the component renders nothing when `materials` is empty; replace that with the "No materials yet." line.

- [ ] **Step 4: Run the tests and confirm they all pass, along with the plan page's tests.**

Run: `npx vitest run components/pensieve/MaterialsList.test.ts app/tracks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/MaterialsList.tsx components/pensieve/MaterialsList.test.ts
git commit -m "feat(draft-page): the whole materials list as a column, filling in live during research"
```

---

### Task 7: The chat box, and the research card without its chips

**Files:**
- Modify: `components/pensieve/ConversationRail.tsx`
- Modify: `components/pensieve/ResearchProgress.tsx` (delete the "Found so far" section; the materials column shows those items now)
- Test: `components/pensieve/ConversationRail.test.ts` (new), `components/pensieve/ResearchProgress.test.ts` (new)

**Interfaces:**
- `ConversationRail`'s props are unchanged. `open` now only affects narrow screens: the bottom sheet, 64 px closed and `78vh` open, as today. On wide screens the box is always shown.
- The desktop collapsed tab goes away, along with the wide-screen collapse button. The heading reads "Talk it over".
- On wide screens the `aside` drops its own `sticky` / `h-[calc(100vh-40px)]` and takes `min-[901px]:min-h-[320px] min-[901px]:flex-1`. The right column in Task 8 is sticky and sets the height.

- [ ] **Step 1: Write the failing tests**

```ts
it("is a box headed Talk it over, with no desktop collapsed tab", () => {
  const html = renderToStaticMarkup(createElement(ConversationRail, { mode: "create", messages: [], open: true, unread: false, busy: false, input: "", suggestions: ["Expand week 2"], onToggle() {}, onInputChange() {}, onSend() {}, onUndo() {} }));
  expect(html).toContain("Talk it over");
  expect(html).not.toContain("[writing-mode:vertical-rl]");
  expect(html).not.toContain('title="Open conversation"');
  expect(html).toContain("Expand week 2");
});
it("no longer shows found items under the research card", () => {
  const html = renderToStaticMarkup(createElement(ResearchProgress, { state: { ...initialResearch(0), found: [{ id: "a", title: "Genki I", kind: "book", backbone: true, yours: false }] } }));
  expect(html).not.toContain("Found so far");
  expect(html).not.toContain("Genki I");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npx vitest run components/pensieve/ConversationRail.test.ts components/pensieve/ResearchProgress.test.ts`
Expected: FAIL.

- [ ] **Step 3: Make the changes above.** Delete the desktop collapsed tab (the `sticky top-5` block with the vertical "Conversation" label). The narrow sheet's toggle button stays, with its `aria-label` "Open conversation" / "Collapse conversation", hidden on wide screens with `min-[901px]:hidden`. Drop its `title` attribute.

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `npx vitest run components/pensieve/ConversationRail.test.ts components/pensieve/ResearchProgress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/ConversationRail.tsx components/pensieve/ResearchProgress.tsx components/pensieve/ConversationRail.test.ts components/pensieve/ResearchProgress.test.ts
git commit -m "feat(draft-page): the chat as a box under the materials; drop the research card's chips"
```

---

### Task 8: Wire the workspace

**Files:**
- Modify: `components/pensieve/PlanWorkspace.tsx`
- Modify: `app/tracks/new/NewTrackForm.tsx` and `app/tracks/[id]/adjust/AdjustPlan.tsx` (drop the `subtext` prop)
- Test: `lib/draftPage.test.ts` (one case for `adjustOpening`, below)

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: `PlanWorkspaceProps` without `subtext`. In `lib/draftPage.ts`: `adjustOpening(root: PlanNode, lockBefore: number): string`, the first chat message in Adjust.

**Changes, in `PlanWorkspace.tsx` order:**

1. **Summary.** `const summary = drafting ? "" : summarizePlan(tree, topic, daysPerWeek);`. Drop `lockNote` and `note`. `summaryNote` stays, because the re-draft and undo logic still carry it, but it's no longer shown.
2. **Open state.**
   - Replace `collapsed` with `toggles: Map<string, boolean>`, and compute `open = openRows(tree, mode, current?.id ?? null, toggles)` on each render. That way the first unit opens itself the moment it lands (F2).
   - Add `weekView: Map<string, WeekView>`.
   - `expand` used to delete the node from `collapsed`; now it sets `toggles` to `true` for the node.
   - Remove `openChips` and `onToggleChip`.
3. **Rail state.** `railOpen = isNarrow ? (railToggled ?? false) : true`. The unread logic stays as it is.
4. **Header.**
   - The back link, then the `h1`.
   - Then the subtitle: `summary`, or two `skeleton-bar` lines while `drafting`. At `max-[900px]:` it's clamped to three lines with a More / Less button. Reuse the measuring pattern in `PlanGlance`'s `Summary`.
5. **Grid.** `min-[901px]:grid-cols-[minmax(0,1fr)_340px]`.
6. **Left column, in order:**
   1. `StatStrip`, with:
      - `lengthLabel(planWeeks, daysPerWeek, tops)`
      - `deciding={drafting && !split}`
      - `disabled={streaming || busy || confirming || researching}`
      - `onChangeDays={topLevel === "day" ? undefined : changeDays}`
      - `sourceLabel` set to "researched" when any material has `origin === "research"`, else null
   2. In Adjust, when `lockLine(tree, lockBefore)` isn't null, the lock line (a `Lock` icon plus the text).
   3. The status line: today's `draftingText`, with "<first unit label> is ready to read" next to it while `drafting && tops.length > 0`.
   4. The plan area, which is one of:
      - the out-of-credits alert with grey slots (as today)
      - while `researching`, the `ResearchProgress` card with three grey slots, the first reading "<Level>s start drafting as soon as the materials list is set."
      - otherwise, `PlanList`
   5. Confirm and the error lines, as today.
7. **Right column.** `min-[901px]:sticky min-[901px]:top-5 min-[901px]:h-[calc(100vh-40px)] flex flex-col gap-4`:
   - `MaterialsList` in `min-h-0 shrink overflow-y-auto` (cap it at about 55% of the column), with `found={researching ? research.found : undefined}` and `fold={isNarrow}`
   - then `ConversationRail`
   - On narrow screens the materials move into the left column after `PlanList`, and the rail stays the bottom sheet.
8. **Copy.**
   - In `materialsText`, "listed above" becomes "listed on the right".
   - In `draftedText`, "change that above if it is off" becomes "change it on the strip if it is off".
   - `initialMessages` in Adjust: the first message becomes `adjustOpening(root, lockBefore)`, and the "Here is the rest of your plan…" answer stays.
9. **Imports.** Remove `PlanSummaryCard`, `TimeSplitCard`, `PlanTree` and `TreeLabel`.

- [ ] **Step 1: Write the failing test for `adjustOpening`**

```ts
it("tells the learner where they are in Adjust", () => {
  expect(adjustOpening(plan3, 12)).toBe("You're on Day 3 of Week 3. Tell me what to change from here on. Weeks 1–2 and the first 2 days of Week 3 are done and stay as they are.");
  expect(adjustOpening(plan3, 0)).toBe("Nothing is checked off yet, so the whole plan is open to change.");
  expect(adjustOpening(plan3, 15)).toBe("Every day of this plan is done, so there is nothing left to change.");
});
```

- [ ] **Step 2: Run the test and confirm it fails.**

Run: `npx vitest run lib/draftPage.test.ts`
Expected: FAIL, because `adjustOpening` isn't exported.

- [ ] **Step 3: Implement `adjustOpening` (built from `nextLeafLabel` and `lockLine`'s parts), then make the workspace changes 1–9.**

- [ ] **Step 4: Typecheck, lint and run the whole suite.**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: no type errors, no lint errors, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pensieve/PlanWorkspace.tsx lib/draftPage.ts lib/draftPage.test.ts app/tracks/new/NewTrackForm.tsx "app/tracks/[id]/adjust/AdjustPlan.tsx"
git commit -m "feat(draft-page): lay the draft page out as the plan page is"
```

---

### Task 9: Remove what the page no longer uses

**Files:**
- Delete: `components/pensieve/PlanSummaryCard.tsx`, `components/pensieve/TimeSplitCard.tsx`, `components/pensieve/TimeSplitCard.test.ts`
- Modify: `components/pensieve/PlanTree.tsx`. Delete `PlanTree`, `NodeView`, `LeafChip`, `GroupCard`, `Skeletons`, `gridClass`, `ChangedPill`, `TreeLabel` and `formatHours`. Keep `PendingSlots`, `PlanTreeMode` (if still imported), `coverLines`, `CoverLine`, `CoversRow` and `SplitControl`, which `DayPane`, `PlanUnitButton` and `usePlanning` import.
- Modify: `components/pensieve/PlanTree.test.ts`. Delete the two `describe` blocks that render `PlanTree` ("a collapsed day card's practice lines" and "a heading's unit time"); Tasks 4 and 5 carry their checks now. Keep `coverLines` and `CoversRow`.

- [ ] **Step 1: Confirm nothing else imports what's being deleted.**

Run: `grep -rnE "PlanSummaryCard|TimeSplitCard|\bPlanTree\b[^.]|TreeLabel" app components lib --include=*.ts --include=*.tsx`
Expected: matches only in the files being deleted and in `PlanTree.tsx`'s own definitions.

- [ ] **Step 2: Delete them, and trim `PlanTree.tsx` and its test.**

- [ ] **Step 3: Typecheck, lint and run the whole suite.**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: everything passes, with no unused-import lint errors.

- [ ] **Step 4: Commit**

```bash
git add -A components/pensieve
git commit -m "refactor(draft-page): remove the summary card, time card and plan tree the page no longer uses"
```

---

### Task 10: Live check

No code. This task proves the page in a real browser, because the workspace's streaming can't be rendered in a unit test.

- [ ] **Step 1: Start a dev server on port 3001 from this worktree.** Start it detached with `nohup`; preview servers and terminal tabs die. Never use the owner's server on 3000, and leave this one running afterwards. Use the owner's Chrome on `localhost:3001`, in a **new tab**. The built-in browser has no sign-in session. The dev log is at `.next/dev/logs`.

- [ ] **Step 2: A new 8-week plan.**
  - **F1, while research runs:**
    - The research card sits in the list's place with three grey slots.
    - The strip shows "8 weeks", 6 h and 5 days, with every ✎ disabled and "deciding…".
    - The materials column fills in with "Still looking…".
    - The chat is locked with "Available once the plan is drafted".
  - **F2, while drafting:**
    - The status line counts the units, and Week 1 opens itself as soon as it lands.
    - The subtitle shimmers until the draft ends, then shows the summary.
  - **After the draft:**
    - Every ✎ popover changes the time. Hours and reading re-draft the open weeks, and the status line reads "Re-drafting the open weeks…".
    - The reading popover shows the breakdown above the slider.
    - Split Week 2 into 4 days with the stepper. The days stream in, and the week shows Days.
    - Ask the chat to swap two weeks. Both rows get the outline, and Undo works.
    - Confirm. The plan page's summary band shows the same text the subtitle showed, with no "Latest change".

- [ ] **Step 3: A 20-week plan (months).**
  - Month 1 and its Week 1 open on their own.
  - Month 3 opens to "What this month covers" and the plan button, and doesn't plan itself.
  - Clicking the button streams its weeks in.

- [ ] **Step 4: A one-week plan.** The strip has no days button and its hours read "in all". The rows are days with no split bar.

- [ ] **Step 5: Adjust, on a track partway through.**
  - The lock line names the finished weeks and days, and the current week is open on Days with "Today" on the current day.
  - Finished weeks are faded with a 🔒 and have no controls.
  - The chat's first message says where the learner is.

- [ ] **Step 6: At 390 px wide.**
  - The summary is clamped to three lines with More, the strip is a 2×2 grid, and the materials are folded after the weeks.
  - The chat is a 64 px sheet with "New" after a reply, and it opens to about 78% of the screen.

- [ ] **Step 7: Report.** Take a screenshot of each step and note anything that differs from the mock or the spec. Fix what's wrong in the task that owns it, then re-run that task's tests.
