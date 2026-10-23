import { describe, expect, it } from "vitest";
import { applyDraftEvent, type DraftMaterials, type PlanDraftEvent } from "@/lib/planChat";
import type { Material } from "@/lib/schemas/material";

const material = (title: string): Material => ({ title, url: `https://example.com/${title}` }) as unknown as Material;

describe("applyDraftEvent", () => {
  const researched: DraftMaterials = {
    materials: [material("book"), material("videos")],
    dropped: [{ title: "old", reason: "off topic" }],
  };

  it("an allocated event replaces the materials and keeps research's drops, adding its own", () => {
    const cut = [material("book (cut)")];
    const event: PlanDraftEvent = {
      type: "allocated",
      materials: cut,
      dropped: [{ title: "videos", reason: "not used by the plan: too long" }],
    };
    const next = applyDraftEvent(researched, event);
    expect(next.materials).toBe(cut);
    expect(next.dropped).toEqual([
      { title: "old", reason: "off topic" },
      { title: "videos", reason: "not used by the plan: too long" },
    ]);
    expect(researched.dropped).toHaveLength(1);
  });

  it("research.done sets the materials and the dropped list", () => {
    const event = {
      type: "research.done",
      materials: [material("a")],
      dropped: [{ title: "x", reason: "dead link" }],
    } as unknown as PlanDraftEvent;
    const next = applyDraftEvent({ materials: [], dropped: [{ title: "stale", reason: "r" }] }, event);
    expect(next.materials).toHaveLength(1);
    expect(next.dropped).toEqual([{ title: "x", reason: "dead link" }]);
  });

  it("leaves the state alone for any other event", () => {
    expect(applyDraftEvent(researched, { type: "finish", root: {} as never, costUsd: 0 })).toBe(researched);
  });
});
