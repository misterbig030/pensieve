import { describe, expect, it } from "vitest";
import { makeNode, makeRoot } from "@/lib/planTree";
import { aliasMaterials } from "@/lib/materials";
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
    expect(prompt).toContain("Where a book's chapters are listed, name them as listed.");
  });

  it("gives leaves their budget, the parent's reservation, and the must rules", () => {
    const root = makeRoot([
      makeNode({ id: "m1", level: "month", title: "Foundations", summary: "s", len: 14, covers: [{ id: "M1", note: "ch. 1–4" }] }),
    ]);
    const prompt = buildUnitsPrompt({ topic: "X", materials: MATERIALS, granularity: "week", level: "week", spans: [7, 7], startDay: 1, totalDays: 14, tree: root, parentId: "m1", unitsAreLeaves: true });
    expect(prompt).toContain("1. Days 1–7 (7 days) — budget about 6 h, so about 3.6 h of must-reading");
    expect(prompt).toContain('reserved: M1 (ch. 1–4)');
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
        'M1 [book · backbone] "AI Engineering" — Chip Huyen, 2024 <https://example.com/aie>. The backbone.',
        '  ch. 1 "Alpha" · pp. 10–29 · about 3.3 h — A1; A2',
        '  ch. 2 "Beta" · pp. 30–69 · about 6.7 h',
        '  ch. 3 "Gamma" · pp. 70–99 · about 5 h — G1',
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
    expect(heading).toContain(
      "M1 is the backbone textbook and its chapters are listed above: reserve them in order across the units, each chapter in exactly one unit, and write the note as the chapter numbers and titles exactly as listed",
    );
    expect(heading).toContain('ch. 1 "Alpha"');
    const leaf = buildUnitsPrompt({ topic: "X", materials: withToc, granularity: "week", level: "week", spans: [7, 7], startDay: 1, totalDays: 14, unitsAreLeaves: true });
    expect(leaf).toContain("M1 is the backbone textbook and its chapters are listed above with their sizes");
    expect(leaf).toContain("A unit's minutes for it are the listed size of what it reads, or that share of a chapter.");
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
  it("leaves the general chapter line out when no book is listed", () => {
    const prompt = buildUnitsPrompt({ topic: "X", materials: [MATERIALS[1]], granularity: "day", level: "day", spans: [1], startDay: 1, totalDays: 1, unitsAreLeaves: true });
    expect(prompt).not.toContain("Where a book's chapters are listed");
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
    expect(prompt).toContain("never assign more of it than it has");
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
