import { describe, expect, it, vi } from "vitest";
import { makeNode, makeRoot } from "@/lib/planTree";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { createTrackWithPlan, getTrackDetail } from "./queries";
import { getPlanTree, insertChildren, replacePlanTree } from "./planQueries";

const TIME = { reading: 120, practice: { "problem-set": 60 } };

describe("unit time and problems on nodes", () => {
  it("stores a heading's time and problems and reads them back, and undefined for the rest", async () => {
    const root = makeRoot([
      makeNode({ level: "week", title: "A", summary: "s", len: 7, time: TIME, problems: ["Week 1 · Problems 1-5"] }),
      makeNode({ level: "week", title: "B", summary: "s", len: 7 }),
    ]);
    const { trackId } = await createTrackWithPlan({ userId: "u1", title: "T", granularity: "week", root, materials: [] });
    const loaded = await getPlanTree(trackId);
    const [a, b] = loaded.children!;
    expect(a.time).toEqual(TIME);
    expect(a.problems).toEqual(["Week 1 · Problems 1-5"]);
    expect(b.time).toBeUndefined();
    expect(b.problems).toBeUndefined();
  });

  it("keeps the track's problems on the root", async () => {
    const root = makeRoot([makeNode({ level: "week", title: "A", summary: "s", len: 7 })]);
    const withProblems = await createTrackWithPlan({ userId: "u1", title: "T", granularity: "week", root, materials: [], problems: ["Month 1 · Set 2"] });
    expect((await getTrackDetail(withProblems.trackId, "u1"))!.root.problems).toEqual(["Month 1 · Set 2"]);
    const without = await createTrackWithPlan({ userId: "u1", title: "T", granularity: "week", root, materials: [] });
    expect((await getTrackDetail(without.trackId, "u1"))!.root.problems).toBeUndefined();
  });

  it("rewrites time and problems when an adjusted plan is saved", async () => {
    const root = makeRoot([makeNode({ level: "week", title: "A", summary: "s", len: 7, time: TIME, problems: ["old"] })]);
    const { trackId } = await createTrackWithPlan({ userId: "u1", title: "T", granularity: "week", root, materials: [] });
    const saved = await getPlanTree(trackId);
    saved.children![0].time = { reading: 30, practice: {} };
    delete saved.children![0].problems;
    await replacePlanTree(trackId, "u1", saved);
    const [week] = (await getPlanTree(trackId)).children!;
    expect(week.time).toEqual({ reading: 30, practice: {} });
    expect(week.problems).toBeUndefined();
  });

  it("writes the problems of a level onto the node planned inside, and null when there are none", async () => {
    const root = makeRoot([
      makeNode({ level: "week", title: "A", summary: "s", len: 2 }),
      makeNode({ level: "week", title: "B", summary: "s", len: 2, problems: ["stale"] }),
    ]);
    const { trackId } = await createTrackWithPlan({ userId: "u1", title: "T", granularity: "day", root, materials: [] });
    const [a, b] = (await getPlanTree(trackId)).children!;
    const days = () => [1, 2].map((i) => makeNode({ level: "day", title: `D${i}`, summary: "d", len: 1, time: TIME }));
    await insertChildren(trackId, "u1", a.id, days(), false, ["Week 3 · Problems 1-10"]);
    await insertChildren(trackId, "u1", b.id, days());
    const [a2, b2] = (await getPlanTree(trackId)).children!;
    expect(a2.problems).toEqual(["Week 3 · Problems 1-10"]);
    expect(b2.problems).toBeUndefined();
    expect(a2.children![0].time).toEqual(TIME);
  });
});
