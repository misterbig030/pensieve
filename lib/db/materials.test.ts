import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { ChapterList, Material } from "@/lib/schemas/material";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { db } from "./client";
import { createTrackWithPlan, getTrackDetail, updateTrackStudyTime } from "./queries";
import { insertChildren, replacePlanTree } from "./planQueries";
import { nodeMaterials, nodePractice, sources } from "./schema";

function material(id: string, title: string, extra: Partial<Material> = {}): Material {
  return {
    id,
    origin: "research",
    type: "link",
    kind: "docs",
    url: `https://example.com/${id}`,
    title,
    author: null,
    year: null,
    why: null,
    backbone: false,
    verifiedAt: "2026-09-28T10:00:00.000Z",
    fetchedTitle: title,
    recommendedBy: [],
    sig: "sig",
    ...extra,
  };
}

const TOC: ChapterList = {
  source: "catalogue",
  url: "https://openlibrary.org/books/OL54058212M",
  printPages: false,
  end: 1027,
  chapters: [
    { n: 1, title: "Introduction", page: 34, minutes: 107, sections: [] },
    { n: 2, title: "Understanding Foundation Models", page: 130, minutes: 140, sections: ["Training Data", "Modeling"] },
    { n: 3, title: "Evaluation Methodology", page: 256, minutes: 94, sections: [] },
  ],
};

const MATERIALS: Material[] = [
  material("M1", "AI Engineering", { kind: "book", backbone: true, year: 2024, recommendedBy: ["https://a.example/", "https://b.example/"], minutes: 1320, minutesBasis: "measured", toc: TOC }),
  material("M2", "My notes", { origin: "learner", type: "note", kind: "note", url: "My notes", verifiedAt: null, fetchedTitle: null, sig: null }),
  material("M3", "Evals guide", { minutes: 300, uses: "units 1–4" }),
  material("M4", "Problem list", { practice: { format: "problem-set", items: 20, perItemMinutes: 10, minutes: 200, answers: true } }),
];

function plan(): PlanNode {
  return makeRoot([
    makeNode({
      level: "week",
      title: "Foundations",
      summary: "s",
      len: 2,
      covers: [{ id: "M1", note: "ch. 1–2" }],
      children: [
        makeNode({ level: "day", title: "Intro", summary: "a", len: 1, materials: [{ id: "M1", tier: "must", minutes: 40, note: "ch. 1" }, { id: "M2", tier: "should", minutes: 10, note: null }] }),
        makeNode({ level: "day", title: "Evals", summary: "b", len: 1, materials: [{ id: "M3", tier: "must", minutes: 30, note: null }, { id: "M9", tier: "must", minutes: 5, note: null }] }),
      ],
    }),
    makeNode({ level: "week", title: "Later", summary: "s", len: 7, covers: [{ id: "M1", note: "ch. 3–4" }] }),
  ]);
}

let trackId: string;

describe("persistence of materials", () => {
  beforeAll(async () => {
    const created = await createTrackWithPlan({
      userId: "u1",
      title: "LLM engineering",
      granularity: "day",
      hoursPerWeek: 10,
      split: { readingShare: 50, practice: "building projects", reason: "A skill learned by shipping." },
      materials: MATERIALS,
      root: plan(),
    });
    trackId = created.trackId;
    expect(created.droppedRefs).toBe(1); // the M9 reference
  });

  it("writes materials in order with uuids and reads them back", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    expect(detail.materials.map((m) => [m.title, m.origin, m.kind, m.backbone])).toEqual([
      ["AI Engineering", "research", "book", true],
      ["My notes", "learner", "note", false],
      ["Evals guide", "research", "docs", false],
      ["Problem list", "research", "docs", false],
    ]);
    expect(detail.materials.every((m) => /^[0-9a-f-]{36}$/.test(m.id))).toBe(true);
    expect(detail.materials[0].recommendedBy).toEqual(["https://a.example/", "https://b.example/"]);
    expect(detail.materials[0].verifiedAt).toBe("2026-09-28T10:00:00.000Z");
  });

  it("keeps a book's chapter list through save and load, and null for the rest", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    expect(detail.materials.map((m) => m.toc ?? null)).toEqual([TOC, null, null, null]);
  });

  it("keeps a material's practice role through save and load, and null for the rest", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    expect(detail.materials.map((m) => m.practice ?? null)).toEqual([null, null, null, { format: "problem-set", items: 20, perItemMinutes: 10, minutes: 200, answers: true }]);
  });

  it("keeps the learner's hours, the plan's split and each material's size", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    expect(detail.track.hoursPerWeek).toBe(10);
    expect(detail.track.split).toEqual({ readingShare: 50, practice: "building projects", reason: "A skill learned by shipping." });
    expect(detail.materials.map((m) => [m.minutes, m.minutesBasis, m.uses])).toEqual([
      [1320, "measured", null],
      [null, null, null],
      [300, "estimated", "units 1–4"],
      [null, null, null],
    ]);
    await updateTrackStudyTime(trackId, "u1", { hoursPerWeek: 200, split: null });
    const after = (await getTrackDetail(trackId, "u1"))!;
    expect(after.track.hoursPerWeek).toBe(80);
    expect(after.track.split).toBeNull();
  });

  it("writes node_materials from short ids: covers on headings, the Read table on leaves", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    const [book, notes, evals] = detail.materials;
    const [week1, week2] = detail.root.children!;
    // Loaded references always carry chapter (null = whole) and activity.
    expect(week1.covers).toEqual([{ id: book.id, note: "ch. 1–2", chapter: null, activity: "read" }]);
    expect(week2.covers).toEqual([{ id: book.id, note: "ch. 3–4", chapter: null, activity: "read" }]);
    expect(week1.children![0].materials).toEqual([
      { id: book.id, tier: "must", minutes: 40, note: "ch. 1", chapter: null, activity: "read" },
      { id: notes.id, tier: "should", minutes: 10, note: null, chapter: null, activity: "read" },
    ]);
    expect(week1.children![1].materials).toEqual([{ id: evals.id, tier: "must", minutes: 30, note: null, chapter: null, activity: "read" }]);
  });

  it("clips legacy notes to the wire limits when reading them back", async () => {
    const [row] = await db.insert(sources).values({ trackId, type: "note", url: "n".repeat(3000), position: 9 }).returning();
    const detail = (await getTrackDetail(trackId, "u1"))!;
    const legacy = detail.materials.find((m) => m.id === row.id)!;
    expect(legacy.title.length).toBeLessThanOrEqual(300);
    expect(legacy.url.length).toBe(2000);
    await db.delete(sources).where(eq(sources.id, row.id));
  });

  it("allows only one backbone per track", async () => {
    await expect(db.update(sources).set({ backbone: true }).where(eq(sources.trackId, trackId))).rejects.toThrow();
  });

  it("carries a week's reservation into the days it is planned into", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    const [book] = detail.materials;
    const week2 = detail.root.children![1];
    const days = Array.from({ length: 7 }, (_, i) =>
      makeNode({ level: "day", title: `Day ${i}`, summary: "d", len: 1, materials: i === 0 ? [{ id: book.id, tier: "must", minutes: 45, note: "ch. 3" }] : undefined }),
    );
    await insertChildren(trackId, "u1", week2.id, days);
    const after = (await getTrackDetail(trackId, "u1"))!;
    expect(after.root.children![1].children![0].materials).toEqual([{ id: book.id, tier: "must", minutes: 45, note: "ch. 3", chapter: null, activity: "read" }]);
  });

  it("keeps chapter and activity through save and load, two chapters of one book on one node", async () => {
    const root = makeRoot([
      makeNode({
        level: "week",
        title: "W",
        summary: "s",
        len: 7,
        budgetHours: 6,
        materials: [
          { id: "M1", tier: "must", minutes: 107, note: null, chapter: 1 },
          { id: "M1", tier: "must", minutes: 140, note: "Post-Training; Sampling", chapter: 2 },
          { id: "M3", tier: "should", minutes: 20, note: null, activity: "review" },
        ],
      }),
      makeNode({ level: "month", title: "M", summary: "s", len: 28, covers: [{ id: "M1", note: null, chapter: 3 }, { id: "M1", note: null, chapter: 4, activity: "review" }] }),
    ]);
    const created = await createTrackWithPlan({ userId: "u-ch", title: "T", granularity: "week", root, materials: MATERIALS, hoursPerWeek: 6, split: null });
    const detail = (await getTrackDetail(created.trackId, "u-ch"))!;
    const [week, month] = detail.root.children!;
    expect(week.materials!.map((r) => [r.chapter, r.activity, r.minutes])).toEqual([[1, "read", 107], [2, "read", 140], [null, "review", 20]]);
    expect(month.covers!.map((r) => [r.chapter, r.activity])).toEqual([[3, "read"], [4, "review"]]);
  });

  it("loads rows written before chapters as whole reads", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    const day = detail.root.children![0].children![1];
    const notes = detail.materials.find((m) => m.title === "My notes")!;
    // No chapter, no activity: the column defaults, as the migration gives rows saved before this change.
    await db.insert(nodeMaterials).values({ nodeId: day.id, sourceId: notes.id, role: "assigned", tier: "should", minutes: 5, note: "ch. 2", position: 9 });
    const again = (await getTrackDetail(trackId, "u1"))!;
    expect(again.root.children![0].children![1].materials!.at(-1)).toEqual({ id: notes.id, tier: "should", minutes: 5, note: "ch. 2", chapter: null, activity: "read" });
    await db.delete(nodeMaterials).where(and(eq(nodeMaterials.nodeId, day.id), eq(nodeMaterials.sourceId, notes.id)));
  });

  it("a hand-split week's Read table becomes its reservation, chapter, activity, tier and minutes kept", async () => {
    const root = makeRoot([
      makeNode({ level: "week", title: "W", summary: "s", len: 7, budgetHours: 6, materials: [{ id: "M1", tier: "must", minutes: 140, note: null, chapter: 2 }, { id: "M3", tier: "should", minutes: 20, note: null, activity: "review" }] }),
    ]);
    const created = await createTrackWithPlan({ userId: "u-split", title: "T", granularity: "week", root, materials: MATERIALS, hoursPerWeek: 6, split: null });
    const detail = (await getTrackDetail(created.trackId, "u-split"))!;
    const week = detail.root.children![0];
    // Split into three days: the week takes that length.
    const days = Array.from({ length: 3 }, (_, i) => makeNode({ level: "day", title: `Day ${i}`, summary: "d", len: 1, materials: i === 0 ? [{ id: week.materials![0].id, tier: "must", minutes: 20, note: "Sampling", chapter: 2 }] : undefined }));
    await insertChildren(created.trackId, "u-split", week.id, days, true);
    const after = (await getTrackDetail(created.trackId, "u-split"))!.root.children![0];
    expect(after.covers!.map((r) => [r.chapter, r.activity, r.tier, r.minutes])).toEqual([
      [2, "read", "must", 140],
      [null, "review", "should", 20],
    ]);
    expect(after.len).toBe(3);
    expect(after.children![0].materials![0]).toMatchObject({ chapter: 2, activity: "read", note: "Sampling" });
    // Saved again (adjust mode), the reservation keeps its tiers and minutes.
    const saved = (await getTrackDetail(created.trackId, "u-split"))!;
    await replacePlanTree(created.trackId, "u-split", saved.root, saved.materials.map((m) => m.id));
    const resaved = (await getTrackDetail(created.trackId, "u-split"))!.root.children![0];
    expect(resaved.covers!.map((r) => [r.tier, r.minutes])).toEqual([
      ["must", 140],
      ["should", 20],
    ]);
  });

  it("removing a material in adjust mode removes its rows (cascade)", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    const [book, notes, evals] = detail.materials;
    await replacePlanTree(trackId, "u1", detail.root, [book.id, notes.id]);
    const after = (await getTrackDetail(trackId, "u1"))!;
    expect(after.materials.map((m) => m.id)).toEqual([book.id, notes.id]);
    const rows = await db.select().from(nodeMaterials).where(eq(nodeMaterials.sourceId, evals.id));
    expect(rows).toEqual([]);
    expect(after.root.children![0].children![1].materials).toBeUndefined();
    // Other references are untouched.
    expect(after.root.children![0].children![0].materials?.map((r) => r.id)).toEqual([book.id, notes.id]);
  });

  it("drops references to materials outside the track on an adjust save", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    const tampered = structuredClone(detail.root);
    tampered.children![0].children![0].materials = [{ id: crypto.randomUUID(), tier: "must", minutes: 5, note: null }];
    await replacePlanTree(trackId, "u1", tampered);
    const after = (await getTrackDetail(trackId, "u1"))!;
    expect(after.root.children![0].children![0].materials).toBeUndefined();
  });
  describe("practice rows", () => {
    const sourced = { format: "problem-set", id: "M4", task: "Problems 1-10", done: "All ten solved", minutes: 60, generated: false } as const;
    const generated = { format: "recall", id: null, task: "Answer from memory: what does a harness do?", done: "Checked against the notes", minutes: 15, generated: true } as const;
    const practiceRoot = () =>
      makeRoot([
        makeNode({ level: "week", title: "W1", summary: "s", len: 7, budgetHours: 6, materials: [{ id: "M1", tier: "must", minutes: 90, note: null }], practice: [sourced, generated] }),
        makeNode({ level: "month", title: "M2", summary: "s", len: 28, practiceCovers: [{ format: "problem-set", id: "M4", note: "set 2" }] }),
      ]);

    it("saves and loads a week's practice rows and a heading's reservation, a generated row keeping a null source", async () => {
      const created = await createTrackWithPlan({ userId: "u-pr", title: "T", granularity: "week", root: practiceRoot(), materials: MATERIALS, hoursPerWeek: 6, split: null });
      const detail = (await getTrackDetail(created.trackId, "u-pr"))!;
      const m4 = detail.materials.find((m) => m.title === "Problem list")!;
      const [week, month] = detail.root.children!;
      expect(week.practice).toEqual([{ ...sourced, id: m4.id }, generated]);
      expect(week.practiceCovers).toBeUndefined();
      expect(month.practiceCovers).toEqual([{ format: "problem-set", id: m4.id, note: "set 2" }]);
      expect(month.practice).toBeUndefined();
    });

    it("turns a hand-split week's practice rows into reservations, task and minutes kept, and keeps them on re-save", async () => {
      const created = await createTrackWithPlan({ userId: "u-pr2", title: "T", granularity: "week", root: practiceRoot(), materials: MATERIALS, hoursPerWeek: 6, split: null });
      const detail = (await getTrackDetail(created.trackId, "u-pr2"))!;
      const m4 = detail.materials.find((m) => m.title === "Problem list")!;
      const week = detail.root.children![0];
      const days = Array.from({ length: 3 }, (_, i) => makeNode({ level: "day", title: `Day ${i}`, summary: "d", len: 1, practice: i === 0 ? [{ ...sourced, id: m4.id, minutes: 30 }] : undefined }));
      await insertChildren(created.trackId, "u-pr2", week.id, days, true);
      const after = (await getTrackDetail(created.trackId, "u-pr2"))!.root.children![0];
      expect(after.practice).toBeUndefined();
      expect(after.practiceCovers).toEqual([
        { format: "problem-set", id: m4.id, note: null, task: "Problems 1-10", minutes: 60 },
        { format: "recall", id: null, note: null, task: generated.task, minutes: 15 },
      ]);
      expect(after.children![0].practice).toEqual([{ ...sourced, id: m4.id, minutes: 30 }]);
      const saved = (await getTrackDetail(created.trackId, "u-pr2"))!;
      await replacePlanTree(created.trackId, "u-pr2", saved.root, saved.materials.map((m) => m.id));
      const resaved = (await getTrackDetail(created.trackId, "u-pr2"))!.root.children![0];
      expect(resaved.practiceCovers).toEqual(after.practiceCovers);
      expect(resaved.children![0].practice).toEqual(after.children![0].practice);
    });

    it("keeps practice rows through an adjust save, and drops a row whose source is outside the track", async () => {
      const created = await createTrackWithPlan({ userId: "u-pr3", title: "T", granularity: "week", root: practiceRoot(), materials: MATERIALS, hoursPerWeek: 6, split: null });
      const detail = (await getTrackDetail(created.trackId, "u-pr3"))!;
      const tampered = structuredClone(detail.root);
      tampered.children![0].practice = [...tampered.children![0].practice!, { ...sourced, id: crypto.randomUUID() }];
      await replacePlanTree(created.trackId, "u-pr3", tampered);
      const after = (await getTrackDetail(created.trackId, "u-pr3"))!;
      expect(after.root.children![0].practice).toEqual(detail.root.children![0].practice);
    });

    it("removes a source's practice rows with it but keeps the generated ones", async () => {
      const created = await createTrackWithPlan({ userId: "u-pr4", title: "T", granularity: "week", root: practiceRoot(), materials: MATERIALS, hoursPerWeek: 6, split: null });
      const detail = (await getTrackDetail(created.trackId, "u-pr4"))!;
      const m4 = detail.materials.find((m) => m.title === "Problem list")!;
      await replacePlanTree(created.trackId, "u-pr4", detail.root, detail.materials.filter((m) => m.id !== m4.id).map((m) => m.id));
      const after = (await getTrackDetail(created.trackId, "u-pr4"))!;
      expect(after.root.children![0].practice).toEqual([generated]);
      expect(after.root.children![1].practiceCovers).toBeUndefined();
      expect(await db.select().from(nodePractice).where(eq(nodePractice.sourceId, m4.id))).toEqual([]);
    });
  });
});
