import { describe, expect, it } from "vitest";
import { leavesOf, lockBoundary, topSpans } from "@/lib/planTree";
import { GOLDEN_V1, isMandarin, twinId } from "./plan.v1";

describe("golden set v1", () => {
  it("has unique, stable ids", () => {
    const ids = GOLDEN_V1.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("pairs every English record with a Mandarin twin and vice versa", () => {
    const ids = new Set(GOLDEN_V1.map((r) => r.id));
    for (const r of GOLDEN_V1) expect(ids.has(twinId(r.id)), `${r.id} has no twin`).toBe(true);
    expect(GOLDEN_V1.filter(isMandarin).length).toBe(GOLDEN_V1.length / 2);
  });

  it("gives every record a why line and a tag", () => {
    for (const r of GOLDEN_V1) {
      expect(r.why.length, r.id).toBeGreaterThan(20);
      expect(["capability", "regression"]).toContain(r.tag);
    }
  });

  it("covers every plan shape and every source type", () => {
    const drafts = GOLDEN_V1.filter((r) => r.kind === "draft");
    const shapes = new Set(drafts.map((r) => `${topSpans(r.input.days).length > 0 && r.input.days <= 14 ? "day" : r.input.days <= 70 ? "week" : "month"}/${r.input.granularity}`));
    expect([...shapes].sort()).toEqual(["day/day", "month/day", "month/week", "week/day", "week/week"]);
    const types = new Set(drafts.flatMap((r) => r.input.sources.map((s) => s.type)));
    expect([...types].sort()).toEqual(["file", "link", "note", "youtube"]);
  });

  it("builds revision trees that are laid out and consistent with their expectations", () => {
    for (const r of GOLDEN_V1) {
      if (r.kind !== "revise") continue;
      expect(r.input.tree.len, r.id).toBeGreaterThan(0);
      expect(leavesOf(r.input.tree).length, r.id).toBeGreaterThan(0);
      expect(lockBoundary(r.input.tree), r.id).toBe(r.input.lockBefore);
      if (r.expect.lockedIntact) expect(r.input.lockBefore, r.id).toBeGreaterThan(0);
    }
  });
});
