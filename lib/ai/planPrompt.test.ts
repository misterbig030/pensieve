import { describe, expect, it } from "vitest";
import { makeNode, makeRoot } from "@/lib/planTree";
import { aliasMaterials } from "@/lib/materials";
import type { Material } from "@/lib/schemas/material";
import { assignRefs, buildPlanChatSystemPrompt, buildRevisionPrompt, buildUnitsPrompt, renderMaterials, renderRefs, renderTree } from "./planPrompt";

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
    expect(prompt).toContain("M1 is the backbone textbook: reserve its chapters in order");
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
