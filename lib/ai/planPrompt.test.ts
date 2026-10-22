import { describe, expect, it } from "vitest";
import { layout, makeNode, makeRoot, type NewNodeInput } from "@/lib/planTree";
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
    const text = renderTree(root, { daysPerWeek: 7, refs: assignRefs(root), lockBefore: 1, markId: "w2" });
    expect(text).toBe(
      [
        'Week 1 [n1] (2 days): "Inference fundamentals" — The vocabulary.',
        '  Day 1 [n2]: "Intro" — What inference is. [done]',
        '  Day 2 [n3]: "Metrics" — Latency and throughput.',
        '>> Week 2 [n4] (7 days): "GPUs" — Where time goes. [not yet planned in detail]',
      ].join("\n"),
    );
  });
  it("marks week-sized leaves", () => {
    const root = makeRoot([makeNode({ id: "w", level: "week", title: "A", summary: "b", len: 7, budgetHours: 6 })]);
    expect(renderTree(root, { daysPerWeek: 7 })).toContain("[week-sized unit, logged as sessions]");
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
      weeks: 4,
      daysPerWeek: 7,
      unitsAreLeaves: false,
    });
    expect(prompt).toContain("Split the plan into 4 weeks");
    expect(prompt).toContain("The whole plan is 4 weeks long. Each week's days are numbered from Day 1.");
    expect(prompt).toContain("1. Week 1 (7 study days)");
    expect(prompt).toContain("4. Week 4 (8 study days)");
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
      weeks: 1,
      daysPerWeek: 7,
      tree: root,
      parentId: "w2",
      unitsAreLeaves: true,
    });
    expect(prompt).toContain('>> Week 2 (7 days): "GPUs"');
    expect(prompt).toContain("Plan the days inside the unit marked");
    // A week's days are numbered from Day 1, wherever the week sits in the plan.
    expect(prompt).toContain("1. Day 1\n");
    expect(prompt).toContain("7. Day 7\n");
    expect(prompt).toContain("Each day is one focused lesson");
  });
  it("describes week leaves as session goals", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: [], granularity: "week", level: "week", spans: [7], weeks: 1, daysPerWeek: 7, unitsAreLeaves: true });
    expect(prompt).toContain("across several sessions");
  });
});

describe("buildRevisionPrompt", () => {
  it("shows refs and the rules", () => {
    const root = tree();
    const prompt = buildRevisionPrompt({ topic: "AI infra", materials: [], granularity: "day", daysPerWeek: 7, tree: root, refs: assignRefs(root), lockBefore: 1, changeRequest: "Swap Week 1 and Week 2" });
    expect(prompt).toContain('The learner asks: "Swap Week 1 and Week 2"');
    expect(prompt).toContain("Day 1 [n2]");
    expect(prompt).toContain("[done]");
    expect(prompt).toContain("Keep the ref of every unit you keep");
  });
});

describe("buildPlanChatSystemPrompt", () => {
  it("states locks in adjust mode and lists the plan", () => {
    const prompt = buildPlanChatSystemPrompt({ mode: "adjust", topic: "AI infra", materials: [], granularity: "day", daysPerWeek: 7, tree: tree(), lockBefore: 1 });
    expect(prompt).toContain("Units marked done or locked are completed");
    expect(prompt).toContain("Plan length: 2 weeks, usually 7 study days a week");
    expect(prompt).toContain('Week 2 (7 days): "GPUs"');
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
    const prompt = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "month", spans: [28, 28], weeks: 8, daysPerWeek: 7, unitsAreLeaves: false });
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
    const prompt = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "week", spans: [7, 7], weeks: 2, daysPerWeek: 7, tree: root, parentId: "m1", unitsAreLeaves: true });
    expect(prompt).toContain("1. Week 1 (7 study days) — budget about 6 h, so about 3.6 h of must-reading");
    expect(prompt).toContain("This unit's reservation, the only resources its weeks may use: M1 (ch. 1–4).");
    expect(prompt).not.toContain("Held by other units");
    expect(prompt).toContain("at least one must per unit");
    expect(prompt).toContain("{covers M1 (ch. 1–4)}");
  });

  it("leaves materials out when the plan has none", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: [], granularity: "day", level: "day", spans: [1], weeks: 1, daysPerWeek: 7, unitsAreLeaves: true });
    expect(prompt).not.toMatch(/materials|"covers"|must/i);
    expect(prompt).not.toMatch(/search the web/i);
  });

  it("shows references in revision and chat prompts", () => {
    const root = makeRoot([makeNode({ id: "d1", level: "day", title: "A", summary: "b", len: 1, materials: [{ id: "M2", tier: "must", minutes: 15, note: null }] })]);
    const revision = buildRevisionPrompt({ topic: "X", materials: MATERIALS, granularity: "day", daysPerWeek: 7, tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "make the talk optional" });
    expect(revision).toContain("{reads M2 must 15 min}");
    expect(revision).toContain('changes that row\'s tier to "should"');
    const chat = buildPlanChatSystemPrompt({ mode: "create", topic: "X", materials: MATERIALS, granularity: "day", daysPerWeek: 7, tree: root, lockBefore: 0 });
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
    const heading = buildUnitsPrompt({ topic: "X", materials: withToc, granularity: "week", level: "month", spans: [28, 28], weeks: 8, daysPerWeek: 7, unitsAreLeaves: false });
    expect(heading).toContain("M1's chapters are resources of their own (M1.1, M1.2, …): reserve them in order across the units, each chapter in exactly one unit, and never refer to M1 itself.");
    expect(heading).toContain('M1.1 ch. 1 "Alpha"');
    const leaf = buildUnitsPrompt({ topic: "X", materials: withToc, granularity: "week", level: "week", spans: [7, 7], weeks: 2, daysPerWeek: 7, unitsAreLeaves: true });
    expect(leaf).toContain("A chapter longer than one unit's reading time spans consecutive units");
    expect(leaf).toContain("never refer to M1 itself");
    const leafNoList = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "week", spans: [7, 7], weeks: 2, daysPerWeek: 7, unitsAreLeaves: true });
    expect(leafNoList).toContain("M1 is the backbone textbook, but its chapters are not listed: it runs in order across the units");
  });
  it("a saved material with toc undefined renders no chapter lines and gets the no-list rule", () => {
    const saved = MATERIALS.map((m) => ({ ...m, toc: undefined }));
    const prompt = buildUnitsPrompt({ topic: "X", materials: saved, granularity: "week", level: "month", spans: [28], weeks: 4, daysPerWeek: 7, unitsAreLeaves: false });
    expect(prompt).not.toMatch(/^ {2}ch\. /m);
    expect(prompt).toContain("but its chapters are not listed");
  });
  it("revision prompts show sections and chat prompts do not", () => {
    const root = makeRoot([makeNode({ id: "d1", level: "day", title: "A", summary: "b", len: 1 })]);
    expect(buildRevisionPrompt({ topic: "X", materials: withToc, granularity: "day", daysPerWeek: 7, tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "x" })).toContain("— A1; A2");
    const chat = buildPlanChatSystemPrompt({ mode: "create", topic: "X", materials: withToc, granularity: "day", daysPerWeek: 7, tree: root, lockBefore: 0 });
    expect(chat).toContain('ch. 2 "Beta"');
    expect(chat).not.toContain("— A1; A2");
  });
  it("says nothing about chapters when no book is listed", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: [MATERIALS[1]], granularity: "day", level: "day", spans: [1], weeks: 1, daysPerWeek: 7, unitsAreLeaves: true });
    expect(prompt).not.toMatch(/chapters are not listed|never refer to|chapter number/);
    expect(prompt).toContain("A resource is read once: do not assign what another unit reads.");
  });
});

describe("time and the split in prompts", () => {
  const sized: Material[] = [
    { ...MATERIALS[0], minutes: 1320, minutesBasis: "measured" },
    { ...MATERIALS[1], minutes: 300, minutesBasis: "estimated", uses: "units 1–4" },
  ];
  const base = { topic: "AI engineering", materials: sized, granularity: "week" as const, level: "week" as const, spans: [7, 7], weeks: 2, daysPerWeek: 7, unitsAreLeaves: true };

  it("shows each material's size and the part the plan uses", () => {
    expect(renderMaterials(sized)).toBe(
      [
        'M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024 <https://example.com/aie> · about 22 h. The backbone.',
        `M2 [video · the learner's own] "Intro talk" <https://youtu.be/x> · units 1–4, about 5 h (estimated)`,
      ].join("\n"),
    );
  });

  it("budgets later levels from the decided split and names the practice", () => {
    const split = { readingShare: 85, practice: "writing summaries", reason: "A knowledge topic." };
    const prompt = buildUnitsPrompt({ ...base, hoursPerWeek: 6, split });
    expect(prompt).toContain("How this plan spends that time: about 85% reading or watching the materials, the rest on writing summaries.");
    expect(prompt).toContain("— budget about 6 h, so about 5.1 h of must-reading");
    expect(prompt).toContain("must minutes stay within the must-reading on the unit's line, because the rest of the time is for writing summaries");
    expect(prompt).not.toContain('as "split"');
  });

  it("gives a day its share of its week, however many days the week has", () => {
    const prompt = buildUnitsPrompt({ ...base, granularity: "day", level: "day", spans: Array(7).fill(1), weeks: 1, hoursPerWeek: 30, split: { readingShare: 50, practice: "building", reason: "" } });
    expect(prompt).toContain("1. Day 1 — budget about 4.3 h\n");
    expect(prompt).toContain("Each day is one focused session of about 4.3 h.");
    const three = buildUnitsPrompt({ ...base, granularity: "day", level: "day", spans: [1, 1, 1], weeks: 1, daysPerWeek: 5, hoursPerWeek: 6 });
    expect(three).toContain("1. Day 1 — budget about 2 h");
    expect(three).toContain("3. Day 3 — budget about 2 h");
  });

  it("budgets a week's days over the week: no per-day must share, and a day may be all reading or all practice", () => {
    const prompt = buildUnitsPrompt({ ...base, granularity: "day", level: "day", spans: Array(5).fill(1), weeks: 1, daysPerWeek: 5, hoursPerWeek: 6, split: { readingShare: 50, practice: "building", reason: "" } });
    expect(prompt).toContain(
      "Rules: the week has about 3 h of reading; the rest of its time is for building. Across the week, the days' must minutes add up to no more than about 3 h. A day may be all reading or all practice, but each day's must, should and practice minutes fit within its own budget. A day that reads has at least one must; should items are optional extras.",
    );
    expect(prompt).not.toContain("of the unit's budget");
    expect(prompt).not.toContain("of must-reading");
    expect(prompt).not.toContain("long practice task");
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
    const chat = buildPlanChatSystemPrompt({ mode: "create", topic: "Couch to 5K", materials: [], granularity: "week", daysPerWeek: 7, hoursPerWeek: 3, split, tree, lockBefore: 0 });
    expect(chat).toContain("The learner's time: about 3 hours a week, over 7 study days a week.");
    expect(chat).toContain("the rest on running sessions");
    const revision = buildRevisionPrompt({ topic: "Couch to 5K", materials: [], granularity: "week", daysPerWeek: 7, hoursPerWeek: 3, split, tree, refs: assignRefs(tree), lockBefore: 0, changeRequest: "x" });
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
    // Review rows from before reviews were withdrawn are not shown to the model.
    expect(renderRefs(root.children![0].children![3], A)).toBe("");
    const w1 = root.children![0].children![0];
    w1.materials![1].note = "Post-Training; Sampling";
    expect(renderRefs(w1, A)).toBe("reads M1.1 must 107 min; M1.2 must 140 min (Post-Training; Sampling)");
    expect(renderRefs({ covers: [{ id: "aie", chapter: 1, note: null }, { id: "agents", note: "first half", activity: "review" }] }, A)).toBe("covers M1.1");
  });
  it("the availability block names the reservation and what other units hold", () => {
    const root = aiePlan();
    const w1 = root.children![0].children![0];
    w1.covers = w1.materials!.map((m) => ({ id: m.id, chapter: m.chapter, note: null }));
    delete w1.materials;
    layout(root);
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "day", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "day", spans: Array(7).fill(1), weeks: 13, daysPerWeek: 7, tree: root, parentId: "w1", unitsAreLeaves: true });
    expect(prompt).toContain("This unit's reservation, the only resources its days may use: M1.1–M1.2.\nHeld by other units: M1.3–M1.4 (Week 2); M3, M4 (Week 3); M1.5–M1.6, M2, M5 (Month 2); M1.10, M6, M7 (Month 3).");
    expect(prompt).not.toContain("Take them first from what the unit marked");
    expect(prompt).not.toContain("Where a book's chapters are listed");
  });
  it("review rows saved before reviews were withdrawn reserve nothing for the days, and the prompt never mentions reviewing", () => {
    const root = aiePlan();
    const w4 = root.children![0].children![3];
    w4.covers = w4.materials!.map((m) => ({ id: m.id, chapter: m.chapter, note: null, activity: "review" as const }));
    delete w4.materials;
    layout(root);
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "day", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "day", spans: Array(8).fill(1), weeks: 13, daysPerWeek: 7, tree: root, parentId: "w4", unitsAreLeaves: true });
    expect(prompt).toContain("This unit reserves nothing to read: its days read nothing and the time is for projects.");
    expect(prompt).not.toContain("may use: M1.1–M1.4");
    expect(prompt).not.toMatch(/review/i);
  });
  it("the top level is told everything is free", () => {
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", level: "month", spans: [30, 30, 30], weeks: 13, daysPerWeek: 7, unitsAreLeaves: false });
    expect(prompt).toContain("Every resource is free. Reserve each in at most one month; the book's chapters in order.");
    expect(prompt).toContain("Each resource is read in at most one unit at this level. M1's chapters are resources of their own (M1.1, M1.2, …): reserve them in order across the units, each chapter in exactly one unit, and never refer to M1 itself.");
    expect(prompt).toContain('list in "covers" the resources its weeks will read, as { id, note }.');
    expect(prompt).not.toMatch(/review|activity/i);
  });
  it("leaf rules state spanning, single reading, and that a unit with nothing left reads nothing", () => {
    const prompt = buildUnitsPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", hoursPerWeek: 6, split: { readingShare: 40, practice: "projects", reason: "r" }, level: "week", spans: [7, 7], weeks: 2, daysPerWeek: 7, unitsAreLeaves: true });
    expect(prompt).toContain('Materials: for each unit, list its Read table in "materials" as { id, tier, minutes, note }.');
    expect(prompt).toContain("Each resource's size is in the list. A chapter longer than one unit's reading time spans consecutive units: list it in each with the part in the note; across those units its minutes add up to its size. A resource is read once: do not assign what another unit reads, and never refer to M1 itself.");
    expect(prompt).toContain("A unit with nothing left to read in its reservation reads nothing: that time is for projects. Never assign a resource a unit before it already read.");
    expect(prompt).not.toMatch(/review|activity/i);
  });
  it("an unlisted backbone keeps the topic-only rule at both levels", () => {
    const m = [{ ...AIE_MATERIALS[0], toc: null }];
    expect(buildUnitsPrompt({ topic: "t", materials: m, granularity: "week", level: "month", spans: [30], weeks: 4, daysPerWeek: 7, unitsAreLeaves: false })).toContain("Never write a chapter number or a chapter title you were not given.");
    expect(buildUnitsPrompt({ topic: "t", materials: m, granularity: "week", level: "week", spans: [7], weeks: 1, daysPerWeek: 7, unitsAreLeaves: true })).toContain("its chapters are not listed");
  });
  it("the revision rule names chapter ids and the single reading", () => {
    const root = aiePlan();
    expect(buildRevisionPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", daysPerWeek: 7, tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "x" })).toContain(
      "Ids may name a resource (M3) or a chapter (M1.3); a resource is read in one unit.",
    );
  });
  it("the revision rule asks for practice rows and reservations to come back", () => {
    const root = aiePlan();
    const prompt = buildRevisionPrompt({ topic: "t", materials: AIE_MATERIALS, granularity: "week", daysPerWeek: 7, tree: root, refs: assignRefs(root), lockBefore: 0, changeRequest: "x" });
    expect(prompt).toContain('return "practiceCovers" (headings: { format, id, note }) and "practice" (units without children');
  });
});

describe("practice in prompts", () => {
  const PROBLEMS: Material = { ...MATERIALS[1], id: "M3", kind: "course", title: "NeetCode 150", practice: { format: "problem-set", items: 150, perItemMinutes: 10, minutes: null, answers: true } };
  const materials = [MATERIALS[0], PROBLEMS];
  const pick = (format: "problem-set" | "recall" | "lab" | "design-exercise", share: number, focus: string) => ({ format, share, focus, reason: "" });
  const split = { readingShare: 50, practice: "problems and recall", reason: "", formats: [pick("problem-set", 60, "arrays and hashing"), pick("recall", 40, "key terms")] };
  const week = (extra: Partial<NewNodeInput> = {}) => makeRoot([makeNode({ id: "w1", level: "week", title: "Arrays", summary: "s", len: 5, ...extra })]);
  const days = (extra: Partial<Parameters<typeof buildUnitsPrompt>[0]> = {}) =>
    buildUnitsPrompt({ topic: "Interviews", materials, granularity: "day", level: "day", spans: [1, 1, 1, 1, 1], weeks: 1, daysPerWeek: 5, hoursPerWeek: 6, split, tree: week(), parentId: "w1", unitsAreLeaves: true, ...extra });

  it("tells the days of a week each pick's minutes that week, its focus, its sources, its done condition and the half-a-day rule", () => {
    const prompt = days();
    // Six hours: three of reading, three of practice shared 60/40.
    expect(prompt).toContain("Practice: the week's time, about 6 h, is about 3 h of reading and, by format:");
    expect(prompt).toContain('- Problems (format "problem-set"): about 1.8 h this week, aimed at arrays and hashing. The learner solves many small problems, each with an answer to check against. Sources: M2. Every row names one of them; never write rows of this format yourself. Done when: solved and checked against the solution.');
    expect(prompt).toContain('- Recall (format "recall"): about 72 min this week, aimed at key terms.');
    expect(prompt).toContain('No source in the list: write the questions yourself from that unit\'s own reading, with id set to a resource the unit reads (an id from its "materials"); the reading holds the answers.');
    expect(prompt).toContain('list its practice rows in "practice" as { format, id, task, done, minutes }');
    // A day is 70 min (six hours over five days, to the nearest 5 min).
    expect(prompt).toContain("Place a task longer than half a day's budget (about 35 min) on a day of its own.");
  });
  it("lists what a split week reserved for its days", () => {
    const covers = [
      { format: "problem-set" as const, id: "M3", note: null, task: "Arrays 1–6", minutes: 40 },
      { format: "recall" as const, id: null, note: null, task: "Six questions on hashing", minutes: 15 },
    ];
    const prompt = days({ tree: week({ practiceCovers: covers }) });
    expect(prompt).toContain("Reserved for this unit: M2 40 min: Arrays 1–6.");
    expect(prompt).toContain("Reserved for this unit: generated 15 min: Six questions on hashing.");
  });
  it("asks for no rows of a pick with no source that is never written, and gives its time to reading", () => {
    const prompt = days({ split: { ...split, formats: [pick("problem-set", 50, "arrays"), pick("lab", 50, "git")] } });
    expect(prompt).not.toContain("Lab");
    expect(prompt).toContain("is about 4.5 h of reading and, by format:");
    expect(prompt).toContain('- Problems (format "problem-set"): about 1.5 h this week');
  });
  it("puts each pick's week minutes on the lines of week leaves", () => {
    const prompt = buildUnitsPrompt({ topic: "Interviews", materials, granularity: "week", level: "week", spans: [7, 7], weeks: 2, daysPerWeek: 7, hoursPerWeek: 6, split, unitsAreLeaves: true });
    expect(prompt).toContain("1. Week 1 (7 study days) — budget about 6 h, so about 3 h of must-reading; practice: Problems 1.8 h, Recall 72 min");
    expect(prompt).toContain('- Problems (format "problem-set"): about 1.8 h a week, aimed at arrays and hashing.');
  });
  it("states a week leaf's reading once: its line's must-reading is the practice rules' reading, a sourceless pick's time included", () => {
    const withLab = { ...split, formats: [pick("problem-set", 50, "arrays"), pick("lab", 50, "git")] };
    const prompt = buildUnitsPrompt({ topic: "Interviews", materials, granularity: "week", level: "week", spans: [7, 7], weeks: 2, daysPerWeek: 7, hoursPerWeek: 6, split: withLab, unitsAreLeaves: true });
    expect(prompt).toContain("is about 4.5 h of reading and, by format:");
    expect(prompt).toContain("1. Week 1 (7 study days) — budget about 6 h, so about 4.5 h of must-reading; practice: Problems 1.5 h");
    expect(prompt).not.toContain(`about ${withLab.readingShare}% of the unit's budget`);
  });
  it("asks headings to reserve each pick's sources in order, with the part in the note", () => {
    const prompt = buildUnitsPrompt({ topic: "Interviews", materials, granularity: "day", level: "month", spans: [20, 20], weeks: 8, daysPerWeek: 5, hoursPerWeek: 6, split, unitsAreLeaves: false });
    expect(prompt).toContain('list in "practiceCovers" the practice sources its weeks will use, as { format, id, note }');
    expect(prompt).toContain('- Problems (format "problem-set"), aimed at arrays and hashing: M2.');
    expect(prompt).toContain('- Recall (format "recall"), aimed at key terms: no source; its rows are written from the reading later, so reserve nothing for it.');
    expect(prompt).not.toContain('"practice" as');
  });
  it("says nothing about practice when the plan is all reading", () => {
    for (const s of [{ readingShare: 100, practice: "reading", reason: "", formats: [] }, { readingShare: 60, practice: "projects", reason: "" }]) {
      const leaf = days({ split: s });
      const heading = buildUnitsPrompt({ topic: "t", materials, granularity: "day", level: "month", spans: [20], weeks: 4, daysPerWeek: 5, split: s, unitsAreLeaves: false });
      for (const prompt of [leaf, heading]) {
        expect(prompt).not.toContain("Practice:");
        expect(prompt).not.toMatch(/"practice(Covers)?"/);
        expect(prompt).not.toContain("half a day");
      }
    }
  });
  it("tags practice sources in the materials list", () => {
    expect(renderMaterials(materials)).toContain('M2 [course · practice: Problems · the learner\'s own] "NeetCode 150"');
  });
  it("renders practice rows and reservations under prompt aliases", () => {
    const A = aliasMaterials([{ id: "uuid-0" }, { id: "uuid-1" }]);
    expect(renderRefs({ practiceCovers: [{ format: "problem-set", id: "uuid-1", note: "Arrays & Hashing" }] }, A)).toBe("practice covers Problems M2 (Arrays & Hashing)");
    expect(
      renderRefs(
        {
          practice: [
            { format: "problem-set", id: "uuid-1", task: "Arrays 1–6", done: "all pass", minutes: 40, generated: false },
            { format: "recall", id: "uuid-0", task: "Six questions", done: "checked", minutes: 15, generated: true },
          ],
        },
        A,
      ),
    ).toBe("practises Problems M2 40 min: Arrays 1–6; Recall M1 generated 15 min: Six questions");
  });
});
