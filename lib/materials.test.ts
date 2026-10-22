import { describe, expect, it } from "vitest";
import { layout, makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { MaterialRef, PracticeRef } from "@/lib/schemas/material";
import { AIE_HOURS, AIE_MATERIALS, AIE_SHARE, AIE_TOC, aiePlan } from "@/lib/__fixtures__/aiEngineeringPlan";
import {
  aliasMaterials,
  assignmentsOf,
  chapterGaps,
  chapterRegressions,
  dropBreaches,
  formatAliases,
  learnerMaterials,
  levelChecks,
  parseChapters,
  refKey,
  remapTreeRefs,
  removeMaterialRefs,
  resolveMaterialRefs,
  resolvePracticeCovers,
  resolvePracticeRefs,
  noSourceFacts,
  practiceBudgets,
  sizeChapterRows,
  tierMinutes,
  treeChecks,
  keptReadTable,
  keepPracticeCovers,
} from "./materials";

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
    expect(out.breaches.map((b) => b.text)).toEqual([
      "Week 1's must-reading is 247 min against a budget of about 144 min",
      "Week 2 reads M1.1, which Week 1 holds",
      "Week 2's must-reading is 326 min against a budget of about 144 min",
    ]);
    expect(out.facts).toContain("backbone ch. 7, 8, 9 not reserved");
    expect(out.nodes[out.breaches[1].index].id).toBe("w2");
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
    const { root, days } = week([
      { practice: [solve("Arrays 1–6", 65)] },
      { practice: [solve("Arrays 7–12", 65)] },
      { materials: [must("R1", 60)] },
      { materials: [must("R2", 60)] },
      { materials: [must("R3", 60)] },
    ]);
    const out = check(root, days);
    expect(out.breaches.map((b) => [b.kind, b.text])).toEqual([["over-budget", "Week 1's Problems practice is 130 min against a budget of about 90 min"]]);
    expect(out.facts).toEqual(["Week 1 practice short: Mock 0 of about 90 min"]);
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
    const w1 = makeNode({ id: "w1", level: "week", title: "W", summary: "s", len: 5, budgetHours: 6, materials: [must("R1", 150)], practice: [solve("Arrays 1–12", 130), mock] });
    const root = layout(makeRoot([w1]));
    const out = levelChecks({ root, nodes: [w1], leaves: true, top: true, materials, unknownIds: [], daysPerWeek: 5, split });
    expect(out.breaches.map((b) => b.text)).toEqual(["Week 1's Problems practice is 130 min against a budget of about 90 min"]);
  });
  it("treeChecks takes the split", () => {
    const { root } = week([{ practice: [solve("Arrays 1–12", 130)] }, { materials: [must("R1", 60)] }]);
    const out = treeChecks(root, materials, { granularity: "day", hoursPerWeek: 6, daysPerWeek: 5, split });
    expect(out.breaches.map((b) => b.text)).toContain("Week 1's Problems practice is 130 min against a budget of about 90 min");
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

  it("carries a generated recall reservation that cites its reading forward, since the model cannot write it back", () => {
    const recall = { format: "recall" as const, id: "book", note: null, task: "Six questions on hashing", minutes: 15 };
    expect(keepPracticeCovers([{ format: "problem-set", id: "neet", note: null }], [kept[0], recall], practiceOf)).toEqual([kept[0], recall]);
  });
});

