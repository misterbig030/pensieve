import { describe, expect, it } from "vitest";
import { layout, makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { MaterialPractice, MaterialRef, PracticeCover, PracticeRef } from "@/lib/schemas/material";
import { LISTED_PROBLEMS, PROBLEM_ITEMS } from "@/lib/__fixtures__/problemList";
import { AIE_HOURS, AIE_MATERIALS, AIE_SHARE, AIE_TOC, aiePlan } from "@/lib/__fixtures__/aiEngineeringPlan";
import {
  aliasMaterials,
  assignmentsOf,
  chapterGaps,
  chapterRegressions,
  DROPPABLE,
  dropBreaches,
  formatAliases,
  learnerMaterials,
  levelChecks,
  numberedToc,
  parseChapters,
  refKey,
  remapTreeRefs,
  removeMaterialRefs,
  resolveCoverRefs,
  resolveMaterialRefs,
  resolvePracticeCovers,
  resolvePracticeRefs,
  noSourceFacts,
  pickSources,
  practiceBudgets,
  reservedRunMinutes,
  reservedRuns,
  weekPracticeTime,
  fitWeekToDays,
  practiceRowKey,
  sizeChapterRows,
  tierMinutes,
  treeChecks,
  keptReadTable,
  keepPracticeCovers,
  splitHours,
  draftedSplit,
  shareRuns,
  sizeItemRuns,
  itemAliases,
  itemRun,
  plainAliases,
  plainUnitText,
} from "./materials";
import { itemMinutes, itemPositions } from "./practice";

describe("numberedToc", () => {
  const unnumbered = { ...AIE_TOC, chapters: AIE_TOC.chapters.slice(0, 5).map((c) => ({ ...c, n: null })) };
  it("numbers a cut list without numbers from its part's uses line", () => {
    expect(numberedToc(unnumbered, "ch. 1, 3, 5–6, 9", "book")!.chapters.map((c) => c.n)).toEqual([1, 3, 5, 6, 9]);
  });
  it("numbers a book's list without numbers by position when the uses line does not name one number per chapter", () => {
    expect(numberedToc(unnumbered, null, "book")!.chapters.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
    expect(numberedToc(unnumbered, "ch. 1, 3", "book")!.chapters.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
    expect(numberedToc(unnumbered, "the chapters on storage", "book")!.chapters.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps the titles of another kind's list without numbers, unless its uses line numbers a cut", () => {
    expect(numberedToc(unnumbered, null, "course")).toBe(unnumbered);
    expect(numberedToc(unnumbered, "the modules on storage", "course")).toBe(unnumbered);
    expect(numberedToc(unnumbered, "ch. 2, 4, 6–8", "course")!.chapters.map((c) => c.n)).toEqual([2, 4, 6, 7, 8]);
  });
  it("leaves a list that has numbers as it is, an unnumbered preface included", () => {
    const withPreface = { ...AIE_TOC, chapters: [{ ...AIE_TOC.chapters[0], n: null, title: "Preface" }, ...AIE_TOC.chapters.slice(1)] };
    expect(numberedToc(withPreface, "ch. 1–10", "book")).toBe(withPreface);
    expect(numberedToc(null, "ch. 1", "book")).toBeNull();
  });
});

describe("parseChapters", () => {
  it.each([
    ["Ch. 4 §2", [4]],
    ["ch. 5–6", [5, 6]],
    ["chapters 3, 7 and 9", [3, 7, 9]],
    ["Chapter 12", [12]],
    ["chs. 1-3", [1, 2, 3]],
    ["ch 2 to 4", [2, 3, 4]],
    ["whole essay", []],
    [null, []],
  ] as const)("%s", (note, chapters) => {
    expect(parseChapters(note)).toEqual(chapters);
  });
});

describe("aliases and refs", () => {
  const toc = (n: number) => ({ source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `C${i + 1}`, page: null, minutes: null, sections: [] })) });
  const aliases = aliasMaterials([{ id: "uuid-a", toc: toc(4) }, { id: "uuid-b" }]);
  it("maps list positions to M ids and back", () => {
    expect(aliases.alias("uuid-b")).toBe("M2");
    expect(aliases.resolve("m1")).toEqual({ id: "uuid-a", chapter: null });
    expect(aliases.resolve("M9")).toBeUndefined();
  });
  it("names chapters by position and resolves them back", () => {
    expect(aliases.alias("uuid-a", 3)).toBe("M1.3");
    expect(aliases.alias("uuid-a")).toBe("M1");
    expect(aliases.resolve("m1.3")).toEqual({ id: "uuid-a", chapter: 3 });
    expect(aliases.resolve("[M2]")).toEqual({ id: "uuid-b", chapter: null });
    expect(aliases.resolve("M1.5")).toBeUndefined(); // past the list
    expect(aliases.resolve("M2.1")).toBeUndefined(); // no list
    expect(aliases.chapters("uuid-a")).toBe(4);
    expect(aliases.chapters("uuid-b")).toBe(0);
  });
  it("resolves chapter refs, dedupes on id and chapter, keeps a bare book id for the checks", () => {
    const { refs, unknown } = resolveMaterialRefs(
      [
        { id: "M1.2", tier: "must", minutes: 30 },
        { id: "M1.2", tier: "should", minutes: 5 },
        { id: "M1.3", tier: "must", minutes: 20 },
        { id: "M1", tier: "must", minutes: 10 },
        { id: "M7", tier: "must", minutes: 1 },
      ],
      aliases,
    );
    expect(unknown).toEqual(["M7"]);
    // Every row the model writes is a reading: reviews are the learner's choice, not the planner's.
    expect(refs.map((r) => [r.chapter, r.activity, r.minutes])).toEqual([[2, "read", 30], [3, "read", 20], [null, "read", 10]]);
  });
  it("collapses runs of consecutive chapters", () => {
    expect(formatAliases([{ id: "uuid-a", chapter: 1 }, { id: "uuid-a", chapter: 2 }, { id: "uuid-a", chapter: 3 }, { id: "uuid-b", chapter: null }, { id: "uuid-a", chapter: 4 }], aliases)).toBe("M1.1–M1.3, M2, M1.4");
    expect(refKey({ id: "x", chapter: null })).toBe("x#0");
  });
  it("drops unknown ids and duplicates, rounds minutes, clips notes", () => {
    const { refs, unknown } = resolveMaterialRefs(
      [
        { id: "M1", tier: "must", minutes: 42.6, note: "x".repeat(400) },
        { id: "M9", tier: "must", minutes: 10 },
        { id: "M1", tier: "should", minutes: 5 },
      ],
      aliases,
    );
    expect(unknown).toEqual(["M9"]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: "uuid-a", tier: "must", minutes: 43 });
    expect(refs[0].note!.length).toBe(300);
  });
});

describe("chapter checks", () => {
  it("flags the backbone going backwards", () => {
    expect(chapterRegressions([{ label: "Week 1", chapters: [1, 2] }, { label: "Week 2", chapters: [] }, { label: "Week 3", chapters: [1] }])).toEqual([
      "backbone ch. 1 after ch. 2 (Week 3)",
    ]);
  });
  it("finds chapters no heading reserves", () => {
    expect(chapterGaps([1, 2, 5, 6])).toEqual([3, 4]);
    expect(chapterGaps([])).toEqual([]);
  });
  it("judges gaps against a cut list's own chapters", () => {
    expect(chapterGaps([5, 6, 7, 8, 9], [5, 6, 7, 8, 9])).toEqual([]);
    expect(chapterGaps([5, 6, 7, 9], [5, 6, 7, 8, 9])).toEqual([8]);
    expect(chapterGaps([5, 7, 9], [5, 6, 7, 9])).toEqual([6]);
  });
});

describe("levelChecks on a backbone cut to ch. 5–9", () => {
  // The allocation kept AIE's chapters 5–9: the list's positions 1–5 are now ch. 5–9.
  const cut = { ...AIE_TOC, chapters: AIE_TOC.chapters.slice(4, 9) };
  const materials = AIE_MATERIALS.map((m) => (m.id === "aie" ? { ...m, toc: cut, minutes: 543, uses: "ch. 5–9" } : m));
  const cover = (chapter: number) => ({ id: "aie", note: null, chapter });
  const weeks = () => [1, 2, 3, 4, 5].map((p) => makeNode({ id: `w${p}`, level: "week", title: `W${p}`, summary: "s", len: 7, covers: [cover(p)] }));
  const run = (root: PlanNode, nodes: PlanNode[], leaves: boolean, top: boolean) =>
    levelChecks({ root, nodes, leaves, top, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 7, split: { readingShare: 40, practice: "projects", reason: "" } });

  it("a top level reserving every kept chapter reports no chapter fact", () => {
    const nodes = weeks();
    const root = layout(makeRoot(nodes));
    expect(run(root, nodes, false, true).facts.filter((f) => f.startsWith("backbone"))).toEqual([]);
  });
  it("a top level leaving a kept chapter out names it by its own number", () => {
    const nodes = weeks();
    nodes[3].covers = [];
    const root = layout(makeRoot(nodes));
    expect(run(root, nodes, false, true).facts).toContain("backbone ch. 8 not reserved");
  });
  it("a reservation naming a chapter the plan cut is a fact, not a breach", () => {
    const nodes = weeks();
    nodes[4].covers = [cover(5), { id: "aie", note: "ch. 3" }];
    const root = layout(makeRoot(nodes));
    const out = run(root, nodes, false, true);
    expect(out.facts).toContain("backbone ch. 3 reserved outside the kept chapters");
    expect(out.breaches).toEqual([]);
  });
  it("days under a week read the cut list's positions, checked against the week's reservation", () => {
    const nodes = weeks();
    const root = layout(makeRoot(nodes));
    const w2 = root.children![1];
    w2.children = [1, 2].map((i) => makeNode({ id: `d${i}`, level: "day", title: `D${i}`, summary: "s", len: 1, materials: [{ id: "aie", tier: "must", minutes: 30, note: null, chapter: 2 }] }));
    layout(root);
    const ok = run(root, w2.children, true, false);
    expect(ok.breaches).toEqual([]);
    expect(ok.facts.filter((f) => f.startsWith("backbone"))).toEqual([]);
    // Position 1 is ch. 5, which week 1 holds: outside week 2's reservation and an overlap, named by the cut list.
    w2.children[1].materials = [{ id: "aie", tier: "must", minutes: 30, note: null, chapter: 1 }];
    const out = run(root, w2.children, true, false);
    expect(out.breaches.map((b) => b.kind)).toEqual(["outside", "overlap"]);
    expect(out.facts).toContain("backbone ch. 5 after ch. 6 (Week 2 · Day 2)");
  });
});

describe("levelChecks", () => {
  const share = { hoursPerWeek: AIE_HOURS, split: { readingShare: AIE_SHARE * 100, practice: "projects", reason: "" }, daysPerWeek: 7 };
  const weeksOf = (root: PlanNode) => root.children![0].children!;
  const read = (chapter: number | null, minutes: number, id = "aie"): MaterialRef => ({ id, tier: "must", minutes, note: null, chapter });
  const check = (root: PlanNode, nodes: PlanNode[], leaves = true, top = false) => levelChecks({ root, nodes, leaves, top, materials: AIE_MATERIALS, unknownIds: [], ...share });
  /** Turns week 1 into a hand-split week whose days read `specs`. */
  const days = (root: PlanNode, specs: { chapter: number | null; minutes?: number; activity?: "read" | "review"; id?: string }[]) => {
    const w1 = weeksOf(root)[0];
    w1.covers = w1.materials!.map((r) => ({ id: r.id, chapter: r.chapter, note: null }));
    delete w1.materials;
    w1.children = specs.map((sp, i) => makeNode({ id: `d${i + 1}`, level: "day", title: `D${i + 1}`, summary: "s", len: 1, materials: [{ ...read(sp.chapter, sp.minutes ?? 20, sp.id), activity: sp.activity }] }));
    layout(root);
    return w1.children;
  };

  it("the fixture as drafted breaches only on weeks 1 and 2's budgets", () => {
    const root = aiePlan();
    const { breaches, facts } = check(root, weeksOf(root));
    expect(breaches.map((b) => b.text)).toEqual([
      "Week 1's must-reading is 247 min against a budget of about 144 min",
      "Week 2's must-reading is 219 min against a budget of about 144 min",
    ]);
    expect(facts).toEqual([]); // reviews do not count as the backbone going backwards
  });
  it("days outside the reservation and overlapping a sibling week are breaches naming the holder", () => {
    const root = aiePlan();
    const placed = days(root, [{ chapter: 1 }, { chapter: 1 }, { chapter: 2 }, { chapter: 2 }, { chapter: 3 }, { chapter: 3 }, { chapter: 4 }]);
    expect(check(root, placed).breaches.map((b) => [b.kind, b.index, b.text])).toEqual([
      ["outside", 4, "Week 1 · Day 5 reads M1.3, which Week 1 did not reserve"],
      ["overlap", 4, "Week 1 · Day 5 reads M1.3, which Week 2 holds"],
      ["outside", 5, "Week 1 · Day 6 reads M1.3, which Week 1 did not reserve"],
      ["overlap", 5, "Week 1 · Day 6 reads M1.3, which Week 2 holds"],
      ["outside", 6, "Week 1 · Day 7 reads M1.4, which Week 1 did not reserve"],
      ["overlap", 6, "Week 1 · Day 7 reads M1.4, which Week 2 holds"],
    ]);
  });
  it("consecutive days may share a chapter too long for one of them; a second week reading one that fits breaches, naming the first", () => {
    const root = aiePlan();
    // Only the reservation's second chapter going unread is reported.
    expect(check(root, days(root, [{ chapter: 1 }, { chapter: 1 }])).breaches.map((b) => b.text)).toEqual(["Week 1 reserved M1.2, which no day reads"]);
    const r2 = aiePlan();
    weeksOf(r2)[1].materials!.push(read(1, 107));
    expect(check(r2, weeksOf(r2)).breaches.map((b) => b.text)).toContain("Week 2 reads M1.1, which Week 1 holds");
  });
  it("a bare book id is a whole-book breach; a review of something unread is a breach; a review of something read is not", () => {
    const root = aiePlan();
    const weeks = weeksOf(root);
    weeks[0].materials!.push(read(null, 30));
    let out = check(root, weeks);
    expect(out.breaches.map((b) => b.text)).toContain("Week 1 refers to M1 as a whole; use its chapters");
    expect(out.breaches.map((b) => b.kind)).not.toContain("review-before-read"); // week 4 reviews ch. 1–4, read by weeks 1–2
    weeks[3].materials!.push({ id: "aie", chapter: 5, tier: "should", minutes: 10, note: null, activity: "review" });
    out = check(root, weeks);
    expect(out.breaches.map((b) => b.text)).toContain("Week 4 reviews M1.5, which no earlier unit reads");
  });
  it("review covers: a child reading under one is outside; a child reviewing under a read cover is fine", () => {
    const root = aiePlan();
    const w4 = weeksOf(root)[3];
    w4.covers = [{ id: "aie", chapter: 1, note: null, activity: "review" }];
    delete w4.materials;
    w4.children = [makeNode({ id: "d1", level: "day", title: "D", summary: "s", len: 1, materials: [read(1, 20)] })];
    layout(root);
    expect(check(root, w4.children).breaches.map((b) => b.kind)).toEqual(["outside", "overlap"]);
    w4.children[0].materials = [{ ...read(1, 20), tier: "should", activity: "review" }];
    expect(check(root, w4.children).breaches).toEqual([]);
  });
  it("a whole-resource cover admits any chapter, as plans saved before chapters did", () => {
    const root = aiePlan();
    const w1 = weeksOf(root)[0];
    w1.covers = [{ id: "aie", note: "Ch. 1; Ch. 2" }];
    delete w1.materials;
    w1.children = [makeNode({ id: "d1", level: "day", title: "D", summary: "s", len: 1, materials: [read(2, 20)] })];
    layout(root);
    expect(check(root, w1.children).breaches).toEqual([]);
  });
  it("a heading over its budget, an unread reservation, and the top level's overlap", () => {
    const root = aiePlan();
    const [m1, m2] = root.children!;
    m2.covers!.push({ id: "aie", chapter: 4, note: null });
    expect(check(root, root.children!, false, true).breaches.map((b) => b.text)).toEqual(["Month 2 reserves M1.4, which Month 1 holds"]);
    // Month 1's four weeks at 6 h/week are 24 h; 40% of it is 576 min, and 545 + 240 + 30 passes 576 × 1.25.
    m1.covers = [...m1.covers!, { id: "rag", note: null }];
    expect(check(root, root.children!, false, true).breaches.map((b) => b.text)).toContain("Month 1 reserves about 815 min of reading against a budget of about 576 min");
    const r2 = aiePlan();
    weeksOf(r2)[1].materials = [read(3, 93)];
    expect(check(r2, weeksOf(r2)).breaches.map((b) => b.text)).toContain("Month 1 reserved M1.4, which no week reads");
  });
  it("an unlisted book is divided by topic: several headings or weeks may hold it, and it is never 'taken'", () => {
    const book = { id: "B", backbone: true, kind: "book" as const };
    const m1 = makeNode({ id: "m1", level: "month", title: "A", summary: "a", len: 28, covers: [{ id: "B", note: "ch. 1–2" }] });
    const m2 = makeNode({ id: "m2", level: "month", title: "B", summary: "b", len: 28, covers: [{ id: "B", note: "ch. 5" }] });
    const root = layout(makeRoot([m1, m2]));
    expect(levelChecks({ root, nodes: [m1, m2], leaves: false, top: true, materials: [book], unknownIds: [], daysPerWeek: 7 }).breaches).toEqual([]);
    const w1 = makeNode({ id: "w1", level: "week", title: "A", summary: "a", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "must", minutes: 60, note: "the chapters on evaluation" }] });
    const w3 = makeNode({ id: "w3", level: "week", title: "C", summary: "c", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "must", minutes: 60, note: "the chapters on agents" }] });
    const w2 = makeNode({ id: "w2", level: "week", title: "B", summary: "b", len: 7, budgetHours: 6, materials: [{ id: "E", tier: "must", minutes: 30, note: null }] });
    const r2 = layout(makeRoot([w1, w2, w3]));
    expect(levelChecks({ root: r2, nodes: [w1, w2, w3], leaves: true, top: true, materials: [book, { id: "E" }], unknownIds: [], daysPerWeek: 7 }).breaches).toEqual([]);
  });
  it("keeps the facts: unknown ids, no must, total over budget, chapter order, and reports the share as a breach", () => {
    const w1 = makeNode({ id: "w1", level: "week", title: "A", summary: "a", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "must", minutes: 400, note: "ch. 3" }] });
    const w2 = makeNode({ id: "w2", level: "week", title: "B", summary: "b", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "should", minutes: 30, note: "ch. 2" }] });
    const root = layout(makeRoot([w1, w2]));
    const out = levelChecks({ root, nodes: [w1, w2], leaves: true, top: true, materials: [{ id: "B", backbone: true }], unknownIds: ["M9"], daysPerWeek: 7 });
    expect(out.facts).toEqual(["dropped unknown M9", "no must: Week 2", "Week 1 over budget: 400 of 360 min", "backbone ch. 2 after ch. 3 (Week 2)"]);
    expect(out.breaches.map((b) => b.text)).toEqual(["Week 1's must-reading is 400 min against a budget of about 216 min"]);
  });
  it("checks days against the learner's hours, and must-reading against the plan's share over the week, not each day", () => {
    const d1 = makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, materials: [{ id: "X", tier: "must", minutes: 45, note: null }] });
    const d2 = makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1, materials: [{ id: "X", tier: "must", minutes: 20, note: null }, { id: "Y", tier: "should", minutes: 40, note: null }] });
    const d3 = makeNode({ id: "d3", level: "day", title: "C", summary: "c", len: 1, materials: [{ id: "X", tier: "must", minutes: 15, note: null }] });
    const root = layout(makeRoot([d1, d2, d3]));
    const base = { root, nodes: [d1, d2, d3], leaves: true, top: true, materials: [{ id: "X" }, { id: "Y" }], unknownIds: [], daysPerWeek: 7 };
    // Without hours, a day has no budget to check.
    expect(levelChecks(base)).toEqual({ facts: [], breaches: [] });
    // Six hours a week is 50 minutes a day; a 30% reading share is 108 of the week's 360. Day 1's 45 min of must is
    // more than 30% of its day, but the week's 80 min fit.
    const out = levelChecks({ ...base, hoursPerWeek: 6, split: { readingShare: 30, practice: "projects", reason: "" } });
    expect(out.facts).toEqual(["Day 2 over budget: 60 of 50 min", "Week 1 should-reading is 40 min, more than the 28 min must-reading leaves of the reading budget"]);
    expect(out.breaches).toEqual([]);
    // No split yet: the default share stands in, 216 min of the week.
    expect(levelChecks({ ...base, hoursPerWeek: 6, split: null })).toEqual({ facts: ["Day 2 over budget: 60 of 50 min"], breaches: [] });
  });
  it("continues chapter order from leaves earlier in the plan", () => {
    const d1 = makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, materials: [{ id: "B", tier: "must", minutes: 30, note: "ch. 4" }] });
    const d2 = makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1, materials: [{ id: "B", tier: "must", minutes: 30, note: "ch. 2" }] });
    const root = layout(makeRoot([makeNode({ id: "w1", level: "week", title: "W1", summary: "s", len: 1, children: [d1] }), makeNode({ id: "w2", level: "week", title: "W2", summary: "s", len: 1, children: [d2] })]));
    expect(levelChecks({ root, nodes: [root.children![1].children![0]], leaves: true, top: false, materials: [{ id: "B", backbone: true }], unknownIds: [], daysPerWeek: 7 }).facts).toEqual([
      "backbone ch. 2 after ch. 4 (Week 2 · Day 1)",
    ]);
  });
  it("a day may read what its week reserved even when sibling weeks share it, as a resource too long for one week", () => {
    const root = aiePlan();
    const m3 = root.children![2];
    // Month 3 planned into three weeks that each read a part of the 240-minute course; week 1 split into days.
    m3.covers = [{ id: "rag", note: null }, { id: "agents", note: null }, ...(m3.covers ?? [])];
    const week = (id: string, note: string, extra: MaterialRef[] = []) =>
      makeNode({ id, level: "week", title: id, summary: "s", len: 7, budgetHours: 6, materials: [{ id: "rag", tier: "must", minutes: 80, note }, ...extra] });
    m3.children = [week("x1", "part 1"), week("x2", "part 2", [{ id: "agents", tier: "should", minutes: 12, note: null }]), week("x3", "part 3")];
    const w1 = m3.children[0];
    w1.covers = w1.materials!.map((r) => ({ id: r.id, note: r.note }));
    delete w1.materials;
    const day = (i: number, rows: MaterialRef[]) => makeNode({ id: `x1d${i}`, level: "day", title: "D", summary: "s", len: 1, materials: rows });
    w1.children = [1, 2, 3].map((i) => day(i, [{ id: "rag", tier: "must", minutes: 25, note: "part 1" }]));
    layout(root);
    expect(check(root, w1.children).breaches).toEqual([]);
    // What the week did not reserve is still outside, and still held by week 2.
    w1.children[2].materials!.push({ id: "agents", tier: "should", minutes: 12, note: null });
    expect(check(root, w1.children).breaches.map((b) => b.kind)).toEqual(["outside", "overlap"]);
  });
  it("a chapter spanning two weeks is not lost when the first week is split", () => {
    const materials = AIE_MATERIALS.map((m) => (m.id === "aie" ? { ...m, toc: { ...AIE_TOC, chapters: AIE_TOC.chapters.map((c) => (c.n === 2 ? { ...c, minutes: 300 } : c)) } } : m));
    const root = aiePlan();
    const weeks = weeksOf(root);
    weeks[0].materials = [read(1, 107), read(2, 150)];
    weeks[1].materials = [read(2, 150), read(3, 93)];
    weeks[0].covers = weeks[0].materials.map((r) => ({ id: r.id, chapter: r.chapter, note: null }));
    delete weeks[0].materials;
    weeks[0].children = [1, 2, 3, 4].map((i) => makeNode({ id: `d${i}`, level: "day", title: "D", summary: "s", len: 1, materials: [read(i < 3 ? 1 : 2, 20)] }));
    layout(root);
    const out = levelChecks({ root, nodes: weeks[0].children, leaves: true, top: false, materials, unknownIds: [], ...share });
    expect(out.breaches.filter((b) => b.kind === "overlap")).toEqual([]);
  });
  it("dropBreaches removes the rows of droppable breaches and reports them", () => {
    const root = aiePlan();
    const placed = days(root, [{ chapter: 1 }, { chapter: 3 }]);
    const { breaches } = check(root, placed);
    expect(dropBreaches(placed, breaches)).toEqual(["dropped M1.3 from Week 1 · Day 2: outside", "dropped M1.3 from Week 1 · Day 2: overlap"]);
    expect(placed[1].materials).toBeUndefined();
  });
  it("treeChecks judges a mixed group of leaf weeks by level and granularity, not by children", () => {
    const root = aiePlan();
    const [m1, m2] = root.children!;
    const weeks = weeksOf(root);
    // Week 1 split by hand: covers plus days. Weeks 2 and 3 share the 240-minute course, longer than a week's reading.
    weeks[0].covers = weeks[0].materials!.map((r) => ({ id: r.id, chapter: r.chapter, note: null }));
    delete weeks[0].materials;
    weeks[0].children = [makeNode({ id: "d1", level: "day", title: "D", summary: "s", len: 7, materials: [read(1, 107), read(2, 140)] })];
    m1.covers!.push({ id: "rag", note: null });
    m2.covers = m2.covers!.filter((r) => r.id !== "rag");
    weeks[1].materials!.push(read(null, 120, "rag"));
    weeks[2].materials!.push(read(null, 120, "rag"));
    layout(root);
    const out = treeChecks(root, AIE_MATERIALS, { granularity: "week", ...share });
    expect(out.breaches.map((b) => b.text)).not.toContain("Week 3 reads M5, which Week 2 holds");
    expect(out.breaches.map((b) => b.text)).toContain("Week 2's must-reading is 339 min against a budget of about 144 min");
  });
  it("a saved whole-book row whose note names chapters is neither a whole-book breach nor charged the whole book", () => {
    const root = aiePlan();
    const [m1] = root.children!;
    m1.covers = [{ id: "aie", note: "ch. 1–4" }, { id: "evals", note: null }, { id: "oaievals", note: null }];
    const out = check(root, root.children!, false, true);
    expect(out.breaches.map((b) => b.kind)).not.toContain("whole-book");
    expect(out.breaches.map((b) => b.kind)).not.toContain("over-budget"); // 466 + 109 min against 576 × 1.25, not 1105 + 109
  });
  it("an unlisted sized book reserved by topic is not charged in full to every heading", () => {
    const book = { id: "B", backbone: true, kind: "book" as const, minutes: 1105 };
    const months = [1, 2, 3].map((i) => makeNode({ id: `m${i}`, level: "month", title: `M${i}`, summary: "s", len: 30, covers: [{ id: "B", note: `part ${i}` }] }));
    const root = layout(makeRoot(months));
    expect(levelChecks({ root, nodes: months, leaves: false, top: true, materials: [book], unknownIds: [], ...share }).breaches).toEqual([]);
  });
  it("treeChecks runs every sibling group", () => {
    const root = aiePlan();
    weeksOf(root)[1].materials!.push(read(1, 107));
    const out = treeChecks(root, AIE_MATERIALS, { granularity: "week", ...share });
    // The months leave ch. 7–9 out, but the backbone's size has no measured basis, so it is not held to a budget.
    expect(out.breaches.map((b) => b.text)).toEqual([
      "Week 1's must-reading is 247 min against a budget of about 144 min",
      "Week 2 reads M1.1, which Week 1 holds",
      "Week 2's must-reading is 326 min against a budget of about 144 min",
    ]);
    expect(out.facts).toContain("backbone ch. 7, 8, 9 not reserved");
    expect(out.nodes[out.breaches[1].index].id).toBe("w2");
  });
});

describe("budget-miss", () => {
  const tocOf = (minutes: (number | null)[]) => ({ source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: minutes.map((m, i) => ({ n: i + 1, title: `U${i + 1}`, page: null, minutes: m, sections: [] })) });
  const UNITS = [3, 5, 2, 10, 8, 8, 4, 8]; // 48 min in all
  const primer = (units: (number | null)[] = UNITS, budget: number | null = 50) => ({ id: "P", kind: "docs" as const, minutes: budget, toc: tocOf(units) });
  /** Top-level weeks, each reserving the listed units of `material` (M2, after an essay). */
  const weeks = (byWeek: number[][], id = "P") => byWeek.map((units, i) => makeNode({ id: `w${i + 1}`, level: "week", title: `W${i + 1}`, summary: "s", len: 7, covers: units.map((chapter) => ({ id, note: null, chapter })) }));
  const check = (byWeek: number[][], material: { id: string; kind?: "docs" | "repo"; minutes: number | null; toc: ReturnType<typeof tocOf> } = primer(), top = true) => {
    const nodes = weeks(byWeek, material.id);
    const root = layout(makeRoot(nodes));
    return { nodes, ...levelChecks({ root, nodes, leaves: false, top, materials: [{ id: "E", minutes: 30 }, material], unknownIds: [], daysPerWeek: 7 }) };
  };
  const misses = (out: { breaches: { kind: string; text: string }[] }) => out.breaches.filter((b) => b.kind === "budget-miss").map((b) => b.text);

  it("units reserved across weeks that add up to about the budget are no miss", () => {
    expect(check([[1, 2, 3], [4, 5], [6, 7, 8]]).breaches).toEqual([]);
  });
  it("units falling short of the budget by more than its slack are one miss for the plan", () => {
    const out = check([[1, 2], [3, 4]]);
    expect(out.breaches.filter((b) => b.kind === "budget-miss")).toEqual([
      { kind: "budget-miss", index: -1, unit: "The plan", refs: [], names: "", text: "M2's units reserved add up to about 20 min against its budget of about 50 min" },
    ]);
  });
  it("the slack is the larger of 20% of the budget and 15 minutes", () => {
    expect(misses(check([[1, 2, 3], [4, 5, 6]]))).toEqual([]); // 36 of 50: off by 14
    expect(misses(check([[1], [2], [3]], primer([100, 100, 45], 300)))).toEqual([]); // off by 55, slack 60
    expect(misses(check([[1], [2], [3]], primer([100, 100, 39], 300)))).toEqual(["M2's units reserved add up to about 239 min against its budget of about 300 min"]);
  });
  it("a budget with none of its units reserved is a miss", () => {
    expect(misses(check([[], []]))).toEqual(["M2 has a budget of about 50 min but none of its units is reserved"]);
  });
  it("is not checked for units without sizes, or below the top level", () => {
    expect(check([[], []], primer([null, null, null])).breaches).toEqual([]);
    expect(misses(check([[1, 2], [3, 4]], primer(), false))).toEqual([]);
  });
  it("is not checked for a book whose size is an estimate: its chapters are shares of that estimate and never cap its budget", () => {
    // Every chapter reserved (48 min) against a budget of 120 the allocation was free to give: no reservation could meet it.
    const book = (minutesBasis: "estimated" | "measured") => ({ id: "B", kind: "book" as const, minutes: 120, minutesBasis, toc: tocOf(UNITS) });
    const all = [[1, 2, 3], [4, 5], [6, 7, 8]];
    const run = (m: ReturnType<typeof book>) =>
      misses(levelChecks({ root: layout(makeRoot(weeks(all, "B"))), nodes: weeks(all, "B"), leaves: false, top: true, materials: [{ id: "E", minutes: 30 }, m], unknownIds: [], daysPerWeek: 7 }));
    expect(run(book("estimated"))).toEqual([]);
    expect(run(book("measured"))).toEqual(["M2's units reserved add up to about 48 min against its budget of about 120 min"]);
  });
  it("is not checked when any unit is unsized: an unsized unit would count 0 and the miss could not be cured", () => {
    // Every unit reserved: the sized ones count 40 min against a budget of 60 that the unsized unit makes up.
    const hub = primer([3, 5, 2, 10, null, 8, 4, 8], 60);
    expect(misses(check([[1, 2, 3], [4, 5], [6, 7, 8]], hub))).toEqual([]);
    expect(misses(check([[1], [2]], hub))).toEqual([]);
  });
  it("is not droppable: no row can be removed to cure it", () => {
    expect(DROPPABLE.has("budget-miss")).toBe(false);
    const out = check([[1, 2], [3, 4]]);
    expect(dropBreaches(out.nodes, out.breaches)).toEqual([]);
    expect(out.nodes.map((n) => n.covers!.map((c) => c.chapter))).toEqual([[1, 2], [3, 4]]);
  });
  it("a material with units of any kind reserved as a whole is a whole-book breach naming its units", () => {
    const repo = { id: "R", kind: "repo" as const, minutes: null, toc: tocOf([20, 20]) };
    const nodes = [makeNode({ id: "w1", level: "week", title: "W1", summary: "s", len: 7, covers: [{ id: "R", note: null }] })];
    const root = layout(makeRoot(nodes));
    const out = levelChecks({ root, nodes, leaves: false, top: true, materials: [{ id: "E", minutes: 30 }, repo], unknownIds: [], daysPerWeek: 7 });
    expect(out.breaches.map((b) => [b.kind, b.text])).toEqual([["whole-book", "Week 1 refers to M2 as a whole; use its units"]]);
  });
});

describe("unitless span", () => {
  // Six hours a week at a 25% reading share: about 90 min of reading a week.
  const split = { readingShare: 25, practice: "projects", reason: "" };
  const materials = [
    { id: "C", kind: "course" as const, minutes: 180 },
    { id: "S", kind: "essay" as const, minutes: 40 },
    { id: "X", kind: "essay" as const, minutes: 30 },
  ];
  const weeks = (byWeek: string[][]) => byWeek.map((ids, i) => makeNode({ id: `w${i + 1}`, level: "week", title: `W${i + 1}`, summary: "s", len: 7, covers: ids.map((id) => ({ id, note: `part ${i + 1}` })) }));
  const check = (byWeek: string[][]) => {
    const nodes = weeks(byWeek);
    const root = layout(makeRoot(nodes));
    return levelChecks({ root, nodes, leaves: false, top: true, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 7, split });
  };
  const texts = (out: { breaches: { kind: string; text: string }[] }, kind: string) => out.breaches.filter((b) => b.kind === kind).map((b) => b.text);

  it("a source longer than a week's reading may span consecutive weeks, each counting its share", () => {
    expect(check([["C"], ["C"], []]).breaches).toEqual([]);
    // 90 of the course's 180 min in each week: an essay more passes the week's 90 × 1.25.
    expect(texts(check([["C", "X"], ["C"], []]), "over-budget")).toEqual(["Week 1 reserves about 120 min of reading against a budget of about 90 min"]);
    expect(texts(check([["C"], ["C", "X"], []]), "over-budget")).toEqual(["Week 2 reserves about 120 min of reading against a budget of about 90 min"]);
  });
  it("a repeat that skips a week is an overlap on the later holder", () => {
    expect(texts(check([["C"], [], ["C"]]), "overlap")).toEqual(["Week 3 reserves M1, which Week 1 holds"]);
  });
  it("a source within one week's reading may not span", () => {
    expect(texts(check([["S"], ["S"], []]), "overlap")).toEqual(["Week 2 reserves M2, which Week 1 holds"]);
  });
  it("a span is still an overlap with a unit outside this level that holds the source", () => {
    const m1 = makeNode({ id: "m1", level: "month", title: "M1", summary: "s", len: 14, children: weeks([["C"], ["C"]]) });
    const m2 = makeNode({ id: "m2", level: "month", title: "M2", summary: "s", len: 28, covers: [{ id: "C", note: null }] });
    const root = layout(makeRoot([m1, m2]));
    const out = levelChecks({ root, nodes: m1.children!, leaves: false, top: false, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 7, split });
    expect(texts(out, "overlap")).toEqual(["Week 1 reserves M1, which Month 2 holds", "Week 2 reserves M1, which Month 2 holds"]);
  });
});

describe("sizeChapterRows", () => {
  const row = (chapter: number, minutes: number, activity: "read" | "review" = "read"): MaterialRef => ({ id: "aie", tier: "must", minutes, note: null, chapter, activity });
  const day = (id: string, rows: MaterialRef[]) => makeNode({ id, level: "day", title: id, summary: "s", len: 1, materials: rows });
  it("rescales a shared chapter to its size, keeping proportions, remainder to the last row", () => {
    const nodes = [day("a", [row(1, 20)]), day("b", [row(1, 20)]), day("c", [row(1, 20)])];
    sizeChapterRows(nodes, AIE_MATERIALS);
    expect(nodes.map((n) => n.materials![0].minutes)).toEqual([36, 36, 35]);
    const skew = [day("a", [row(2, 10)]), day("b", [row(2, 30)])];
    sizeChapterRows(skew, AIE_MATERIALS);
    expect(skew.map((n) => n.materials![0].minutes)).toEqual([35, 105]);
  });
  it("splits evenly when the model wrote zeros, leaves reviews and unsized chapters alone", () => {
    const nodes = [day("a", [row(3, 0), row(1, 25, "review")]), day("b", [row(3, 0)])];
    sizeChapterRows(nodes, AIE_MATERIALS);
    expect(nodes.map((n) => n.materials!.map((r) => r.minutes))).toEqual([[47, 25], [46]]);
    const unsized = [day("a", [row(1, 20)])];
    sizeChapterRows(unsized, [{ id: "aie", toc: { ...AIE_TOC, chapters: AIE_TOC.chapters.map((c) => ({ ...c, minutes: null })) } }]);
    expect(unsized[0].materials![0].minutes).toBe(20);
  });
});

describe("keptReadTable", () => {
  it("reads a split week's Read table back from its reservation", () => {
    expect(
      keptReadTable([
        { id: "M1", note: null, chapter: 2, tier: "must", minutes: 140 },
        { id: "M3", note: "§2", activity: "review", tier: "should" },
      ]),
    ).toEqual([
      { id: "M1", note: null, chapter: 2, tier: "must", minutes: 140 },
      { id: "M3", note: "§2", activity: "review", tier: "should", minutes: null },
    ]);
  });
  it("is empty for a heading's reservation and a week split before tiers were kept", () => {
    expect(keptReadTable([{ id: "M1", note: "ch. 1–2" }])).toEqual([]);
    expect(keptReadTable(undefined)).toEqual([]);
  });
});

describe("tree edits", () => {
  const tree = () =>
    makeRoot([
      makeNode({ id: "m1", level: "month", title: "A", summary: "a", len: 7, covers: [{ id: "M1", note: null }, { id: "M2", note: null }], children: [
        makeNode({ id: "d1", level: "day", title: "D", summary: "d", len: 7, materials: [{ id: "M1", tier: "must", minutes: 30, note: null }] }),
      ] }),
    ]);

  it("lists where a material is used", () => {
    expect(assignmentsOf(tree(), "M1").map((a) => [a.label, a.role])).toEqual([
      ["Month 1", "covers"],
      ["Day 1", "assigned"],
    ]);
  });

  it("removes every reference to a material", () => {
    const next = removeMaterialRefs(tree(), "M1");
    expect(assignmentsOf(next, "M1")).toEqual([]);
    expect(next.children![0].covers).toEqual([{ id: "M2", note: null }]);
    expect(next.children![0].children![0].materials).toBeUndefined();
  });

  it("maps short ids to uuids and drops references to unknown ids", () => {
    const { root, dropped } = remapTreeRefs(tree(), new Map([["M1", "uuid-1"]]));
    expect(dropped).toBe(1);
    expect(root.children![0].covers).toEqual([{ id: "uuid-1", note: null }]);
    expect(root.children![0].children![0].materials?.[0].id).toBe("uuid-1");
  });

  it("removes a material's practice rows and reservations but keeps generated rows", () => {
    const root = makeRoot([
      makeNode({ id: "m1", level: "month", title: "A", summary: "a", len: 7, practiceCovers: [{ format: "problem-set", id: "M4", note: null }, { format: "lab", id: "M5", note: null }], children: [
        makeNode({
          id: "d1",
          level: "day",
          title: "D",
          summary: "d",
          len: 7,
          practice: [
            { format: "problem-set", id: "M4", task: "t", done: "d", minutes: 20, generated: false },
            { format: "recall", id: null, task: "t", done: "d", minutes: 10, generated: true },
          ],
        }),
      ] }),
      makeNode({ id: "m2", level: "month", title: "B", summary: "b", len: 7, practiceCovers: [{ format: "problem-set", id: "M4", note: null }] }),
    ]);
    const next = removeMaterialRefs(root, "M4");
    expect(next.children![0].practiceCovers).toEqual([{ format: "lab", id: "M5", note: null }]);
    expect(next.children![0].children![0].practice).toEqual([{ format: "recall", id: null, task: "t", done: "d", minutes: 10, generated: true }]);
    expect(next.children![1].practiceCovers).toBeUndefined();
  });

  it("maps practice ids to uuids, keeps generated rows and drops unknown sources", () => {
    const root = makeRoot([
      makeNode({ id: "m1", level: "month", title: "A", summary: "a", len: 7, practiceCovers: [{ format: "problem-set", id: "M4", note: null }, { format: "lab", id: "M9", note: null }], children: [
        makeNode({
          id: "d1",
          level: "day",
          title: "D",
          summary: "d",
          len: 7,
          practice: [
            { format: "problem-set", id: "M4", task: "t", done: "d", minutes: 20, generated: false },
            { format: "recall", id: null, task: "t", done: "d", minutes: 10, generated: true },
            { format: "lab", id: "M9", task: "t", done: "d", minutes: 10, generated: false },
          ],
        }),
      ] }),
    ]);
    const { root: next, dropped } = remapTreeRefs(root, new Map([["M4", "uuid-4"]]));
    expect(dropped).toBe(2);
    expect(next.children![0].practiceCovers).toEqual([{ format: "problem-set", id: "uuid-4", note: null }]);
    expect(next.children![0].children![0].practice!.map((r) => r.id)).toEqual(["uuid-4", null]);
  });

  it("sums minutes by tier", () => {
    expect(tierMinutes([{ id: "a", tier: "must", minutes: 30, note: null }, { id: "b", tier: "should", minutes: null, note: null }, { id: "c", tier: "should", minutes: 15, note: null }])).toEqual({ must: 30, should: 15 });
  });
});

describe("learnerMaterials", () => {
  it("turns the learner's sources into unverified materials with short ids", () => {
    const out = learnerMaterials([
      { url: "https://doc.rust-lang.org/book/", type: "link", title: "The Rust Book" },
      { url: "https://www.youtube.com/watch?v=eIho2S0ZahI", type: "youtube" },
      { url: "ml-course-notes.pdf", type: "file", title: "ml-course-notes.pdf" },
      { url: "The Psychology of Money", type: "note" },
      { url: "https://github.com/foo/bar", type: "link" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    expect(out.map((m) => m.kind)).toEqual(["docs", "video", "note", "note", "repo"]);
    expect(out.map((m) => m.title)).toEqual(["The Rust Book", "youtube.com", "ml-course-notes.pdf", "The Psychology of Money", "github.com"]);
    for (const m of out) {
      expect(m.origin).toBe("learner");
      expect(m.verifiedAt).toBeNull();
      expect(m.sig).toBeNull();
      expect(m.backbone).toBe(false);
    }
  });

  it("keeps one material per url", () => {
    const out = learnerMaterials([{ url: "https://example.com/a", type: "link" }, { url: "https://example.com/a", type: "link", title: "Again" }]);
    expect(out).toHaveLength(1);
  });
});

describe("practice rows and reservations", () => {
  const source = (format: "problem-set" | "lab" | "recall") => ({ format, items: 150, perItemMinutes: 10, minutes: null, answers: true });
  // M1 is reading, M2 a problem list, M3 a lab, M4 more reading.
  const aliases = aliasMaterials([{ id: "book" }, { id: "neet", practice: source("problem-set") }, { id: "git-lab", practice: source("lab") }, { id: "essay" }]);
  const split = {
    readingShare: 50,
    practice: "problems and recall",
    reason: "",
    formats: [
      { format: "problem-set" as const, share: 60, focus: "arrays", reason: "" },
      { format: "recall" as const, share: 40, focus: "key terms", reason: "" },
    ],
  };

  it("keeps a sourced row under the material's real id and bounds what the model wrote", () => {
    const { refs, unknown, refused } = resolvePracticeRefs([{ format: "Problem-Set", id: "M2", task: " Arrays 1–6 ", done: "all pass", minutes: 42.4 }], aliases, split);
    expect(refs).toEqual([{ format: "problem-set", id: "neet", task: "Arrays 1–6", done: "all pass", minutes: 42, generated: false }]);
    expect(unknown).toEqual([]);
    expect(refused).toEqual([]);
  });
  it("refuses a problem-set row with no id: problems are never written by the drafter", () => {
    const { refs, refused } = resolvePracticeRefs([{ format: "problem-set", task: "Five array problems", done: "solved", minutes: 30 }], aliases, split);
    expect(refs).toEqual([]);
    expect(refused).toEqual(['Problems "Five array problems": no source, and this format is never written']);
  });
  it("accepts a generated recall row whose id is the unit's reading, and refuses one citing other reading", () => {
    const drafts = [
      { format: "recall", id: "M1.2", task: "Six questions on sampling", done: "checked against ch. 2", minutes: 18 },
      { format: "recall", id: "M4", task: "Questions on the essay", done: "checked", minutes: 9 },
      { format: "recall", task: "Questions from nowhere", done: "checked", minutes: 9 },
    ];
    const { refs, refused } = resolvePracticeRefs(drafts, aliasMaterials([{ id: "book", toc: { source: "catalogue", url: "u", printPages: false, end: null, chapters: [1, 2, 3].map((n) => ({ n, title: `C${n}`, page: null, minutes: null, sections: [] })) } }, { id: "neet", practice: source("problem-set") }, { id: "git-lab", practice: source("lab") }, { id: "essay" }]), split, ["book"]);
    expect(refs).toEqual([{ format: "recall", id: "book", task: "Six questions on sampling", done: "checked against ch. 2", minutes: 18, generated: true }]);
    expect(refused).toEqual(['Recall "Questions on the essay": not written from this unit\'s reading', 'Recall "Questions from nowhere": not written from this unit\'s reading']);
  });
  it("keeps a generated recall row citing a dual-role book on the unit's Read list, chapter or whole, whatever its practice role", () => {
    const chapters = { source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: [1, 2, 3].map((n) => ({ n, title: `C${n}`, page: null, minutes: null, sections: [] })) };
    // M1 is a book read as reading that also serves as a problem list.
    const dual = aliasMaterials([{ id: "book", toc: chapters, practice: source("problem-set") }, { id: "neet", practice: source("problem-set") }]);
    const drafts = [
      { format: "recall", id: "M1.2", task: "Six questions on ch. 2", done: "checked against ch. 2", minutes: 15 },
      { format: "recall", id: "M1", task: "Questions on the book", done: "checked", minutes: 10 },
      { format: "recall", id: "M2", task: "Recall the patterns", done: "checked", minutes: 10 },
    ];
    const { refs, refused } = resolvePracticeRefs(drafts, dual, split, ["book"]);
    expect(refs.map((r) => [r.id, r.generated])).toEqual([
      ["book", true],
      ["book", true],
    ]);
    expect(refused).toEqual(['Recall "Recall the patterns": M2 serves Problems, not Recall']);
  });
  it("refuses a format the split did not pick, and reports an id not in the list as unknown", () => {
    const { refs, unknown, refused } = resolvePracticeRefs(
      [
        { format: "lab", id: "M3", task: "Branching lab", done: "the lab's check passes", minutes: 30 },
        { format: "problem-set", id: "M9", task: "Problems", done: "solved", minutes: 30 },
      ],
      aliases,
      split,
    );
    expect(refs).toEqual([]);
    expect(refused).toEqual(['Lab "Branching lab": not one of the plan\'s picks']);
    expect(unknown).toEqual(["M9"]);
    expect(resolvePracticeRefs([{ format: "problem-set", id: "M2", task: "t", done: "d", minutes: 5 }], aliases, null).refused).toHaveLength(1);
  });
  it("refuses a sourced row whose id is reading, not a practice source", () => {
    const { refs, refused } = resolvePracticeRefs([{ format: "problem-set", id: "M4", task: "The essay's exercises", done: "solved", minutes: 20 }], aliases, split);
    expect(refs).toEqual([]);
    expect(refused).toEqual(['Problems "The essay\'s exercises": M4 is not a practice source']);
  });
  it("refuses a sourced row whose source serves another format", () => {
    const both = { ...split, formats: [...split.formats, { format: "lab" as const, share: 20, focus: "git", reason: "" }] };
    const { refs, refused } = resolvePracticeRefs(
      [
        { format: "problem-set", id: "M3", task: "Branching problems", done: "solved", minutes: 20 },
        { format: "recall", id: "M2", task: "Recall the array patterns", done: "checked", minutes: 10 },
      ],
      aliases,
      both,
      ["book"],
    );
    expect(refs).toEqual([]);
    expect(refused).toEqual(['Problems "Branching problems": M3 serves Lab, not Problems', 'Recall "Recall the array patterns": M2 serves Problems, not Recall']);
  });
  it("drops a reservation whose source serves another format into unknown", () => {
    const both = { ...split, formats: [...split.formats, { format: "lab" as const, share: 20, focus: "git", reason: "" }] };
    const { refs, unknown } = resolvePracticeCovers([{ format: "problem-set", id: "M3", note: "Branching" }, { format: "lab", id: "M3" }], aliases, both);
    expect(refs).toEqual([{ format: "lab", id: "git-lab", note: null }]);
    expect(unknown).toEqual(["M3"]);
  });
  it("reserves practice sources of picked formats, and drops a cover that is not a pick or not a source into unknown", () => {
    const { refs, unknown } = resolvePracticeCovers(
      [
        { format: "problem-set", id: "M2", note: " Arrays & Hashing " },
        { format: "lab", id: "M3" },
        { format: "problem-set", id: "M1" },
        { format: "problem-set", id: "M7" },
      ],
      aliases,
      split,
    );
    expect(refs).toEqual([{ format: "problem-set", id: "neet", note: "Arrays & Hashing" }]);
    expect(unknown).toEqual(["M3", "M1", "M7"]);
  });
});

describe("practice budgets", () => {
  const split = {
    readingShare: 50,
    practice: "problems, recall and lab",
    reason: "",
    formats: [
      { format: "problem-set" as const, share: 50, focus: "arrays", reason: "" },
      { format: "recall" as const, share: 25, focus: "terms", reason: "" },
      { format: "lab" as const, share: 25, focus: "git", reason: "" },
    ],
  };
  const materials = [{ id: "book" }, { id: "neet", practice: { format: "problem-set" as const, items: 10, perItemMinutes: 10, minutes: null, answers: true } }];
  it("gives a pick that can't be assigned back to reading, and says so", () => {
    // Recall has no source but may be written from the reading; Lab has none and is never written.
    expect(practiceBudgets(split, 360, materials)).toEqual({ reading: 225, practice: { "problem-set": 90, recall: 45 } });
    expect(noSourceFacts(split, materials)).toEqual(["no source for Lab: its time goes to reading"]);
    expect(noSourceFacts(null, materials)).toEqual([]);
  });
  it("without picks, reads the split's share of the week, or the default share before a split", () => {
    expect(practiceBudgets({ readingShare: 40, practice: "projects", reason: "" }, 360, materials)).toEqual({ reading: 144, practice: {} });
    expect(practiceBudgets({ readingShare: 100, practice: "reading", reason: "", formats: [] }, 360, materials)).toEqual({ reading: 360, practice: {} });
    expect(practiceBudgets(null, 360, materials)).toEqual({ reading: 216, practice: {} });
  });
  it("keeps recall's share when the only reading on the list is a book that also serves as practice", () => {
    const dual = [{ id: "book", minutes: 600, practice: { format: "problem-set" as const, items: 10, perItemMinutes: 10, minutes: null, answers: true } }];
    expect(practiceBudgets(split, 360, dual)).toEqual({ reading: 225, practice: { "problem-set": 90, recall: 45 } });
    expect(noSourceFacts(split, dual)).toEqual(["no source for Lab: its time goes to reading"]);
  });
  it("shows the time card a pick that can't be assigned as reading, not as hours of its own", () => {
    // 72 h at 50% reading: 36 h of reading, then problems 18 h, recall 9 h and lab 9 h; the lab has no source.
    expect(splitHours(split, 72, materials)).toEqual({
      reading: 45,
      picks: [
        { format: "problem-set", label: "Problems", hours: 18, focus: "arrays", toReading: false },
        { format: "recall", label: "Recall", hours: 9, focus: "terms", toReading: false },
        { format: "lab", label: "Lab", hours: 0, focus: "git", toReading: true },
      ],
    });
    expect(splitHours({ readingShare: 60, practice: "projects", reason: "" }, 72, materials)).toEqual({ reading: 43, picks: [] });
  });
  it("states the split as drafted: a pick that can't be assigned is reading, and the others keep their proportions", () => {
    // Lab's 25% of the practice half is reading: 50 + 12.5 → 63%. Problems and recall split the rest 2:1.
    const drafted = draftedSplit(split, materials);
    expect(drafted.readingShare).toBe(63);
    expect(drafted.formats?.map((p) => [p.format, p.share])).toEqual([["problem-set", 67], ["recall", 33]]);
    expect(draftedSplit({ ...split, formats: [split.formats![2]] }, materials)).toMatchObject({ readingShare: 100, formats: [] });
    // Nothing to fold: the split comes back as it is.
    expect(draftedSplit({ readingShare: 60, practice: "projects", reason: "" }, materials)).toEqual({ readingShare: 60, practice: "projects", reason: "" });
  });
  it("asks for no practice once the learner slides the share to all reading, and refuses a row written anyway", () => {
    const all = { ...split, readingShare: 100 };
    expect(pickSources(all, materials)).toEqual([]);
    expect(practiceBudgets(all, 360, materials)).toEqual({ reading: 360, practice: {} });
    expect(noSourceFacts(all, materials)).toEqual([]);
    const { refs, refused } = resolvePracticeRefs([{ format: "problem-set", id: "M2", task: "Arrays 1–6", done: "all pass", minutes: 40 }], aliasMaterials(materials), all);
    expect(refs).toEqual([]);
    expect(refused).toHaveLength(1);
  });
  it("keeps an all-reading pick all reading whatever its share says", () => {
    // The pick chose no practice; a share below 100 has no format to give the rest to.
    expect(practiceBudgets({ readingShare: 60, practice: "reading", reason: "", formats: [] }, 360, materials)).toEqual({ reading: 360, practice: {} });
  });
  it("gives recall's time to reading when the list has no reading to write it from", () => {
    const practiceOnly = [materials[1]];
    expect(practiceBudgets(split, 360, practiceOnly)).toEqual({ reading: 270, practice: { "problem-set": 90 } });
    expect(noSourceFacts(split, practiceOnly)).toEqual(["no source for Recall: its time goes to reading", "no source for Lab: its time goes to reading"]);
  });
});

describe("checks over the week", () => {
  const problems = { format: "problem-set" as const, items: 150, perItemMinutes: 10, minutes: null, answers: true };
  // Reading R1–R4, problem lists P (reserved by the week) and Q (not reserved).
  const materials = [{ id: "R1" }, { id: "R2" }, { id: "R3" }, { id: "R4" }, { id: "P", practice: problems }, { id: "Q", practice: problems }];
  const split = {
    readingShare: 50,
    practice: "problems and mocks",
    reason: "",
    formats: [
      { format: "problem-set" as const, share: 50, focus: "arrays", reason: "" },
      { format: "mock" as const, share: 50, focus: "interviews", reason: "" },
    ],
  };
  const must = (id: string, minutes: number): MaterialRef => ({ id, tier: "must", minutes, note: null });
  const solve = (task: string, minutes: number, id = "P"): PracticeRef => ({ format: "problem-set", id, task, done: "solved", minutes, generated: id === null });
  const mock: PracticeRef = { format: "mock", id: null, task: "A 60-minute mock interview", done: "scored against the rubric", minutes: 75, generated: true };
  /** A one-week plan of these days, the week reserving P for problems. */
  const week = (days: { materials?: MaterialRef[]; practice?: PracticeRef[] }[], len = days.length) => {
    const children = days.map((d, i) => makeNode({ id: `d${i + 1}`, level: "day", title: `D${i + 1}`, summary: "s", len: 1, ...d }));
    const w1 = makeNode({ id: "w1", level: "week", title: "W", summary: "s", len, children, practiceCovers: [{ format: "problem-set", id: "P", note: "Arrays" }] });
    const root = layout(makeRoot([w1]));
    return { root, days: w1.children! };
  };
  // Six hours over five days: 360 min a week, 70 a day; 180 of reading, 90 of problems and 90 of mocks.
  const check = (root: PlanNode, nodes: PlanNode[], hoursPerWeek = 6) =>
    levelChecks({ root, nodes, leaves: true, top: false, materials, unknownIds: [], hoursPerWeek, daysPerWeek: 5, split });

  it("passes a week with an all-reading day and a 75-minute mock day", () => {
    const { root, days } = week([
      { materials: [must("R1", 70)] },
      { materials: [must("R2", 40)], practice: [solve("Arrays 1–3", 30)] },
      { practice: [mock] },
      { materials: [must("R3", 40)], practice: [solve("Arrays 4–6", 30)] },
      { materials: [must("R4", 30)], practice: [solve("Arrays 7–9", 30)] },
    ]);
    // The mock runs 5 min past its day, within the tolerance: a fact, not a breach.
    expect(check(root, days)).toEqual({ facts: ["Week 1 · Day 3 over budget: 75 of 70 min"], breaches: [] });
  });
  it("breaches once, naming the week, when the days' must-reading runs past the week's reading budget", () => {
    const { root, days } = week([
      { materials: [must("R1", 70)] },
      { materials: [must("R2", 60)], practice: [solve("Arrays 1–3", 30)] },
      { practice: [mock] },
      { materials: [must("R3", 60)], practice: [solve("Arrays 4–6", 30)] },
      { materials: [must("R4", 60)], practice: [solve("Arrays 7–9", 30)] },
    ]);
    const { breaches } = check(root, days);
    expect(breaches.map((b) => [b.kind, b.unit, b.text])).toEqual([["over-budget", "Week 1", "Week 1's must-reading is 250 min against a budget of about 180 min"]]);
  });
  it("breaches a pick's minutes over its share of the week, and states a pick left short as a fact", () => {
    // Per-item formats only: problems 90 and recall 90 of the week's 180 min of practice.
    const perItem = { ...split, formats: [split.formats[0], { format: "recall" as const, share: 50, focus: "terms", reason: "" }] };
    const { root, days } = week([
      { practice: [solve("Arrays 1–6", 65)] },
      { practice: [solve("Arrays 7–12", 65)] },
      { materials: [must("R1", 60)] },
      { materials: [must("R2", 60)] },
      { materials: [must("R3", 60)] },
    ]);
    const out = levelChecks({ root, nodes: days, leaves: true, top: false, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split: perItem });
    expect(out.breaches.map((b) => [b.kind, b.text])).toEqual([["over-budget", "Week 1's Problems practice is 130 min against a budget of about 90 min"]]);
    expect(out.facts).toEqual(["Week 1 practice short: Recall 0 of about 90 min"]);
  });
  it("breaches a 60-minute mock on a 25-minute day against that day's own budget", () => {
    // Three hours over seven days: 25 min a day.
    const { root, days } = week([{}, {}, { practice: [{ ...mock, minutes: 60 }] }, {}, {}, {}, {}]);
    const out = levelChecks({ root, nodes: days, leaves: true, top: false, materials, unknownIds: [], hoursPerWeek: 3, daysPerWeek: 7, split });
    expect(out.breaches.filter((b) => b.kind === "over-budget").map((b) => [b.unit, b.text])).toEqual([["Week 1 · Day 3", "Week 1 · Day 3 is 60 min of reading and practice against a budget of about 25 min"]]);
  });
  it("states should-reading past what must leaves of the week's reading as a fact", () => {
    const { root, days } = week([{ materials: [must("R1", 70)] }, { materials: [must("R2", 70)] }, { materials: [{ ...must("R3", 60), tier: "should" }] }]);
    const out = levelChecks({ root, nodes: days, leaves: true, top: false, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split: { readingShare: 50, practice: "projects", reason: "" } });
    // A split from before formats: reading is its share of the week, 180 min, and nothing is practice.
    expect(out).toEqual({ facts: ["no must: Week 1 · Day 3", "Week 1 should-reading is 60 min, more than the 40 min must-reading leaves of the reading budget"], breaches: [] });
  });
  it("a sourced row outside the week's practice reservation is practice-outside, and dropBreaches removes it", () => {
    const { root, days } = week([{ practice: [solve("Arrays 1–3", 30), solve("Graphs 1–3", 30, "Q")] }, { materials: [must("R1", 60)] }]);
    const out = check(root, days);
    expect(out.breaches.map((b) => [b.kind, b.index, b.text])).toEqual([["practice-outside", 0, 'Week 1 · Day 1 assigns Problems "Graphs 1–3" from M6, which Week 1 did not reserve']]);
    expect(dropBreaches(days, out.breaches)).toEqual(['dropped Problems "Graphs 1–3" from Week 1 · Day 1: practice-outside']);
    expect(days[0].practice).toEqual([solve("Arrays 1–3", 30)]);
  });
  it("binds only the formats the week reserved: a sourced row of a format it reserved nothing of may use any source", () => {
    const design = { format: "design-exercise" as const, items: 20, perItemMinutes: 45, minutes: null, answers: true };
    const withDesign = { ...split, formats: [split.formats[0], { format: "design-exercise" as const, share: 50, focus: "systems", reason: "" }] };
    const { root, days } = week([{ practice: [{ format: "design-exercise", id: "D", task: "Design a URL shortener", done: "checked against the rubric", minutes: 45, generated: false }] }]);
    const out = levelChecks({ root, nodes: days, leaves: true, top: false, materials: [...materials, { id: "D", practice: design }], unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split: withDesign });
    expect(out.breaches.map((b) => b.kind)).not.toContain("practice-outside");
  });
  it("does not check sourced rows against a week that reserves no practice", () => {
    const { root, days } = week([{ practice: [solve("Graphs 1–3", 30, "Q")] }]);
    delete root.children![0].practiceCovers;
    expect(check(root, days).breaches.map((b) => b.kind)).not.toContain("practice-outside");
  });
  it("a generated row the registry forbids is practice-generated, and so is recall not written from the day's reading", () => {
    const recall = (id: string | null): PracticeRef => ({ format: "recall", id, task: `Questions on ${id}`, done: "checked", minutes: 10, generated: true });
    const both = { ...split, formats: [split.formats[0], { format: "recall" as const, share: 50, focus: "terms", reason: "" }] };
    const { root, days } = week([{ materials: [must("R1", 30)], practice: [solve("Five array problems", 20, null as unknown as string), recall("R1"), recall("R2")] }]);
    const out = levelChecks({ root, nodes: days, leaves: true, top: false, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split: both });
    expect(out.breaches.filter((b) => b.kind === "practice-generated").map((b) => b.text)).toEqual([
      'Week 1 · Day 1 writes Problems "Five array problems" itself, which is never written',
      'Week 1 · Day 1 writes Recall "Questions on R2" itself, not from its own reading',
    ]);
    dropBreaches(days, out.breaches);
    expect(days[0].practice).toEqual([recall("R1")]);
  });
  it("holds a week leaf to the week's budgets", () => {
    // The 75-min mock takes 75 of the week's 180 min of practice, so problems have 90 + 90 − 75 = 105.
    const w1 = makeNode({ id: "w1", level: "week", title: "W", summary: "s", len: 5, budgetHours: 6, materials: [must("R1", 150)], practice: [solve("Arrays 1–15", 150), mock] });
    const root = layout(makeRoot([w1]));
    const out = levelChecks({ root, nodes: [w1], leaves: true, top: true, materials, unknownIds: [], daysPerWeek: 5, split });
    expect(out.breaches.map((b) => b.text)).toEqual(["Week 1's Problems practice is 150 min against a budget of about 105 min"]);
  });
  it("treeChecks takes the split", () => {
    // No mock this week: problems have all 180 min of practice.
    const { root } = week([{ practice: [solve("Arrays 1–24", 240)] }, { materials: [must("R1", 60)] }]);
    const out = treeChecks(root, materials, { granularity: "day", hoursPerWeek: 6, daysPerWeek: 5, split });
    expect(out.breaches.map((b) => b.text)).toContain("Week 1's Problems practice is 240 min against a budget of about 180 min");
  });
});

describe("checks follow the drafted split and budget whole blocks over the week", () => {
  // 6 h a week over 5 days: 360 min. Reading 15%: 54 min; practice 306 min, shared out 45/25/15/15 as problems 138,
  // design 76, mock 46 and recall 46.
  const pick = (format: "problem-set" | "design-exercise" | "mock" | "recall", share: number) => ({ format, share, focus: format, reason: "" });
  const split = {
    readingShare: 15,
    practice: "problems, design, mock and recall",
    reason: "",
    formats: [pick("problem-set", 45), pick("design-exercise", 25), pick("mock", 15), pick("recall", 15)],
  };
  const problems = { format: "problem-set" as const, items: 150, perItemMinutes: 10, minutes: null, answers: true };
  const must = (id: string, minutes: number): MaterialRef => ({ id, tier: "must", minutes, note: null });
  const row = (format: PracticeRef["format"], minutes: number, id: string | null = null): PracticeRef => ({ format, id, task: `${format} ${minutes}`, done: "done", minutes, generated: id === null || format === "recall" });

  it("holds headings to the drafted reading share when a pick has no source", () => {
    // No problem list: problems' 45% of the practice is reading, so the drafted share is 15 + 85 × 45% → 53%. A month
    // of 4 weeks at 6 h is 1440 min: 763 min of reading, not the split's 216. Reserving 700 min passes.
    const materials = [{ id: "C", minutes: 700 }];
    const m1 = makeNode({ id: "m1", level: "month", title: "M", summary: "s", len: 20, covers: [{ id: "C", note: null }] });
    const root = layout(makeRoot([m1]));
    const out = levelChecks({ root, nodes: [m1], leaves: false, top: true, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split });
    expect(out.breaches.map((b) => b.text)).toEqual([]);
    // With a problem list nothing folds: 216 min of reading, and 700 min is over it.
    const listed = [...materials, { id: "P", practice: problems }];
    const over = levelChecks({ root, nodes: [m1], leaves: false, top: true, materials: listed, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split });
    expect(over.breaches.map((b) => b.text)).toEqual(["Month 1 reserves about 700 min of reading against a budget of about 216 min"]);
    // An all-reading pick is all reading at every level, as its leaves are, whatever share it shows.
    const allReading = levelChecks({ root, nodes: [m1], leaves: false, top: true, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split: { readingShare: 30, practice: "reading", reason: "", formats: [] } });
    expect(allReading.breaches).toEqual([]);
  });

  describe("block formats over the plan", () => {
    // Eight weeks at 6 h: 2880 min, 432 of reading, 2448 of practice shared 45/25/15/15 as problems 1102, design 612,
    // mock 367 and recall 367 over the plan. Mock's ceiling is 367 × 1.25 + 10 = 468.75 min.
    const materials = [{ id: "R1" }, { id: "P", practice: problems }];
    const plan = (practice: () => PracticeRef[]) => {
      const weeks = [...Array(8)].map((_, i) => makeNode({ id: `w${i + 1}`, level: "week", title: `W${i + 1}`, summary: "s", len: 5, budgetHours: 6, practice: practice() }));
      return { root: layout(makeRoot(weeks)), weeks };
    };
    const check = (root: PlanNode, nodes: PlanNode[]) => levelChecks({ root, nodes, leaves: true, top: true, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split });

    it("states a block format placed past its share of the plan as a fact, not a breach", () => {
      // A mock and a design every week: 8 × 75 = 600 min of mock by the last week; designs, 400 of 612, are within.
      const { root, weeks } = plan(() => [row("mock", 75), row("design-exercise", 50)]);
      const out = check(root, weeks);
      expect(out.breaches).toEqual([]);
      expect(out.facts.filter((f) => f.includes("over the plan"))).toEqual(["Mock placed so far is 600 min, past its about 367 min over the plan"]);
      // Through week 4 only 300 min of mock is placed: within its share.
      expect(check(root, weeks.slice(0, 4)).facts.filter((f) => f.includes("over the plan"))).toEqual([]);
    });
    it("states a picked block format the plan never placed as a fact once its last unit is drafted", () => {
      // Each week: problems 190 within what a 50-min design leaves them (192), and no mock.
      const { root, weeks } = plan(() => [row("problem-set", 190, "P"), row("design-exercise", 50)]);
      const out = check(root, weeks);
      expect(out.breaches).toEqual([]);
      expect(out.facts.filter((f) => f.includes("over the plan"))).toEqual(["no Mock placed over the plan, against about 367 min for it"]);
      // Weeks 1–4 are not the plan's last: no fact yet.
      expect(check(root, weeks.slice(0, 4)).facts.filter((f) => f.includes("over the plan"))).toEqual([]);
    });
  });

  it("lets a week hold a whole mock and gives a week without one its time for other practice", () => {
    const materials = [{ id: "R1" }, { id: "R2" }, { id: "R3" }, { id: "P", practice: problems }];
    // Week A holds one 75-min mock: problems and recall share 138 + 46 + 76 + 46 − 75 = 231 min 45:15, so 173 and 58.
    const a = makeNode({ id: "a", level: "week", title: "A", summary: "s", len: 5, budgetHours: 6, materials: [must("R1", 50)], practice: [row("mock", 75), row("problem-set", 170, "P"), row("recall", 55, "R1")] });
    // Week B holds no block: problems and recall share all 306 min, so 230 and 76.
    const b = makeNode({ id: "b", level: "week", title: "B", summary: "s", len: 5, budgetHours: 6, materials: [must("R2", 50)], practice: [row("problem-set", 225, "P"), row("recall", 75, "R2")] });
    // Week C holds four mocks and two designs, 400 min: past 306 × 1.25 + 10 = 392.5 for the week's practice.
    const blocks = [...Array(4)].map(() => row("mock", 75)).concat([row("design-exercise", 50), row("design-exercise", 50)]);
    const c = makeNode({ id: "c", level: "week", title: "C", summary: "s", len: 5, budgetHours: 6, materials: [must("R3", 50)], practice: blocks });
    const root = layout(makeRoot([a, b, c]));
    const out = levelChecks({ root, nodes: [a, b, c], leaves: true, top: true, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split });
    expect(out.breaches.map((x) => [x.kind, x.unit, x.text])).toEqual([["over-budget", "Week 3", "Week 3's practice is 400 min against a budget of about 306 min"]]);
    expect(out.facts.filter((f) => f.includes("short"))).toEqual([]);
    // Week A's problems past its reduced budget breach against it: 173 × 1.25 + 10 = 226.25.
    a.practice = [row("mock", 75), row("problem-set", 230, "P"), row("recall", 55, "R1")];
    const overA = levelChecks({ root, nodes: [a], leaves: true, top: true, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split });
    expect(overA.breaches.map((x) => x.text)).toEqual(["Week 1's Problems practice is 230 min against a budget of about 173 min"]);
  });
});

describe("keepPracticeCovers", () => {
  const kept = [
    { format: "problem-set" as const, id: "neet", note: null, task: "Arrays 1–6", minutes: 40 },
    { format: "design-exercise" as const, id: null, note: null, task: "Design a cache", minutes: 30 },
  ];
  // "neet" is a problem list; "book" is reading.
  const practiceOf = aliasMaterials([{ id: "book" }, { id: "neet", practice: { format: "problem-set", items: 150, perItemMinutes: 10, minutes: null, answers: true } }]).practice;

  it("restores task and minutes on a reservation written back with an id only", () => {
    expect(keepPracticeCovers([{ format: "problem-set", id: "neet", note: "harder" }], kept, practiceOf)).toEqual([
      { format: "problem-set", id: "neet", note: "harder", task: "Arrays 1–6", minutes: 40 },
      kept[1],
    ]);
  });

  it("never overwrites a value the reservation already has, and matches on format as well as id", () => {
    const next = [
      { format: "problem-set" as const, id: "neet", note: null, task: "Mine" },
      { format: "lab" as const, id: "neet", note: null },
    ];
    expect(keepPracticeCovers(next, kept, practiceOf).slice(0, 2)).toEqual([
      { format: "problem-set", id: "neet", note: null, task: "Mine", minutes: 40 },
      { format: "lab", id: "neet", note: null },
    ]);
  });

  it("carries generated reservations forward unchanged, after the rewritten list, even when it is empty", () => {
    expect(keepPracticeCovers([], kept, practiceOf)).toEqual([kept[1]]);
    expect(keepPracticeCovers([], undefined, practiceOf)).toEqual([]);
  });

  it("gives a listed source written back without a run every run the unit held of it", () => {
    const listed = aliasMaterials([{ id: "neet", practice: LISTED_PROBLEMS }]).practice;
    const runs = [
      { format: "problem-set" as const, id: "neet", note: null, itemFrom: 1, itemTo: 4 },
      { format: "problem-set" as const, id: "neet", note: null, itemFrom: 7, itemTo: 9 },
    ];
    expect(keepPracticeCovers([{ format: "problem-set", id: "neet", note: null }], runs, listed)).toEqual(runs);
    // Written back twice without runs: the first takes both, the second stays without one (and is dropped later as unknown).
    expect(keepPracticeCovers([{ format: "problem-set", id: "neet", note: null }, { format: "problem-set", id: "neet", note: null }], runs, listed)).toEqual([...runs, { format: "problem-set", id: "neet", note: null }]);
    // A run written back keeps its own; the other still comes back with a run-less echo.
    expect(keepPracticeCovers([{ ...runs[1] }, { format: "problem-set", id: "neet", note: null }], runs, listed)).toEqual([runs[1], runs[0]]);
  });

  it("carries a generated recall reservation that cites its reading forward, since the model cannot write it back", () => {
    const recall = { format: "recall" as const, id: "book", note: null, task: "Six questions on hashing", minutes: 15 };
    expect(keepPracticeCovers([{ format: "problem-set", id: "neet", note: null }], [kept[0], recall], practiceOf)).toEqual([kept[0], recall]);
  });
});

describe("item aliases on a listed practice source", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `P${i + 1}`, number: String(i + 1), group: "Arrays", difficulty: null, url: null, solutionUrl: null, minutes: null }));
  const practice = (n: number | null) => ({ format: "problem-set" as const, items: n ?? 150, perItemMinutes: 10, minutes: null, answers: true, ...(n ? { list: { items: items(n), source: "file" as const, url: "https://example.com/list.json" } } : {}) });
  const toc = { source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: [1, 2, 3].map((n) => ({ n, title: `C${n}`, page: null, minutes: null, sections: [] })) };
  // M1 a book, M2 a book without a toc, M3 a practice source with no list, M4 a 100-item list.
  const aliases = aliasMaterials([{ id: "book", toc }, { id: "plain" }, { id: "bare", practice: practice(null) }, { id: "list", practice: practice(100) }]);
  it("resolves M4.12 to item 12 of a 100-item list, and nothing past it", () => {
    expect(aliases.resolve("M4.12")).toEqual({ id: "list", chapter: null, item: 12 });
    expect(aliases.resolve("m4.100")).toEqual({ id: "list", chapter: null, item: 100 });
    expect(aliases.resolve("M4.101")).toBeUndefined();
    expect(aliases.resolve("M4.0")).toBeUndefined();
    expect(aliases.items("list")).toBe(100);
    expect(aliases.items("book")).toBe(0);
  });
  it("keeps chapter aliases to books: M1.3 is a chapter, M2.3 and an item on a source with no list are unknown", () => {
    expect(aliases.resolve("M1.3")).toEqual({ id: "book", chapter: 3 });
    expect(aliases.resolve("M1.3")?.item).toBeUndefined();
    expect(aliases.resolve("M2.3")).toBeUndefined();
    expect(aliases.resolve("M3.3")).toBeUndefined();
    expect(aliases.resolve("M4")).toEqual({ id: "list", chapter: null });
  });
  it("a chapter alias on a practice source and an item alias on a book are unknown", () => {
    const both = aliasMaterials([{ id: "book", toc, practice: undefined }, { id: "list", practice: practice(10) }]);
    expect(both.resolve("M1.4")).toBeUndefined(); // past a 3-chapter book, and a book has no items
    expect(both.alias("list", { item: 7 })).toBe("M2.7");
    expect(both.resolve("M2.7")).toEqual({ id: "list", chapter: null, item: 7 });
    expect(both.alias("missing", { item: 1 })).toBeUndefined();
    expect(both.alias("list")).toBe("M2");
  });
  it("does not turn an item alias into a reading ref", () => {
    const { refs, unknown } = resolveMaterialRefs([{ id: "M4.12", tier: "must", minutes: 30 }, { id: "M1.2", tier: "must", minutes: 30 }], aliases);
    expect(refs.map((r) => r.id)).toEqual(["book"]);
    expect(unknown).toEqual(["M4.12"]);
    expect(resolveCoverRefs([{ id: "M4.12" }], aliases).unknown).toEqual(["M4.12"]);
  });
});

describe("practice item lists: weeks reserve runs, days assign items", () => {
  const unlisted = { format: "problem-set" as const, items: 150, perItemMinutes: 10, minutes: null, answers: true };
  // M1 is reading, M2 the 21-problem list (P), M3 a problem list without one (Q).
  const materials = [{ id: "R1" }, { id: "P", practice: LISTED_PROBLEMS }, { id: "Q", practice: unlisted }];
  const aliases = aliasMaterials(materials);
  const split = { readingShare: 50, practice: "problems", reason: "", formats: [{ format: "problem-set" as const, share: 100, focus: "arrays", reason: "" }] };
  const reserve = (from: number, to: number, id = "P"): PracticeCover => ({ format: "problem-set", id, note: null, itemFrom: from, itemTo: to });
  const item = (n: number): PracticeRef => ({ format: "problem-set", id: "P", task: PROBLEM_ITEMS[n - 1].title, done: "solved", minutes: 25, generated: false, itemFrom: n, itemTo: n });
  const day = (id: string, practice: PracticeRef[] = []) => makeNode({ id, level: "day", title: id, summary: "s", len: 1, practice });
  const week = (id: string, covers: PracticeCover[], days: PlanNode[] | null = null) => makeNode({ id, level: "week", title: id, summary: "s", len: days?.length ?? 5, practiceCovers: covers, children: days });
  const check = (root: PlanNode, nodes: PlanNode[], leaves: boolean, top = false) => levelChecks({ root, nodes, leaves, top, materials, unknownIds: [], daysPerWeek: 5, split });

  it("reserves item ranges in list order across weeks", () => {
    const { refs, unknown } = resolvePracticeCovers(
      [
        { format: "problem-set", id: "M2", note: " Arrays & Hashing ", from: 1, to: 9 },
        { format: "problem-set", id: "M2", from: 14, to: 10 },
        { format: "problem-set", id: "M3", note: "Graphs", from: 1, to: 5 },
      ],
      aliases,
      split,
    );
    // A listed source's run is kept as positions (a reversed one is turned round); a source without a list keeps its note only.
    expect(refs).toEqual([{ ...reserve(1, 9), note: "Arrays & Hashing" }, reserve(10, 14), { format: "problem-set", id: "Q", note: "Graphs" }]);
    expect(unknown).toEqual([]);
    // Three weeks reserving the list in order, every item once: nothing to report.
    const weeks = [week("w1", [reserve(1, 9)]), week("w2", [reserve(10, 14)]), week("w3", [reserve(15, 21)])];
    expect(check(layout(makeRoot(weeks)), weeks, false, true)).toEqual({ facts: [], breaches: [] });
    // Out of order is a fact; an item two weeks reserve is practice-overlap, which trims the later reservation to its free part.
    const swapped = [week("w1", [reserve(10, 14)]), week("w2", [reserve(1, 9)]), week("w3", [reserve(14, 19)])];
    const out = check(layout(makeRoot(swapped)), swapped, false, true);
    expect(out.facts).toEqual(["M2 items 1–9 after item 14 (Week 2)", "M2 items 20–21 not reserved"]);
    expect(out.breaches.map((b) => [b.kind, b.index, b.text])).toEqual([["practice-overlap", 2, "Week 3 reserves Problems M2 items 14–19, but Week 1 holds M2.14"]]);
    expect(dropBreaches(swapped, out.breaches)).toEqual(["trimmed Problems M2 items 14–19 in Week 3 to items 15–19: practice-overlap"]);
    expect(swapped[2].practiceCovers).toEqual([reserve(15, 19)]);
  });

  it("refuses an item alias outside the list", () => {
    const rows = [
      { format: "problem-set", id: "M2.4", task: "Group Anagrams", done: "solved", minutes: 40 },
      { format: "problem-set", id: "M2.22", task: "A problem past the list", done: "solved", minutes: 25 },
      { format: "problem-set", id: "M2", task: "Arrays & Hashing, problems 1–3", done: "solved", minutes: 45 },
      { format: "problem-set", id: "M3", task: "Graphs 1–3", done: "solved", minutes: 30 },
    ];
    const { refs, unknown, refused } = resolvePracticeRefs(rows, aliases, split);
    // An item row takes the item's position and its minutes (a medium problem is 25 min); a source without a list is as before.
    expect(refs).toEqual([
      { format: "problem-set", id: "P", task: "Group Anagrams", done: "solved", minutes: 25, generated: false, itemFrom: 4, itemTo: 4 },
      { format: "problem-set", id: "Q", task: "Graphs 1–3", done: "solved", minutes: 30, generated: false },
    ]);
    // Past the list, or the listed source without an item: unknown, like an unknown chapter.
    expect(unknown).toEqual(["M2.22", "M2"]);
    expect(refused).toEqual([]);
    // A reservation past the list, or of a listed source without a run, is dropped as unknown too.
    const covers = resolvePracticeCovers([{ format: "problem-set", id: "M2", from: 15, to: 30 }, { format: "problem-set", id: "M2", note: "Stack" }, { format: "problem-set", id: "M2", from: 0, to: 3 }], aliases, split);
    expect(covers.refs).toEqual([]);
    expect(covers.unknown).toEqual(["M2.15–M2.30", "M2", "M2.0–M2.3"]);
    // A saved plan's rows and reservations without items are kept when asked to keep them (a revision).
    expect(resolvePracticeRefs([rows[2]], aliases, split, [], { keepUnitemized: true }).refs).toHaveLength(1);
    expect(resolvePracticeCovers([{ format: "problem-set", id: "M2", note: "Stack" }], aliases, split, { keepUnitemized: true }).refs).toEqual([{ format: "problem-set", id: "P", note: "Stack" }]);
    // An item alias names a one-item reservation, as a week split by hand writes it back.
    expect(resolvePracticeCovers([{ format: "problem-set", id: "M2.7" }], aliases, split).refs).toEqual([reserve(7, 7)]);
  });

  it("breaches a day item outside its week's range", () => {
    const days = [day("d1", [item(1), item(2)]), day("d2", [item(3), item(5)])];
    const w1 = week("w1", [reserve(1, 4)], days);
    const out = check(layout(makeRoot([w1])), days, true);
    expect(out.breaches.map((b) => [b.kind, b.index, b.text])).toEqual([["practice-outside", 1, 'Week 1 · Day 2 assigns Problems M2.5 "Top K Frequent Elements", which Week 1 did not reserve']]);
    expect(out.facts).toEqual(["item 4 of M2 reserved by Week 1 but not assigned"]);
    expect(dropBreaches(days, out.breaches)).toEqual(['dropped Problems M2.5 "Top K Frequent Elements" from Week 1 · Day 2: practice-outside']);
    expect(days[1].practice).toEqual([item(3)]);
  });

  it("breaches an item an earlier week already used", () => {
    const first = [day("a1", [item(1), item(2)]), day("a2", [item(3)])];
    // Week 2 was saved reserving 3–6, item 3 among them; its days now assign item 3 again, and item 4 twice.
    const second = [day("b1", [item(3)]), day("b2", [item(4)]), day("b3", [item(4), item(5)])];
    const root = layout(makeRoot([week("w1", [reserve(1, 3)], first), week("w2", [reserve(3, 6)], second)]));
    const out = check(root, second, true);
    expect(out.breaches.map((b) => [b.kind, b.index, b.text])).toEqual([
      ["practice-overlap", 0, 'Week 2 · Day 1 assigns Problems M2.3 "Two Sum", which Week 1 · Day 2 already assigns'],
      ["practice-overlap", 2, 'Week 2 · Day 3 assigns Problems M2.4 "Group Anagrams", which Week 2 · Day 2 already assigns'],
    ]);
    // A drop takes the repeated row only, never the first use.
    dropBreaches(second, out.breaches);
    expect(second.map((d) => d.practice?.map((r) => r.itemFrom))).toEqual([undefined, [4], [5]]);
  });

  it("keeps a source reserved elsewhere out of an unreserved week", () => {
    // Weeks 1–2 reserve nothing; week 3 reserves the list and the unlisted source. Week 1's days may use neither.
    const days = [day("d1", [item(1)]), day("d2", [{ format: "problem-set", id: "Q", task: "Graphs 1–3", done: "solved", minutes: 30, generated: false }])];
    const root = layout(makeRoot([week("w1", [], days), week("w2", []), week("w3", [reserve(1, 21), { format: "problem-set", id: "Q", note: "Graphs" }])]));
    const out = check(root, days, true);
    expect(out.breaches.map((b) => [b.kind, b.text])).toEqual([
      ["practice-outside", 'Week 1 · Day 1 assigns Problems M2.1 "Contains Duplicate", which Week 1 did not reserve'],
      ["practice-outside", 'Week 1 · Day 2 assigns Problems "Graphs 1–3" from M3, which Week 1 did not reserve'],
    ]);
    // With no heading reserving them anywhere, any source may still be used.
    const free = layout(makeRoot([week("w1", [], [day("d1", [item(1)])])]));
    expect(check(free, free.children![0].children!, true).breaches).toEqual([]);
    // A week split by hand reserves only what it did itself: that binds its own days, not the plan's other weeks.
    const split = makeNode({ id: "w2", level: "week", title: "w2", summary: "s", len: 1, manualSplit: true, practiceCovers: [reserve(5, 5)], children: [day("e1", [item(5)])] });
    const mixed = layout(makeRoot([week("w1", [], [day("d1", [item(1)])]), split]));
    expect(check(mixed, mixed.children![0].children!, true).breaches).toEqual([]);
  });

  it("records reserved items no day assigned", () => {
    const days = [day("d1", [item(1), item(2)]), day("d2", [item(4)])];
    const w1 = week("w1", [reserve(1, 6)], days);
    const out = check(layout(makeRoot([w1])), days, true);
    expect(out.breaches).toEqual([]);
    expect(out.facts).toEqual(["items 3, 5–6 of M2 reserved by Week 1 but not assigned"]);
  });

  it("holds a month's week ranges inside the month's, as chapters", () => {
    const weeks = [week("w1", [reserve(1, 9)]), week("w2", [reserve(10, 16)])];
    const m1 = makeNode({ id: "m1", level: "month", title: "M", summary: "s", len: 10, practiceCovers: [reserve(1, 14)], children: weeks });
    const root = layout(makeRoot([m1, makeNode({ id: "m2", level: "month", title: "M", summary: "s", len: 10, practiceCovers: [reserve(15, 21)] })]));
    const out = check(root, weeks, false);
    expect(out.facts).toEqual([]);
    expect(out.breaches.map((b) => [b.kind, b.index, b.text])).toEqual([["practice-outside", 1, "Week 2 reserves Problems M2 items 10–16, which Month 1 did not reserve"]]);
    // Two weeks of the month reserving one item: practice-overlap, naming the week that holds it.
    weeks[1].practiceCovers = [reserve(9, 14)];
    expect(check(root, weeks, false).breaches.map((b) => b.text)).toEqual(["Week 2 reserves Problems M2 items 9–14, but Week 1 holds M2.9"]);
    // Inside the month and short of its end: the rest is a fact.
    weeks[1].practiceCovers = [reserve(10, 12)];
    expect(check(root, weeks, false)).toEqual({ facts: ["items 13–14 of M2 reserved by Month 1 but not assigned"], breaches: [] });
  });

  it("never drops saved rows for the new rules", () => {
    // A plan saved before the rules: week 1 reserved nothing and its days used the list (one row with no item); week 2
    // reserved the list; week 2's days repeat week 1's item 1.
    const old: PracticeRef = { format: "problem-set", id: "P", task: "Arrays & Hashing, problems 1–3", done: "solved", minutes: 45, generated: false };
    const first = [day("a1", [item(1)]), day("a2", [old])];
    const second = [day("b1", [item(1)]), day("b2", [item(2)])];
    const root = layout(makeRoot([week("w1", [], first), week("w2", [reserve(1, 21)], second)]));
    const out = treeChecks(root, materials, { granularity: "day", daysPerWeek: 5, split });
    expect(out.breaches).toEqual([]);
    expect(out.facts).toEqual(
      expect.arrayContaining([
        'Week 1 · Day 1 assigns Problems M2.1 "Contains Duplicate", which Week 1 did not reserve',
        'Week 1 · Day 2 assigns Problems "Arrays & Hashing, problems 1–3" from M2 without an item',
        'Week 2 · Day 1 assigns Problems M2.1 "Contains Duplicate", which Week 1 · Day 1 already assigns',
      ]),
    );
    expect(dropBreaches(out.nodes, out.breaches)).toEqual([]);
    expect(first[1].practice).toEqual([old]);
    // The same rows drafted now breach.
    expect(check(root, second, true).breaches.map((b) => b.kind)).toEqual(["practice-overlap"]);
  });

  it("lets a saved row hold its item against a revision's new repeat on an earlier day", () => {
    // Saved: Week 1 reserves 1–6; Day 1 did item 1, Day 2 item 4. The revision adds item 4 to Day 1, before Day 2.
    const saved = () => layout(makeRoot([week("w1", [reserve(1, 6)], [day("d1", [item(1)]), day("d2", [item(4)])])]));
    const original = saved();
    const revised = saved();
    revised.children![0].children![0].practice!.push(item(4));
    const out = treeChecks(revised, materials, { granularity: "day", daysPerWeek: 5, split, original });
    expect(out.breaches.map((b) => [b.kind, b.text])).toEqual([["practice-overlap", 'Week 1 · Day 1 assigns Problems M2.4 "Group Anagrams", which Week 1 · Day 2 already assigns']]);
    dropBreaches(out.nodes, out.breaches);
    expect(revised.children![0].children!.map((d) => d.practice?.map((r) => r.itemFrom))).toEqual([[1], [4]]);
  });

  it("counts saved rows: an exact copy of an unchanged row past the saved count is new", () => {
    const saved = () => layout(makeRoot([week("w1", [reserve(1, 6)], [day("d1", [item(1)]), day("d2", [item(4)])])]));
    const original = saved();
    const revised = saved();
    revised.children![0].children![1].practice!.push(item(4));
    const out = treeChecks(revised, materials, { granularity: "day", daysPerWeek: 5, split, original });
    expect(out.breaches.map((b) => [b.kind, b.text])).toEqual([["practice-overlap", 'Week 1 · Day 2 assigns Problems M2.4 "Group Anagrams", which Week 1 · Day 2 already assigns']]);
    expect(dropBreaches(out.nodes, out.breaches)).toEqual(['dropped Problems M2.4 "Group Anagrams" from Week 1 · Day 2: practice-overlap']);
    expect(revised.children![0].children!.map((d) => d.practice?.map((r) => r.itemFrom))).toEqual([[1], [4]]);
    // A repeat the saved plan already held is two saved rows: a fact, never a drop.
    const twice = () => layout(makeRoot([week("w1", [reserve(1, 6)], [day("d1", [item(4)]), day("d2", [item(4)])])]));
    const kept = treeChecks(twice(), materials, { granularity: "day", daysPerWeek: 5, split, original: twice() });
    expect(kept.breaches).toEqual([]);
    expect(kept.facts).toContain('Week 1 · Day 2 assigns Problems M2.4 "Group Anagrams", which Week 1 · Day 1 already assigns');
  });

  it("lets a saved week's run hold its items against a revision that widens an earlier week's", () => {
    const saved = () => layout(makeRoot([week("w1", [reserve(1, 9)]), week("w2", [reserve(10, 17)])]));
    const revised = saved();
    revised.children![0].practiceCovers = [reserve(1, 12)];
    const out = treeChecks(revised, materials, { granularity: "day", daysPerWeek: 5, split, original: saved() });
    expect(out.breaches.map((b) => [b.kind, b.text])).toEqual([["practice-overlap", "Week 1 reserves Problems M2 items 1–12, but Week 2 holds M2.10–M2.12"]]);
    expect(dropBreaches(out.nodes, out.breaches)).toEqual(["trimmed Problems M2 items 1–12 in Week 1 to items 1–9: practice-overlap"]);
    expect(revised.children!.map((w) => w.practiceCovers)).toEqual([[reserve(1, 9)], [reserve(10, 17)]]);
  });

  it("keys a saved item row by its item, so a reworded task stays saved; an itemless row by its task", () => {
    expect(practiceRowKey("d1", { ...item(4), task: "Group Anagrams, again" })).toBe(practiceRowKey("d1", item(4)));
    expect(practiceRowKey("d1", { ...item(4), format: "recall" })).not.toBe(practiceRowKey("d1", item(4)));
    expect(practiceRowKey("d1", item(5))).not.toBe(practiceRowKey("d1", item(4)));
    const plain: PracticeRef = { format: "problem-set", id: "Q", task: "Graphs 1–3", done: "solved", minutes: 30, generated: false };
    expect(practiceRowKey("d1", { ...plain, task: "Graphs 4–6" })).not.toBe(practiceRowKey("d1", plain));
  });

  it("trims a week's run that overlaps a neighbour by its edge to its free part, so the next week keeps its run too", () => {
    const weeks = [week("w1", [reserve(1, 9)]), week("w2", [{ ...reserve(9, 17), note: "Two pointers" }]), week("w3", [reserve(17, 21)])];
    const out = check(layout(makeRoot(weeks)), weeks, false, true);
    // Week 2 claims only 10–17, so Week 3 loses only item 17.
    expect(out.breaches.map((b) => [b.kind, b.index, b.text])).toEqual([
      ["practice-overlap", 1, "Week 2 reserves Problems M2 items 9–17, but Week 1 holds M2.9"],
      ["practice-overlap", 2, "Week 3 reserves Problems M2 items 17–21, but Week 2 holds M2.17"],
    ]);
    expect(dropBreaches(weeks, out.breaches)).toEqual([
      "trimmed Problems M2 items 9–17 in Week 2 to items 10–17: practice-overlap",
      "trimmed Problems M2 items 17–21 in Week 3 to items 18–21: practice-overlap",
    ]);
    expect(weeks.map((w) => w.practiceCovers)).toEqual([[reserve(1, 9)], [{ ...reserve(10, 17), note: "Two pointers" }], [reserve(18, 21)]]);
    // Trimmed, the weeks pass.
    expect(check(layout(makeRoot(weeks)), weeks, false, true).breaches).toEqual([]);
  });

  it("drops a week's run that lies wholly inside a neighbour's, and it claims nothing", () => {
    const weeks = [week("w1", [reserve(1, 9)]), week("w2", [reserve(3, 5)]), week("w3", [reserve(10, 21)])];
    const out = check(layout(makeRoot(weeks)), weeks, false, true);
    expect(out.breaches.map((b) => [b.kind, b.index])).toEqual([["practice-overlap", 1]]);
    expect(dropBreaches(weeks, out.breaches)).toEqual(["dropped Problems M2 items 3–5 from Week 2: practice-overlap"]);
    expect(weeks[1].practiceCovers).toBeUndefined();
  });

  it("trims a week's run that pokes past its month's to the month's", () => {
    const weeks = [week("w1", [reserve(1, 9)]), week("w2", [reserve(10, 16)])];
    const m1 = makeNode({ id: "m1", level: "month", title: "M", summary: "s", len: 10, practiceCovers: [reserve(1, 14)], children: weeks });
    const root = layout(makeRoot([m1, makeNode({ id: "m2", level: "month", title: "M", summary: "s", len: 10, practiceCovers: [reserve(15, 21)] })]));
    const out = check(root, weeks, false);
    expect(out.breaches.map((b) => [b.kind, b.index])).toEqual([["practice-outside", 1]]);
    expect(dropBreaches(weeks, out.breaches)).toEqual(["trimmed Problems M2 items 10–16 in Week 2 to items 10–14: practice-outside"]);
    expect(weeks[1].practiceCovers).toEqual([reserve(10, 14)]);
    // A run wholly outside the month's is dropped.
    weeks[1].practiceCovers = [reserve(15, 18)];
    const outside = check(root, weeks, false);
    expect(dropBreaches(weeks, outside.breaches)).toEqual(["dropped Problems M2 items 15–18 from Week 2: practice-outside"]);
    expect(weeks[1].practiceCovers).toBeUndefined();
  });

  it("keeps a split week's item reservations when they are written back by id or by item", () => {
    const before = [{ ...reserve(1, 1), task: "Contains Duplicate", minutes: 15 }, { ...reserve(2, 2), task: "Valid Anagram", minutes: 15 }];
    // Written back as item aliases: each finds its own task and minutes.
    expect(keepPracticeCovers([reserve(2, 2), reserve(1, 1)], before, aliases.practice)).toEqual([before[1], before[0]]);
    // A lone reservation written back without its run gets the run back.
    expect(keepPracticeCovers([{ format: "problem-set", id: "P", note: null }], [before[0]], aliases.practice)).toEqual([before[0]]);
  });
});

describe("shareRuns", () => {
  it("cuts items in order at each unit's cumulative share, by the items' minutes", () => {
    expect(shareRuns([10, 10, 10, 10], [1, 1])).toEqual([2, 2]);
    // 80 min cut at 40: the second item's middle (42.5) is past the cut, so it opens the second run.
    expect(shareRuns([35, 15, 15, 15], [1, 1])).toEqual([1, 3]);
    expect(shareRuns([10, 10, 10, 10, 10, 10], [2, 1])).toEqual([4, 2]);
    // Weights that sum to nothing share equally.
    expect(shareRuns([10, 10], [0, 0])).toEqual([1, 1]);
  });
  it("never leaves a unit empty while items remain, and gives later units none when items run out", () => {
    // A tiny share still gets one item.
    expect(shareRuns([10, 10, 10, 10], [1, 100, 1])).toEqual([1, 2, 1]);
    expect(shareRuns([10, 10], [1, 1, 1])).toEqual([1, 1, 0]);
    expect(shareRuns([], [1, 1])).toEqual([0, 0]);
  });
});

describe("sizeItemRuns: code sizes a listed source's runs on headings", () => {
  const DIFFICULTY = ["easy", "medium", "hard", "medium", "easy", "hard", "medium"] as const;
  /** A list of `n` problems of mixed difficulty: 15, 25 or 35 min each. */
  const listOf = (n: number) => {
    const items = Array.from({ length: n }, (_, i) => ({ title: `Problem ${i + 1}`, number: String(i + 1), group: `Group ${Math.floor(i / 10) + 1}`, difficulty: DIFFICULTY[i % 7], url: null, solutionUrl: null, minutes: null }));
    const minutes = items.reduce((sum, it) => sum + itemMinutes("problem-set", it), 0);
    return { format: "problem-set" as const, items: n, totalItems: n, perItemMinutes: 10, minutes, answers: true, list: { items, source: "file" as const, url: "https://example.com/p.json" } };
  };
  const unlisted = { format: "problem-set" as const, items: 40, perItemMinutes: 10, minutes: null, answers: true };
  // M1 a 50-problem list (P), M2 a problem list without items (Q). Five hours a week, half practice: 150 min of Problems a week.
  const materials: { id: string; practice: MaterialPractice }[] = [{ id: "P", practice: listOf(50) }, { id: "Q", practice: unlisted }];
  const split = { readingShare: 50, practice: "problems", reason: "", formats: [{ format: "problem-set" as const, share: 100, focus: "arrays", reason: "" }] };
  const minutesOf = (id: string, positions: number[]) => {
    const items = materials.find((m) => m.id === id)!.practice.list?.items ?? [];
    return positions.reduce((sum, n) => sum + itemMinutes("problem-set", items[n - 1]), 0);
  };
  const ALL = minutesOf("P", Array.from({ length: 50 }, (_, i) => i + 1));
  const HARDEST = 35;
  /** The model's choice: the source on a unit, with whatever run it wrote. */
  const chosen = (from?: number, to?: number): PracticeCover => ({ format: "problem-set", id: "P", note: null, ...(from ? { itemFrom: from, itemTo: to } : {}) });
  const weeks = (n: number, covers: (i: number) => PracticeCover[] | undefined) =>
    Array.from({ length: n }, (_, i) => makeNode({ id: `w${i + 1}`, level: "week", title: `W${i + 1}`, summary: "s", len: 5, practiceCovers: covers(i) }));
  const size = (nodes: PlanNode[], root = layout(makeRoot(nodes)), mats: typeof materials = materials) => sizeItemRuns({ root, nodes, materials: mats, split, hoursPerWeek: 5, daysPerWeek: 5 });
  const runsOf = (n: PlanNode, id = "P") => (n.practiceCovers ?? []).filter((c) => c.id === id);
  const positionsOf = (n: PlanNode) => runsOf(n).flatMap(itemPositions);

  it("gives the weeks the model chose contiguous runs over the whole list, sized by their Problems time, whatever runs it wrote", () => {
    // The model chose weeks 1–6 with arbitrary runs, and week 1 also takes the unlisted Q; weeks 7–8 take nothing.
    const nodes = weeks(8, (i) => (i < 6 ? [chosen(3 + i, 40 - i), ...(i === 0 ? [{ format: "problem-set" as const, id: "Q", note: "Graphs 1–5" }] : [])] : undefined));
    const root = layout(makeRoot(nodes));
    expect(size(nodes, root)).toEqual([]);
    // Each chosen week holds one run; together they are 1–50 in order, each item once.
    for (const n of nodes.slice(0, 6)) expect(runsOf(n)).toHaveLength(1);
    expect(nodes.flatMap(positionsOf)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // Each run is within one item's minutes of its share of the list: a sixth, the weeks' times being equal.
    for (const n of nodes.slice(0, 6)) expect(Math.abs(minutesOf("P", positionsOf(n)) - ALL / 6)).toBeLessThanOrEqual(HARDEST);
    // Weeks the model did not choose get none; the unlisted source keeps its note and no run.
    expect(nodes[6].practiceCovers).toBeUndefined();
    expect(nodes[7].practiceCovers).toBeUndefined();
    expect(nodes[0].practiceCovers![1]).toEqual({ format: "problem-set", id: "Q", note: "Graphs 1–5" });
    // The checks find nothing to report.
    expect(levelChecks({ root, nodes, leaves: false, top: true, materials, unknownIds: [], daysPerWeek: 5, hoursPerWeek: 5, split })).toEqual({ facts: [], breaches: [] });
  });

  it("gives every chosen week a run when the model chose them all", () => {
    const nodes = weeks(8, () => [chosen()]);
    expect(size(nodes)).toEqual([]);
    expect(nodes.every((n) => runsOf(n).length === 1 && positionsOf(n).length > 0)).toBe(true);
    expect(nodes.flatMap(positionsOf)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    for (const n of nodes) expect(Math.abs(minutesOf("P", positionsOf(n)) - ALL / 8)).toBeLessThanOrEqual(HARDEST);
  });

  it("chooses every week with Problems time when the model chose none, and says so", () => {
    const nodes = weeks(8, () => undefined);
    expect(size(nodes)).toEqual(["no unit chose M1 for Problems: it is shared out over every unit with Problems time"]);
    expect(nodes.every((n) => runsOf(n).length === 1)).toBe(true);
    expect(nodes.flatMap(positionsOf)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // With no practice time, nothing is chosen for it.
    const reading = { ...split, readingShare: 100, formats: [] };
    const none = weeks(8, () => undefined);
    expect(sizeItemRuns({ root: layout(makeRoot(none)), nodes: none, materials, split: reading, hoursPerWeek: 5, daysPerWeek: 5 })).toEqual([]);
    expect(none.every((n) => n.practiceCovers === undefined)).toBe(true);
  });

  it("gives later weeks none when there are fewer items than chosen weeks, with a fact", () => {
    const few = [{ id: "P", practice: listOf(4) }, materials[1]];
    const nodes = weeks(6, () => [chosen()]);
    expect(size(nodes, layout(makeRoot(nodes)), few)).toEqual(["M1 has 4 items for 6 units: Week 5, Week 6 get none"]);
    expect(nodes.map(positionsOf)).toEqual([[1], [2], [3], [4], [], []]);
    expect(nodes[4].practiceCovers).toBeUndefined();
  });

  it("shares a month's run among its weeks only, around items other units hold", () => {
    // Month 1 reserved items 1–20 and Month 2 21–50; a week of Month 2 already did item 12 (a row from before the runs),
    // so Month 1's weeks share 1–11 and 13–20, and none of them takes a run past Month 1's, whatever the model wrote.
    const m2week = makeNode({ id: "x1", level: "week", title: "X", summary: "s", len: 5, budgetHours: 5, practice: [{ format: "problem-set", id: "P", task: "Problem 12", done: "solved", minutes: 25, generated: false, itemFrom: 12, itemTo: 12 }] });
    const kids = weeks(4, () => [chosen(1, 50)]);
    const m1 = makeNode({ id: "m1", level: "month", title: "M1", summary: "s", len: 20, practiceCovers: [{ ...chosen(1, 20) }], children: kids });
    const m2 = makeNode({ id: "m2", level: "month", title: "M2", summary: "s", len: 30, practiceCovers: [{ ...chosen(21, 50) }], children: [m2week] });
    const root = layout(makeRoot([m1, m2]));
    expect(size(kids, root)).toEqual([]);
    const positions = kids.flatMap(positionsOf);
    expect(positions).toEqual([...Array.from({ length: 11 }, (_, i) => i + 1), ...Array.from({ length: 8 }, (_, i) => i + 13)]);
    // A week whose share crosses the gap holds two runs, so no run names an item another unit holds.
    expect(kids.flatMap((k) => runsOf(k)).every((c) => !itemPositions(c).includes(12))).toBe(true);
    expect(levelChecks({ root, nodes: kids, leaves: false, top: false, materials, unknownIds: [], daysPerWeek: 5, hoursPerWeek: 5, split }).breaches).toEqual([]);
  });
});

describe("item aliases on a source with both units and items", () => {
  const tocOf = (n: number) => ({ source: "catalogue" as const, url: "u", printPages: false, end: null, chapters: Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `C${i + 1}`, page: null, minutes: null, sections: [] })) });
  const listed = (n: number) => ({
    format: "problem-set" as const,
    items: n,
    perItemMinutes: 10,
    minutes: null,
    answers: true,
    list: { items: Array.from({ length: n }, (_, i) => ({ title: `P${i + 1}`, number: String(i + 1), group: "Arrays", difficulty: null, url: null, solutionUrl: null, minutes: null })), source: "file" as const, url: "https://example.com/list.json" },
  });
  const both = { id: "b", toc: tocOf(3), practice: listed(5) };
  const itemsOnly = { id: "p", toc: null, practice: listed(5) };
  const a = aliasMaterials([both, itemsOnly]);

  it("names an item with an i where the source has a chapter list, and without where it has none", () => {
    expect(a.alias("b", { item: 4 })).toBe("M1.i4");
    expect(a.alias("b", 2)).toBe("M1.2");
    expect(a.alias("p", { item: 4 })).toBe("M2.4");
  });
  it("resolves M1.i4 only to an item and M1.2 to a chapter, never to an item", () => {
    expect(a.resolve("M1.i4")).toEqual({ id: "b", chapter: null, item: 4 });
    expect(a.resolve("M1.2")).toEqual({ id: "b", chapter: 2 });
    expect(a.resolve("M1.4")).toBeUndefined(); // past the chapters; items need the i
    expect(a.resolve("M1.i6")).toBeUndefined();
    expect(a.resolve("M1.i0")).toBeUndefined();
    expect(a.resolve("[m1.I5]")).toEqual({ id: "b", chapter: null, item: 5 });
  });
  it("keeps items-only sources as they were, and lets them take the i too", () => {
    expect(a.resolve("M2.4")).toEqual({ id: "p", chapter: null, item: 4 });
    expect(a.resolve("M2.i4")).toEqual({ id: "p", chapter: null, item: 4 });
  });
  it("does not turn M1.i4 into a chapter or a reading ref", () => {
    expect(resolveMaterialRefs([{ id: "M1.i4", tier: "must", minutes: 30 }], a).unknown).toEqual(["M1.i4"]);
  });
  it("writes runs and positions through the aliases", () => {
    expect(itemAliases(a, "b", [2, 3, 5])).toBe("M1.i2–M1.i3, M1.i5");
    expect(itemAliases(a, "p", [2, 3, 5])).toBe("M2.2–M2.3, M2.5");
    expect(itemRun(a, "p", 1, 9)).toBe("M2 items 1–9");
    expect(itemRun(a, "p", 7, 7)).toBe("M2.7");
    expect(itemRun(a, "b", 7, 7)).toBe("M1.i7");
    expect(itemRun(a, "b", 1, 9)).toBe("M1 items 1–9");
  });
});

describe("plainAliases", () => {
  const chapters = ["1. Books", "2. Courses", "3. Mock Interviews"].map((title, i) => ({ n: i + 3, title, page: null, minutes: 2, sections: [] }));
  const materials = [
    { id: "pe", title: "Preparing for the Coding Interview - The Pragmatic Engineer", toc: { source: "page" as const, url: "https://example.com/pe", printPages: false, end: null, chapters }, practice: null },
    { id: "neet", title: "NeetCode | Coding Interview Prep", toc: null, practice: LISTED_PROBLEMS },
  ];
  const aliases = aliasMaterials(materials);

  it("puts a run of chapters, a chapter and a resource in words, by the chapters' own numbers", () => {
    expect(plainAliases("Whole essay (parts M1.1–M1.3), then M1.2 again; see M1", materials, aliases)).toBe(
      "Whole essay (parts Preparing for the Coding Interview ch. 3–5), then Preparing for the Coding Interview ch. 4 again; see Preparing for the Coding Interview",
    );
  });

  it("drops the resource's name for its own row's chapters and items", () => {
    expect(plainAliases("parts M1.1–M1.3", materials, aliases, "pe")).toBe("parts ch. 3–5");
    expect(plainAliases("M2.3, then M2.10 to M2.12", materials, aliases, "neet")).toBe("Two Sum, then items 10–12");
    expect(plainAliases("M2.3", materials, aliases)).toBe("Two Sum (NeetCode)");
  });

  it("leaves what is not an id on the list as written", () => {
    expect(plainAliases("M9, M1.7, M2.40 and MM1", materials, aliases)).toBe("M9, M1.7, M2.40 and MM1");
    expect(plainAliases("Arrays & Hashing; Two Pointers", materials, aliases)).toBe("Arrays & Hashing; Two Pointers");
  });

  it("puts every text a unit shows in words and counts the fields it changed", () => {
    const node = makeNode({ level: "day", title: "Start M1", summary: "Read M1.1.", len: 1, budgetHours: null, children: null });
    node.materials = [{ id: "pe", tier: "must", minutes: 6, note: "parts M1.1–M1.3", chapter: 1, activity: "read" }];
    node.practice = [{ format: "problem-set", id: "neet", task: "M2.1–M2.3, timed", done: "M2.3 passes", minutes: 30, generated: false, itemFrom: 1, itemTo: 3 }];
    expect(plainUnitText(node, materials, aliases)).toBe(5);
    expect(node.title).toBe("Start Preparing for the Coding Interview");
    expect(node.summary).toBe("Read Preparing for the Coding Interview ch. 3.");
    expect(node.materials[0].note).toBe("parts ch. 3–5");
    expect(node.practice[0]).toMatchObject({ task: "items 1–3, timed", done: "Two Sum passes" });
    expect(plainUnitText(node, materials, aliases)).toBe(0);
  });
});

describe("a week's practice time inside its reservation", () => {
  // Run 3 of the SDE eval: 6 h a week over 5 days, 21% reading; problems 56%, design 26%, mock 16%, recall 2%.
  const split = {
    readingShare: 21,
    practice: "problems, design, mock and recall",
    reason: "",
    formats: [
      { format: "problem-set" as const, share: 56, focus: "patterns", reason: "" },
      { format: "design-exercise" as const, share: 26, focus: "timed designs", reason: "" },
      { format: "mock" as const, share: 16, focus: "full loops", reason: "" },
      { format: "recall" as const, share: 2, focus: "stories", reason: "" },
    ],
  };
  const materials = [{ id: "R1" }, { id: "R2" }, { id: "L", practice: LISTED_PROBLEMS }, { id: "U", practice: { format: "problem-set" as const, items: 50, perItemMinutes: 10, minutes: null, answers: true } }];
  const budgets = practiceBudgets(split, 360, materials);
  const reserving = (practiceCovers: PracticeCover[]) => makeNode({ id: "w1", level: "week", title: "W", summary: "s", len: 5, practiceCovers });

  it("counts the minutes of the listed items a week reserves, and nothing for a source without a list", () => {
    expect(budgets).toEqual({ reading: 76, practice: { "problem-set": 159, "design-exercise": 74, mock: 45, recall: 6 } });
    // Items 1–9: three easy at 15 and six medium at 25.
    expect(reservedRunMinutes(reserving([{ format: "problem-set", id: "L", note: null, itemFrom: 1, itemTo: 9 }]), "problem-set", materials)).toBe(195);
    // A reservation without a range is not sized here: the share stands (the checks report it as unsized).
    expect(reservedRunMinutes(reserving([{ format: "problem-set", id: "L", note: null }]), "problem-set", materials)).toBeUndefined();
    // Overlapping reservations of one source count each item once: 1–4 and 3–6 are items 1–6.
    const twice = reserving([
      { format: "problem-set", id: "L", note: null, itemFrom: 1, itemTo: 4 },
      { format: "problem-set", id: "L", note: null, itemFrom: 3, itemTo: 6 },
      { format: "problem-set", id: "L", note: null },
    ]);
    expect(reservedRunMinutes(twice, "problem-set", materials)).toBe(3 * 15 + 3 * 25);
    expect(reservedRunMinutes(reserving([{ format: "problem-set", id: "U", note: null }]), "problem-set", materials)).toBeUndefined();
    expect(reservedRunMinutes(reserving([]), "problem-set", materials)).toBeUndefined();
    expect(reservedRunMinutes(null, "problem-set", materials)).toBeUndefined();
  });

  it("holds a listed format to its run and moves the difference to the blocks the days write", () => {
    // Run 3's Week 1: items 1–9 are 195 min against a 159-min share; the 36 extra come out of design and mock, 74:45.
    expect(weekPracticeTime(budgets, { "problem-set": 195 })).toEqual({ reading: 76, practice: { "problem-set": 195, "design-exercise": 52, mock: 31, recall: 6 } });
    // A run of 100 frees 59 min for design and mock.
    expect(weekPracticeTime(budgets, { "problem-set": 100 })).toEqual({ reading: 76, practice: { "problem-set": 100, "design-exercise": 111, mock: 67, recall: 6 } });
    // The week's minutes stay whole either way.
    for (const run of [100, 195, 300]) {
      const t = weekPracticeTime(budgets, { "problem-set": run });
      expect(t.reading + Object.values(t.practice).reduce((a, b) => a + b, 0)).toBe(run > 278 ? 76 + run + 6 : 360);
    }
    // Without a run nothing moves.
    expect(weekPracticeTime(budgets, {})).toEqual(budgets);
  });

  it("holds a block format with a listed run to its run too, and moves the difference to the other blocks", () => {
    // Problems 1–4 (100 min) and design 1–3 (150 min): the 59 + −76 = −17 net comes out of mock alone.
    expect(weekPracticeTime(budgets, { "problem-set": 100, "design-exercise": 150 })).toEqual({ reading: 76, practice: { "problem-set": 100, "design-exercise": 150, mock: 28, recall: 6 } });
    // A week reserving only one 50-min design question: the 24 it frees go to mock, the one block without a run.
    expect(weekPracticeTime(budgets, { "design-exercise": 50 })).toEqual({ reading: 76, practice: { "problem-set": 159, "design-exercise": 50, mock: 69, recall: 6 } });
    // With every block held to a run, what is freed goes to reading.
    expect(weekPracticeTime(budgets, { "design-exercise": 50, mock: 45 })).toEqual({ reading: 100, practice: { "problem-set": 159, "design-exercise": 50, mock: 45, recall: 6 } });
  });

  it("leaves out the items a unit outside the week already did", () => {
    // Week 1 reserves items 1–9; Week 2, split by hand, already did item 5 (25 min).
    const done = makeNode({ id: "d", level: "day", title: "D", summary: "s", len: 1, practice: [{ format: "problem-set", id: "L", task: "Top K Frequent Elements", done: "solved", minutes: 25, generated: false, itemFrom: 5, itemTo: 5 }] });
    const w1 = makeNode({ id: "w1", level: "week", title: "W1", summary: "s", len: 5, practiceCovers: [{ format: "problem-set", id: "L", note: null, itemFrom: 1, itemTo: 9 }] });
    const w2 = makeNode({ id: "w2", level: "week", title: "W2", summary: "s", len: 5, manualSplit: true, children: [done] });
    const root = layout(makeRoot([w1, w2]));
    expect(reservedRuns(root.children![0], materials, root)).toEqual({ "problem-set": 170 });
    expect(reservedRuns(root.children![0], materials)).toEqual({ "problem-set": 195 });
  });

  it("fits a week's time to its days in whole blocks that never outgrow a day", () => {
    // Five 70-min days are 350 min. Run 3's Week 1: design's 52 min are one 50-min block, mock's 31 no 70-min block;
    // what they leave is reading's, as far as the days reach: 99 + 195 + 50 + 6.
    expect(fitWeekToDays(weekPracticeTime(budgets, { "problem-set": 195 }), { "problem-set": 195 }, 70, 5, true)).toEqual({
      reading: 99,
      practice: { "problem-set": 195, "design-exercise": 50, mock: 0, recall: 6 },
      blocks: { "design-exercise": 1, mock: 0 },
    });
    // The 2026-10-31 Week 1: 65 + 170 + 77 + 30 + 18 is 360. Two designs and no mock round past the 97 min the days
    // leave beside reading, problems and session, so one design.
    const oct = { reading: 65, practice: { "problem-set": 170, "design-exercise": 77, mock: 30, session: 18 } };
    expect(fitWeekToDays(oct, { "problem-set": 170 }, 70, 5, true)).toEqual({
      reading: 112,
      practice: { "problem-set": 170, "design-exercise": 50, mock: 0, session: 18 },
      blocks: { "design-exercise": 1, mock: 0 },
    });
    // Without whole blocks only the excess goes, from the formats without a run, by their minutes.
    expect(fitWeekToDays({ reading: 180, practice: { "problem-set": 108, recall: 72 } }, {}, 70, 5, false)).toEqual({
      reading: 180,
      practice: { "problem-set": 102, recall: 68 },
      blocks: {},
    });
    // A run past the days leaves nothing for blocks, takes what it can from the rest, then from reading: 50 + 300.
    expect(fitWeekToDays({ reading: 60, practice: { "problem-set": 300, mock: 40, recall: 20 } }, { "problem-set": 300 }, 70, 5, true)).toEqual({
      reading: 50,
      practice: { "problem-set": 300, mock: 0, recall: 0 },
      blocks: { mock: 0 },
    });
  });

  it("gives what a run frees to reading when no block can take it", () => {
    const perItem = { ...split, formats: [split.formats[0], { ...split.formats[3], share: 44 }] };
    const plain = practiceBudgets(perItem, 360, materials);
    expect(plain).toEqual({ reading: 76, practice: { "problem-set": 159, recall: 125 } });
    expect(weekPracticeTime(plain, { "problem-set": 100 })).toEqual({ reading: 135, practice: { "problem-set": 100, recall: 125 } });
  });

  describe("held by the week's checks", () => {
    const item = (n: number): PracticeRef => {
      const it = PROBLEM_ITEMS[n - 1];
      return { format: "problem-set", id: "L", task: it.title, done: "solved", minutes: itemMinutes("problem-set", it), generated: false, itemFrom: n, itemTo: n };
    };
    const design: PracticeRef = { format: "design-exercise", id: null, task: "Design a URL shortener", done: "covers the rubric", minutes: 50, generated: true };
    const read = (id: string, minutes: number): MaterialRef => ({ id, tier: "must", minutes, note: null });
    const week = (days: { materials?: MaterialRef[]; practice?: PracticeRef[] }[]) => {
      const children = days.map((d, i) => makeNode({ id: `d${i + 1}`, level: "day", title: `D${i + 1}`, summary: "s", len: 1, ...d }));
      const w1 = makeNode({ id: "w1", level: "week", title: "W", summary: "s", len: 5, children, practiceCovers: [{ format: "problem-set", id: "L", note: null, itemFrom: 1, itemTo: 9 }] });
      const root = layout(makeRoot([w1]));
      return levelChecks({ root, nodes: w1.children!, leaves: true, top: false, materials, unknownIds: [], hoursPerWeek: 6, daysPerWeek: 5, split });
    };

    it("does not call a week's problems short once it does every item it reserved", () => {
      // Run 3's Week 1 as drafted: all nine items, 76 min of reading and 6 of recall, no design or mock: 274 of 360 min.
      const out = week([
        { materials: [read("R1", 30)], practice: [item(1), item(2)] },
        { materials: [read("R2", 46)], practice: [item(3)] },
        { practice: [item(4), item(5)] },
        { practice: [item(6), item(7)] },
        { practice: [item(8), item(9)] },
      ]);
      expect(out.breaches).toEqual([]);
      // Design's 52 min are one 50-min block; Mock's 31 are none, so only Design is short.
      expect(out.facts.filter((f) => f.includes("short"))).toEqual(["Week 1 practice short: Design 0 of about 50 min"]);
    });

    it("passes a week whose days write a design block in the time its run leaves", () => {
      const out = week([
        { materials: [read("R1", 30)], practice: [item(1), item(2)] },
        { materials: [read("R2", 46)], practice: [item(3)] },
        { practice: [item(4), item(5)] },
        { practice: [item(6), item(7), item(8)] },
        { practice: [item(9), design] },
      ]);
      expect(out.breaches).toEqual([]);
      expect(out.facts.filter((f) => f.includes("Problems"))).toEqual([]);
    });
  });
});

