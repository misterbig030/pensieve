import { describe, expect, it } from "vitest";
import { findNode } from "@/lib/planTree";
import { GOLDEN_V1 } from "./plan.v1";
import { GOLDEN_V2 } from "./plan.v2";

describe("golden set v2", () => {
  it("has ids that are unique across v1 and v2", () => {
    const ids = [...GOLDEN_V1, ...GOLDEN_V2].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tags every record as a regression with a why line", () => {
    for (const r of GOLDEN_V2) {
      expect(r.tag, r.id).toBe("regression");
      expect(r.why.length, r.id).toBeGreaterThan(20);
    }
  });

  it("only expects orders made of ids that exist in the input tree", () => {
    for (const r of GOLDEN_V2) {
      if (r.kind !== "revise") continue;
      const { topOrder, childOrder } = r.expect;
      const tops = (r.input.tree.children ?? []).map((n) => n.id);
      if (topOrder) expect([...topOrder].sort(), r.id).toEqual([...tops].sort());
      if (childOrder) {
        const parent = findNode(r.input.tree, childOrder.parentId);
        expect(parent, r.id).toBeTruthy();
        expect([...childOrder.ids].sort(), r.id).toEqual((parent!.children ?? []).map((n) => n.id).sort());
      }
    }
  });
});
