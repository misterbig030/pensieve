import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { db } from "./client";
import { checkIns, planNodes, tracks, users } from "./schema";
import { getTrackCheckIns, getUserCheckIns } from "./activity";

// Tracks point at their owner's row.
beforeAll(async () => {
  await db.insert(users).values([{ id: "u1" }, { id: "u2" }, { id: "u3" }]);
});

async function seed() {
  const [rust, music] = await db
    .insert(tracks)
    .values([
      { userId: "u1", title: "Rust" },
      { userId: "u1", title: "Music" },
    ])
    .returning();
  const [other] = await db.insert(tracks).values({ userId: "u2", title: "Other" }).returning();
  const [day] = await db.insert(planNodes).values({ trackId: rust.id, position: 0, level: "day", title: "Borrowing", summary: "" }).returning();
  const [week] = await db.insert(planNodes).values({ trackId: music.id, position: 0, level: "week", title: "Intervals", summary: "", budgetHours: 4 }).returning();
  const [elsewhere] = await db.insert(planNodes).values({ trackId: other.id, position: 0, level: "day", title: "Theirs", summary: "" }).returning();
  await db.insert(checkIns).values([
    { nodeId: day.id, completedAt: new Date("2026-10-28T10:00:00Z") },
    { nodeId: week.id, hours: 1.5, completedAt: new Date("2026-10-29T10:00:00Z") },
    { nodeId: elsewhere.id, completedAt: new Date("2026-10-29T11:00:00Z") },
  ]);
  return { rust, music, day, week };
}

describe("check-in queries", () => {
  it("lists a user's check-ins across tracks, newest first, and no one else's", async () => {
    const { rust, music, day, week } = await seed();
    const rows = await getUserCheckIns("u1");
    expect(rows).toEqual([
      { nodeId: week.id, nodeTitle: "Intervals", nodeLevel: "week", trackId: music.id, trackTitle: "Music", completedAt: new Date("2026-10-29T10:00:00Z"), hours: 1.5 },
      { nodeId: day.id, nodeTitle: "Borrowing", nodeLevel: "day", trackId: rust.id, trackTitle: "Rust", completedAt: new Date("2026-10-28T10:00:00Z"), hours: null },
    ]);
    expect((await getUserCheckIns("u2")).map((r) => r.nodeTitle)).toEqual(["Theirs"]);
    expect(await getUserCheckIns("nobody")).toEqual([]);
  });

  it("lists one track's check-ins only for its owner", async () => {
    const [track] = await db.insert(tracks).values({ userId: "u3", title: "Solo" }).returning();
    const [node] = await db.insert(planNodes).values({ trackId: track.id, position: 0, level: "day", title: "One", summary: "" }).returning();
    await db.insert(checkIns).values({ nodeId: node.id, completedAt: new Date("2026-10-30T08:00:00Z") });
    expect((await getTrackCheckIns(track.id, "u3")).map((r) => r.nodeTitle)).toEqual(["One"]);
    expect(await getTrackCheckIns(track.id, "u2")).toEqual([]);
  });
});
