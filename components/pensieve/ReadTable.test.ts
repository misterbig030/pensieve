import { describe, expect, it } from "vitest";
import { AIE_MATERIALS } from "@/lib/__fixtures__/aiEngineeringPlan";
import { chapterLabel, readRowsFor } from "./ReadTable";

describe("readRowsFor", () => {
  it("fills chapter, activity and a key per row", () => {
    const byId = new Map(AIE_MATERIALS.map((m) => [m.id, m]));
    const rows = readRowsFor(
      [
        { id: "aie", tier: "must", minutes: 35, note: "Post-Training; Sampling", chapter: 2 },
        { id: "aie", tier: "should", minutes: 20, note: null, chapter: 1, activity: "review" },
        { id: "evals", tier: "should", minutes: 79, note: null },
      ],
      byId,
    );
    expect(rows.map((r) => [r.key, r.activity, r.chapter?.title ?? null])).toEqual([
      ["aie#2", "read", "Understanding Foundation Models"],
      ["aie#1", "review", "Introduction to Building AI Applications with Foundation Models"],
      ["evals#0", "read", null],
    ]);
    expect(chapterLabel(rows[0].chapter!)).toBe("Ch. 2 Understanding Foundation Models");
    expect(chapterLabel({ ...rows[0].chapter!, n: null })).toBe("Understanding Foundation Models");
  });
});
