import { describe, expect, it } from "vitest";
import { layout, makeNode, makeRoot } from "@/lib/planTree";
import { aliasMaterials } from "@/lib/materials";
import { AIE_MATERIALS, AIE_TOC, aiePlan } from "@/lib/__fixtures__/aiEngineeringPlan";
import type { ChapterList, Material } from "@/lib/schemas/material";
import { assignRefs, buildPlanChatSystemPrompt, buildRevisionPrompt, buildUnitsPrompt, renderChapters, renderMaterials, renderRefs, renderTree } from "./planPrompt";

function tree() {
  return makeRoot([
    makeNode({
      id: "w1",
      level: "week",
      title: "Inference fundamentals",
      summary: "The vocabulary.",
      len: 2,
      children: [
        makeNode({ id: "d1", level: "day", title: "Intro", summary: "What inference is.", len: 1, status: "completed" }),
        makeNode({ id: "d2", level: "day", title: "Metrics", summary: "Latency and throughput.", len: 1 }),
      ],
    }),
    makeNode({ id: "w2", level: "week", title: "GPUs", summary: "Where time goes.", len: 7 }),
  ]);
}

describe("renderTree", () => {
  it("renders labels, spans, refs and marks", () => {
    const root = tree();
    const text = renderTree(root, { refs: assignRefs(root), lockBefore: 1, markId: "w2" });
    expect(text).toBe(
      [
        'Week 1 [n1] (Day 1–2, 2 days): "Inference fundamentals" — The vocabulary.',
        '  Day 1 [n2]: "Intro" — What inference is. [done]',
        '  Day 2 [n3]: "Metrics" — Latency and throughput.',
        '>> Week 2 [n4] (Day 3–9, 7 days): "GPUs" — Where time goes. [not yet planned in detail]',
      ].join("\n"),
    );
  });
  it("marks week-sized leaves", () => {
    const root = makeRoot([makeNode({ id: "w", level: "week", title: "A", summary: "b", len: 7, budgetHours: 6 })]);
    expect(renderTree(root)).toContain("[week-sized unit, logged as sessions]");
  });
});

describe("buildUnitsPrompt", () => {
  it("lists the spans and asks for exactly that many units", () => {
    const prompt = buildUnitsPrompt({
      topic: "AI infra",
      materials: [],
      granularity: "day",
      level: "week",
      spans: [7, 7, 8, 8],
      startDay: 1,
      totalDays: 30,
      unitsAreLeaves: false,
    });
    expect(prompt).toContain("Split the plan into 4 weeks");
    expect(prompt).toContain("1. Days 1–7 (7 days)");
    expect(prompt).toContain("4. Days 23–30 (8 days)");
    expect(prompt).toContain("Return exactly 4 units");
    expect(prompt).toContain("heading that will be planned in detail later");
  });
  it("includes the tree and marks the parent when expanding", () => {
    const root = tree();
    const prompt = buildUnitsPrompt({
      topic: "AI infra",
      materials: [],
      granularity: "day",
      level: "day",
      spans: [1, 1, 1, 1, 1, 1, 1],
      startDay: 3,
      totalDays: 9,
      tree: root,
      parentId: "w2",
      unitsAreLeaves: true,
    });
    expect(prompt).toContain('>> Week 2 (Day 3–9, 7 days): "GPUs"');
    expect(prompt).toContain("Plan the days inside the unit marked");
    expect(prompt).toContain("1. Day 3");
    expect(prompt).toContain("Each day is one focused lesson");
  });
  it("describes week leaves as session goals", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: [], granularity: "week", level: "week", spans: [7], startDay: 1, totalDays: 7, unitsAreLeaves: true });
    expect(prompt).toContain("across several sessions");
  });
});

describe("buildRevisionPrompt", () => {
  it("shows refs and the rules", () => {
    const root = tree();
    const prompt = buildRevisionPrompt({ topic: "AI infra", materials: [], granularity: "day", tree: root, refs: assignRefs(root), lockBefore: 1, changeRequest: "Swap Week 1 and Week 2" });
    expect(prompt).toContain('The learner asks: "Swap Week 1 and Week 2"');
    expect(prompt).toContain("Day 1 [n2]");
    expect(prompt).toContain("[done]");
    expect(prompt).toContain("Keep the ref of every unit you keep");
  });
});

describe("buildPlanChatSystemPrompt", () => {
  it("states locks in adjust mode and lists the plan", () => {
    const prompt = buildPlanChatSystemPrompt({ mode: "adjust", topic: "AI infra", materials: [], granularity: "day", tree: tree(), lockBefore: 1 });
    expect(prompt).toContain("Day 1 is completed and locked");
    expect(prompt).toContain('Week 2 (Day 3–9, 7 days): "GPUs"');
    expect(prompt).toContain("call revisePlan exactly once");
  });
});

const MATERIALS: Material[] = [
  { id: "M1", origin: "research", type: "link", kind: "book", url: "https://example.com/aie", title: "AI Engineering", author: "Chip Huyen", year: 2024, why: "The backbone.", backbone: true, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null },
  { id: "M2", origin: "learner", type: "youtube", kind: "video", url: "https://youtu.be/x", title: "Intro talk", author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null },
];

describe("materials in prompts", () => {
  it("renders the list with ids, tags and bylines", () => {
    expect(renderMaterials(MATERIALS)).toBe(
      [
        'M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024 <https://example.com/aie>. The backbone.',
        `M2 [video · the learner's own] "Intro talk" <https://youtu.be/x>`,
      ].join("\n"),
    );
  });

  it("renders references under prompt aliases, whatever the real ids are", () => {
    const saved = MATERIALS.map((m, i) => ({ ...m, id: `uuid-${i}` }));
    const text = renderRefs(
      { covers: [{ id: "uuid-0", note: "ch. 1–2" }], materials: [{ id: "uuid-1", tier: "should", minutes: 20, note: null }] },
      aliasMaterials(saved),
    );
    expect(text).toBe("covers M1 (ch. 1–2) · reads M2 should 20 min");
  });

  it("asks headings to reserve the backbone's chapters in order, with no tier or minutes", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "month", spans: [28, 28], startDay: 1, totalDays: 56, unitsAreLeaves: false });
    expect(prompt).toContain('list in "covers"');
    expect(prompt).toContain("No tier and no minutes yet");
    expect(prompt).toContain("M1 is the backbone textbook, but its chapters are not listed: reserve it in order across the units");
    expect(prompt).toContain("Never write a chapter number or a chapter title you were not given.");
    expect(prompt).toContain("Each resource is read in at most one unit at this level.");
  });

  it("gives leaves their budget, the parent's reservation, and the must rules", () => {
    const root = makeRoot([
      makeNode({ id: "m1", level: "month", title: "Foundations", summary: "s", len: 14, covers: [{ id: "M1", note: "ch. 1–4" }] }),
    ]);
    const prompt = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "week", spans: [7, 7], startDay: 1, totalDays: 14, tree: root, parentId: "m1", unitsAreLeaves: true });
    expect(prompt).toContain("1. Days 1–7 (7 days) — budget about 6 h, so about 3.6 h of must-reading");
    expect(prompt).toContain("This unit's reservation, the only resources its weeks may use: M1 (ch. 1–4).");
    expect(prompt).not.toContain("Held by other units");
    expect(prompt).toContain("at least one must per unit");
    expect(prompt).toContain("{covers M1 (ch. 1–4)}");
  });

  it("leaves materials out when the plan has none", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: [], granularity: "day", level: "day", spans: [1], startDay: 1, totalDays: 1, unitsAreLeaves: true });
    expect(prompt).not.toMatch(/materials|"covers"|must/i);
    expect(prompt).not.toMatch(/search the web/i);
  });

  it("shows references in revision and chat prompts", () => {
    const root = makeRoot([makeNode({ id: "d1", level: "day", title: "A", summary: "b", len: 1, materials: [{ id: "M2", tier: "must", minutes: 15, note: null }] })]);
    const revision = buildRevisionPrompt({ topic: "X", materials: MATERIALS, granularity: "day", tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "make the talk optional" });
    expect(revision).toContain("{reads M2 must 15 min}");
    expect(revision).toContain('changes that row\'s tier to "should"');
    const chat = buildPlanChatSystemPrompt({ mode: "create", topic: "X", materials: MATERIALS, granularity: "day", tree: root, lockBefore: 0 });
    expect(chat).toContain('M1 [book · backbone] "AI Engineering"');
    expect(chat).toContain("{reads M2 must 15 min}");
  });
});

describe("chapters in prompts", () => {
  const TOC: ChapterList = {
    source: "catalogue",
    url: "https://openlibrary.org/books/OL1M",
    printPages: true,
    end: 100,
    chapters: [
      { n: 1, title: "Alpha", page: 10, minutes: 200, sections: ["A1", "A2"] },
      { n: 2, title: "Beta", page: 30, minutes: 400, sections: [] },
      { n: 3, title: "Gamma", page: 70, minutes: 300, sections: ["G1"] },
    ],
  };
  const withToc: Material[] = [{ ...MATERIALS[0], toc: TOC }, MATERIALS[1]];

  it("renders chapter lines under the book, with sections for the backbone when asked", () => {
    expect(renderMaterials(withToc, undefined, { sections: true })).toBe(
      [
        'M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024 <https://example.com/aie>. The backbone. Refer to its chapters by id; M1 itself is not a resource.',
        '  M1.1 ch. 1 "Alpha" · pp. 10–29 · about 3.3 h — A1; A2',
        '  M1.2 ch. 2 "Beta" · pp. 30–69 · about 6.7 h',
        '  M1.3 ch. 3 "Gamma" · pp. 70–99 · about 5 h — G1',
        "  (chapters from Open Library)",
        `M2 [video · the learner's own] "Intro talk" <https://youtu.be/x>`,
      ].join("\n"),
    );
    expect(renderMaterials(withToc)).not.toContain("A1; A2");
  });
  it("omits the number, the pages and the size when the list has none, and names the page host", () => {
    const sparse: ChapterList = {
      source: "page",
      url: "https://www.example.org/review?x=1",
      printPages: false,
      end: null,
      chapters: [
        { n: null, title: "Alpha", page: null, minutes: null, sections: [] },
        { n: null, title: "Beta", page: null, minutes: null, sections: [] },
        { n: null, title: "Gamma", page: null, minutes: null, sections: [] },
      ],
    };
    expect(renderChapters(sparse, { sections: true })).toEqual(['  "Alpha"', '  "Beta"', '  "Gamma"', "  (chapters from example.org)"]);
  });
  it("switches the backbone rules on the list, at both levels", () => {
    const heading = buildUnitsPrompt({ topic: "X", materials: withToc, granularity: "week", level: "month", spans: [28, 28], startDay: 1, totalDays: 56, unitsAreLeaves: false });
    expect(heading).toContain("M1's chapters are resources of their own (M1.1, M1.2, …): reserve them in order across the units, each chapter in exactly one unit, and never refer to M1 itself.");
    expect(heading).toContain('M1.1 ch. 1 "Alpha"');
    const leaf = buildUnitsPrompt({ topic: "X", materials: withToc, granularity: "week", level: "week", spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true });
    expect(leaf).toContain("A chapter longer than one unit's reading time spans consecutive units");
    expect(leaf).toContain("never refer to M1 itself");
    const leafNoList = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "week", spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true });
    expect(leafNoList).toContain("M1 is the backbone textbook, but its chapters are not listed: it runs in order across the units");
  });
  it("a saved material with toc undefined renders no chapter lines and gets the no-list rule", () => {
    const saved = MATERIALS.map((m) => ({ ...m, toc: undefined }));
    const prompt = buildUnitsPrompt({ topic: "X", materials: saved, granularity: "week", level: "month", spans: [28], startDay: 1, totalDays: 28, unitsAreLeaves: false });
    expect(prompt).not.toMatch(/^ {2}ch\. /m);
    expect(prompt).toContain("but its chapters are not listed");
  });
  it("revision prompts show sections and chat prompts do not", () => {
    const root = makeRoot([makeNode({ id: "d1", level: "day", title: "A", summary: "b", len: 1 })]);
    expect(buildRevisionPrompt({ topic: "X", materials: withToc, granularity: "day", tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "x" })).toContain("— A1; A2");
    const chat = buildPlanChatSystemPrompt({ mode: "create", topic: "X", materials: withToc, granularity: "day", tree: root, lockBefore: 0 });
    expect(chat).toContain('ch. 2 "Beta"');
    expect(chat).not.toContain("— A1; A2");
  });
  it("says nothing about chapters when no book is listed", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: [MATERIALS[1]], granularity: "day", level: "day", spans: [1], startDay: 1, totalDays: 1, unitsAreLeaves: true });
    expect(prompt).not.toMatch(/chapters are not listed|never refer to|chapter number/);
    expect(prompt).toContain("A resource is read once: do not assign what another unit reads.");
  });
});

describe("time and the split in prompts", () => {
  const sized: Material[] = [
    { ...MATERIALS[0], minutes: 1320, minutesBasis: "measured" },
    { ...MATERIALS[1], minutes: 300, minutesBasis: "estimated", uses: "units 1–4" },
  ];
  const base = { topic: "AI engineering", materials: sized, granularity: "week" as const, level: "week" as const, spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true };

  it("shows each material's size and the part the plan uses", () => {
    expect(renderMaterials(sized)).toBe(
      [
        'M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024 <https://example.com/aie> · about 22 h. The backbone.',
        `M2 [video · the learner's own] "Intro talk" <https://youtu.be/x> · units 1–4, about 5 h (estimated)`,
      ].join("\n"),
    );
  });

  it("asks the top level of a new plan to decide the split, and states no share yet", () => {
    const prompt = buildUnitsPrompt({ ...base, hoursPerWeek: 10, decideSplit: true });
    expect(prompt).toContain("The learner's time: about 10 hours a week.");
    expect(prompt).toContain('First decide how this learner\'s time divides, as "split".');
    expect(prompt).toContain("1. Days 1–7 (7 days) — budget about 10 h\n");
    expect(prompt).toContain("must minutes stay within your readingShare of the unit's budget");
    expect(prompt).not.toContain("building and practice");
    expect(prompt).toContain("Each resource's size is in the list.");
  });

  it("budgets later levels from the decided split and names the practice", () => {
    const split = { readingShare: 85, practice: "writing summaries", reason: "A knowledge topic." };
    const prompt = buildUnitsPrompt({ ...base, hoursPerWeek: 6, split });
    expect(prompt).toContain("How this plan spends that time: about 85% reading or watching the materials, the rest on writing summaries.");
    expect(prompt).toContain("— budget about 6 h, so about 5.1 h of must-reading");
    expect(prompt).toContain("must minutes stay within about 85% of the unit's budget, because the rest of the time is for writing summaries");
    expect(prompt).not.toContain('as "split"');
  });

  it("gives a day its share of the week", () => {
    const prompt = buildUnitsPrompt({ ...base, granularity: "day", level: "day", spans: [1, 1], totalDays: 2, hoursPerWeek: 30, split: { readingShare: 50, practice: "building", reason: "" } });
    expect(prompt).toContain("1. Day 1 — budget about 4.3 h, so about 2.2 h of must-reading");
    expect(prompt).toContain("Each day is one focused session of about 4.3 h.");
  });

  it("keeps the old wording and the fixed share when no hours or split are given", () => {
    const prompt = buildUnitsPrompt({ ...base, materials: MATERIALS });
    expect(prompt).not.toContain("The learner's time");
    expect(prompt).toContain("— budget about 6 h, so about 3.6 h of must-reading");
    expect(prompt).toContain("because the rest of the time is for building and practice");
  });

  it("tells the conversation and revisions about the time and the split", () => {
    const split = { readingShare: 10, practice: "running sessions", reason: "Training." };
    const tree = makeRoot([makeNode({ id: "w1", level: "week", title: "Base", summary: "s", len: 7, budgetHours: 3 })]);
    const chat = buildPlanChatSystemPrompt({ mode: "create", topic: "Couch to 5K", materials: [], granularity: "week", hoursPerWeek: 3, split, tree, lockBefore: 0 });
    expect(chat).toContain("The learner's time: about 3 hours a week.");
    expect(chat).toContain("the rest on running sessions");
    const revision = buildRevisionPrompt({ topic: "Couch to 5K", materials: [], granularity: "week", hoursPerWeek: 3, split, tree, refs: assignRefs(tree), lockBefore: 0, changeRequest: "x" });
    expect(revision).toContain("about 10% reading or watching the materials");
  });
});

describe("chapters as resources in prompts", () => {
  const A = aliasMaterials(AIE_MATERIALS);
  it("renders chapter lines with aliases and the not-a-resource sentence", () => {
    const text = renderMaterials(AIE_MATERIALS, undefined, { sections: true });
    expect(text).toContain('"AI Engineering: Building Applications with Foundation Models" — Chip Huyen, 2024 <https://example.com/aie> · about 18.4 h. Refer to its chapters by id; M1 itself is not a resource.');
    expect(text).toContain('  M1.2 ch. 2 "Understanding Foundation Models" · about 2.3 h — Training Data; Modeling; Post-Training; Sampling');
    expect(text).toContain('  M1.10 ch. 10 "AI Engineering Architecture and User Feedback" · about 1.6 h');
    expect(renderMaterials([AIE_MATERIALS[1]])).not.toContain("not a resource");
  });
  it("unnumbered chapters keep their alias and lose the ch. prefix", () => {
    const m = { ...AIE_MATERIALS[0], toc: { ...AIE_TOC, chapters: AIE_TOC.chapters.slice(0, 3).map((c) => ({ ...c, n: null })) } };
    expect(renderMaterials([m])).toContain('  M1.2 "Understanding Foundation Models" · about 2.3 h');
  });
  it("renders references with collapsed chapter runs and activities", () => {
    const root = aiePlan();
    expect(renderRefs(root.children![0], A)).toBe("covers M1.1–M1.4, M3, M4");
    expect(renderRefs(root.children![0].children![3], A)).toBe("reviews M1.1 must 15 min; M1.2 must 15 min; M1.3 must 15 min; M1.4 must 15 min");
    const w1 = root.children![0].children![0];
    w1.materials![1].note = "Post-Training; Sampling";
    expect(renderRefs(w1, A)).toBe("reads M1.1 must 107 min; M1.2 must 140 min (Post-Training; Sampling)");
    expect(renderRefs({ covers: [{ id: "aie", chapter: 1, note: null }, { id: "agents", note: "first half", activity: "review" }] }, A)).toBe("covers M1.1 · reviews M2 (first half)");
  });
  it("the availability block names the reservation and what other units hold", () => {
    const root = aiePlan();
    const w1 = root.children![0].children![0];
    w1.covers = w1.materials!.map((m) => ({ id: m.id, chapter: m.chapter, note: null }));
    delete w1.materials;
    layout(root);
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "day", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "day", spans: Array(7).fill(1), startDay: 1, totalDays: 90, tree: root, parentId: "w1", unitsAreLeaves: true });
    expect(prompt).toContain("This unit's reservation, the only resources its days may use: M1.1–M1.2.\nHeld by other units: M1.3–M1.4 (Week 2); M3, M4 (Week 3); M1.5–M1.6, M2, M5 (Month 2); M1.10, M6, M7 (Month 3).");
    expect(prompt).not.toContain("Take them first from what the unit marked");
    expect(prompt).not.toContain("Where a book's chapters are listed");
  });
  it("review covers are offered to review, never as resources to read", () => {
    const root = aiePlan();
    const w4 = root.children![0].children![3];
    w4.covers = w4.materials!.map((m) => ({ id: m.id, chapter: m.chapter, note: null, activity: "review" as const }));
    delete w4.materials;
    layout(root);
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "day", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "day", spans: Array(8).fill(1), startDay: 23, totalDays: 90, tree: root, parentId: "w4", unitsAreLeaves: true });
    expect(prompt).toContain("This unit reserves nothing to read: its days may only review.\nTo review (activity \"review\"): M1.1–M1.4.");
    expect(prompt).not.toContain("may use: M1.1–M1.4");
  });
  it("the top level is told everything is free", () => {
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", level: "month", spans: [30, 30, 30], startDay: 1, totalDays: 90, unitsAreLeaves: false, decideSplit: true });
    expect(prompt).toContain("Every resource is free. Reserve each in at most one month; the book's chapters in order.");
    expect(prompt).toContain("Each resource is read in at most one unit at this level. M1's chapters are resources of their own (M1.1, M1.2, …): reserve them in order across the units, each chapter in exactly one unit, and never refer to M1 itself.");
    expect(prompt).toContain('A unit may also reserve a review of resources that an earlier unit reads, with activity "review". A review is not a reading, so it may name resources another unit holds.');
  });
  it("leaf rules state spanning, single reading, and reviews", () => {
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "week", spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true });
    expect(prompt).toContain('Materials: for each unit, list its Read table in "materials" as { id, tier, minutes, note, activity }.');
    expect(prompt).toContain("Each resource's size is in the list. A chapter longer than one unit's reading time spans consecutive units: list it in each with the part in the note; across those units its minutes add up to its size. A resource is read once: do not assign what another unit reads, and never refer to M1 itself.");
    expect(prompt).toContain('A review (activity "review") revisits a resource an earlier unit read. Its minutes count for this unit, and it may name resources other units hold.');
  });
  it("an unlisted backbone keeps the topic-only rule at both levels", () => {
    const m = [{ ...AIE_MATERIALS[0], toc: null }];
    expect(buildUnitsPrompt({ topic: "t", materials: m, granularity: "week", level: "month", spans: [30], startDay: 1, totalDays: 30, unitsAreLeaves: false })).toContain("Never write a chapter number or a chapter title you were not given.");
    expect(buildUnitsPrompt({ topic: "t", materials: m, granularity: "week", level: "week", spans: [7], startDay: 1, totalDays: 7, unitsAreLeaves: true })).toContain("its chapters are not listed");
  });
  it("the revision rule names chapter ids and reviews", () => {
    const root = aiePlan();
    expect(buildRevisionPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "x" })).toContain(
      'Ids may name a resource (M3) or a chapter (M1.3); a resource is read in one unit, and a review of something read earlier has activity "review".',
    );
  });
});
