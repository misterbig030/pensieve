import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const { createTestDb } = await import("./testDb");
  const { db } = await createTestDb();
  return { db };
});

import { eq } from "drizzle-orm";
import { db } from "./client";
import { tracks, users } from "./schema";
import { setTrackArchived } from "./queries";

beforeAll(async () => {
  await db.insert(users).values([{ id: "u1" }, { id: "u2" }]);
});

async function statusOf(id: string) {
  const [row] = await db.select({ status: tracks.status }).from(tracks).where(eq(tracks.id, id));
  return row.status;
}

describe("setTrackArchived", () => {
  it("archives the owner's track and restores it", async () => {
    const [track] = await db.insert(tracks).values({ userId: "u1", title: "Rust" }).returning();

    expect(await setTrackArchived(track.id, "u1", true)).toBe(true);
    expect(await statusOf(track.id)).toBe("archived");

    expect(await setTrackArchived(track.id, "u1", false)).toBe(true);
    expect(await statusOf(track.id)).toBe("active");
  });

  it("changes nothing on someone else's track", async () => {
    const [track] = await db.insert(tracks).values({ userId: "u1", title: "Music" }).returning();

    expect(await setTrackArchived(track.id, "u2", true)).toBe(false);
    expect(await statusOf(track.id)).toBe("active");
  });
});
