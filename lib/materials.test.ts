import { describe, expect, it } from "vitest";
import { makeNode, makeRoot } from "@/lib/planTree";
import {
  aliasMaterials,
  assignmentsOf,
  chapterGaps,
  chapterRegressions,
  learnerMaterials,
  levelFacts,
  parseChapters,
  remapTreeRefs,
  removeMaterialRefs,
  resolveMaterialRefs,
  tierMinutes,
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
  const aliases = aliasMaterials([{ id: "uuid-a" }, { id: "uuid-b" }]);
  it("maps list positions to M ids and back", () => {
    expect(aliases.alias("uuid-b")).toBe("M2");
    expect(aliases.resolve("m1")).toBe("uuid-a");
    expect(aliases.resolve("M9")).toBeUndefined();
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

describe("levelFacts", () => {
  it("reports unknown ids, missing musts, over-budget weeks and chapter regressions", () => {
    const w1 = makeNode({ id: "w1", level: "week", title: "A", summary: "a", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "must", minutes: 400, note: "ch. 3" }] });
    const w2 = makeNode({ id: "w2", level: "week", title: "B", summary: "b", len: 7, budgetHours: 6, materials: [{ id: "B", tier: "should", minutes: 30, note: "ch. 2" }] });
    const root = makeRoot([w1, w2]);
    expect(levelFacts({ root, nodes: [w1, w2], leaves: true, top: true, backboneId: "B", unknownIds: ["M9"] })).toEqual([
      "dropped unknown M9",
      "no must: Week 2",
      "Week 1 over budget: 400 of 360 min",
      "backbone ch. 2 after ch. 3 (Week 2)",
    ]);
  });
  it("reports backbone chapters no top-level heading reserves", () => {
    const m1 = makeNode({ id: "m1", level: "month", title: "A", summary: "a", len: 28, covers: [{ id: "B", note: "ch. 1–2" }] });
    const m2 = makeNode({ id: "m2", level: "month", title: "B", summary: "b", len: 28, covers: [{ id: "B", note: "ch. 5" }] });
    const root = makeRoot([m1, m2]);
    expect(levelFacts({ root, nodes: [m1, m2], leaves: false, top: true, backboneId: "B", unknownIds: [] })).toEqual(["backbone ch. 3, 4 not reserved"]);
  });
  it("continues chapter order from leaves earlier in the plan", () => {
    const d1 = makeNode({ id: "d1", level: "day", title: "A", summary: "a", len: 1, materials: [{ id: "B", tier: "must", minutes: 30, note: "ch. 4" }] });
    const d2 = makeNode({ id: "d2", level: "day", title: "B", summary: "b", len: 1, materials: [{ id: "B", tier: "must", minutes: 30, note: "ch. 2" }] });
    const root = makeRoot([makeNode({ id: "w1", level: "week", title: "W1", summary: "s", len: 1, children: [d1] }), makeNode({ id: "w2", level: "week", title: "W2", summary: "s", len: 1, children: [d2] })]);
    expect(levelFacts({ root, nodes: [root.children![1].children![0]], leaves: true, top: false, backboneId: "B", unknownIds: [] })).toEqual([
      "backbone ch. 2 after ch. 4 (Day 2)",
    ]);
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
