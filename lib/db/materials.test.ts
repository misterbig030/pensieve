import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { db } from "./client";
import { createTrackWithPlan, getTrackDetail } from "./queries";
import { insertChildren, replacePlanTree } from "./planQueries";
import { nodeMaterials, sources } from "./schema";

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

const MATERIALS: Material[] = [
  material("M1", "AI Engineering", { kind: "book", backbone: true, year: 2024, recommendedBy: ["https://a.example/", "https://b.example/"] }),
  material("M2", "My notes", { origin: "learner", type: "note", kind: "note", url: "My notes", verifiedAt: null, fetchedTitle: null, sig: null }),
  material("M3", "Evals guide"),
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
    const created = await createTrackWithPlan({ userId: "u1", title: "LLM engineering", granularity: "day", materials: MATERIALS, root: plan() });
    trackId = created.trackId;
    expect(created.droppedRefs).toBe(1); // the M9 reference
  });

  it("writes materials in order with uuids and reads them back", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    expect(detail.materials.map((m) => [m.title, m.origin, m.kind, m.backbone])).toEqual([
      ["AI Engineering", "research", "book", true],
      ["My notes", "learner", "note", false],
      ["Evals guide", "research", "docs", false],
    ]);
    expect(detail.materials.every((m) => /^[0-9a-f-]{36}$/.test(m.id))).toBe(true);
    expect(detail.materials[0].recommendedBy).toEqual(["https://a.example/", "https://b.example/"]);
    expect(detail.materials[0].verifiedAt).toBe("2026-09-28T10:00:00.000Z");
  });

  it("writes node_materials from short ids: covers on headings, the Read table on leaves", async () => {
    const detail = (await getTrackDetail(trackId, "u1"))!;
    const [book, notes, evals] = detail.materials;
    const [week1, week2] = detail.root.children!;
    expect(week1.covers).toEqual([{ id: book.id, note: "ch. 1–2" }]);
    expect(week2.covers).toEqual([{ id: book.id, note: "ch. 3–4" }]);
    expect(week1.children![0].materials).toEqual([
      { id: book.id, tier: "must", minutes: 40, note: "ch. 1" },
      { id: notes.id, tier: "should", minutes: 10, note: null },
    ]);
    expect(week1.children![1].materials).toEqual([{ id: evals.id, tier: "must", minutes: 30, note: null }]);
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
    expect(after.root.children![1].children![0].materials).toEqual([{ id: book.id, tier: "must", minutes: 45, note: "ch. 3" }]);
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
});
