import { describe, expect, it } from "vitest";
import { applyDraftEvent, chatLockHint, collectProblems, problemsText, type DraftMaterials, type PlanDraftEvent } from "@/lib/planChat";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";

const material = (title: string): Material => ({ title, url: `https://example.com/${title}` }) as unknown as Material;

describe("applyDraftEvent", () => {
  const researched: DraftMaterials = {
    materials: [material("book"), material("videos")],
    dropped: [{ title: "old", reason: "off topic" }],
    coverage: null,
    coverageSource: "research",
  };

  it("an allocated event replaces the materials and keeps research's drops, adding its own", () => {
    const cut = [material("book (cut)")];
    const event: PlanDraftEvent = {
      type: "allocated",
      materials: cut,
      dropped: [{ title: "videos", reason: "not used by the plan: too long", stage: "plan" }],
      coverage: null,
    };
    const next = applyDraftEvent(researched, event);
    expect(next.materials).toBe(cut);
    expect(next.dropped).toEqual([
      { title: "old", reason: "off topic" },
      { title: "videos", reason: "not used by the plan: too long", stage: "plan" },
    ]);
    expect(researched.dropped).toHaveLength(1);
  });

  it("research.done sets the materials and the dropped list", () => {
    const event = {
      type: "research.done",
      materials: [material("a")],
      dropped: [{ title: "x", reason: "dead link" }],
    } as unknown as PlanDraftEvent;
    const next = applyDraftEvent({ materials: [], dropped: [{ title: "stale", reason: "r" }], coverage: null, coverageSource: "research" }, event);
    expect(next.materials).toHaveLength(1);
    expect(next.dropped).toEqual([{ title: "x", reason: "dead link" }]);
  });

  it("takes the plan's coverage from the allocated event, and research's only as what research found", () => {
    const R = { covered: ["Arrays"], open: ["Graphs"] };
    const P = { covered: ["Arrays", "Graphs"], open: [] };
    const done = { type: "research.done", materials: [material("a")], dropped: [], coverage: R } as unknown as PlanDraftEvent;
    const afterResearch = applyDraftEvent({ materials: [], dropped: [], coverage: null, coverageSource: "research" }, done);
    expect(afterResearch).toMatchObject({ coverage: R, coverageSource: "research" });

    const planned = applyDraftEvent(afterResearch, { type: "allocated", materials: [material("a")], dropped: [], coverage: P });
    expect(planned).toMatchObject({ coverage: P, coverageSource: "plan" });

    const fallback = applyDraftEvent(afterResearch, { type: "allocated", materials: [material("a")], dropped: [], coverage: null });
    expect(fallback).toMatchObject({ coverage: R, coverageSource: "research" });

    const none = applyDraftEvent(afterResearch, { type: "research.done", materials: [], dropped: [] } as unknown as PlanDraftEvent);
    expect(none).toMatchObject({ coverage: null, coverageSource: "research" });
  });

  it("leaves the state alone for any other event", () => {
    expect(applyDraftEvent(researched, { type: "finish", root: {} as never, costUsd: 0 })).toBe(researched);
  });
});

describe("chatLockHint", () => {
  it("locks the conversation while drafting and after a refused draft, until the plan is drafted", () => {
    expect(chatLockHint({ drafting: true, draftRefused: false })).toBe("Available once the plan is drafted");
    expect(chatLockHint({ drafting: false, draftRefused: true })).toBe("Available once the plan is drafted");
    expect(chatLockHint({ drafting: false, draftRefused: false })).toBeNull();
  });
});

describe("problemsText", () => {
  it("is empty when the plan has no problems", () => {
    expect(problemsText([])).toBe("");
  });
  it("lists each problem on its own line and says what the learner can do", () => {
    expect(problemsText(["Week 3 plans too much reading.", "Problems add up to 21 h."])).toBe(
      "A few things in this plan don't add up:\n- Week 3 plans too much reading.\n- Problems add up to 21 h.\nAsk me to fix any of them, or to re-draft the plan.",
    );
  });
});

describe("collectProblems", () => {
  const node = (id: string, problems?: string[], children: PlanNode[] | null = null): PlanNode => makeNode({ id, level: "week", title: id, summary: "s", len: 1, problems, children });
  it("gathers the root's and every node's problems in tree order, once each", () => {
    const root = makeRoot([node("a", ["A1", "shared"], [node("a1", ["A1b"])]), node("b", undefined), node("c", ["shared", "C1"])]);
    root.problems = ["R1", "shared"];
    expect(collectProblems(root)).toEqual(["R1", "shared", "A1", "A1b", "C1"]);
  });
  it("is empty for a tree with no problems", () => {
    expect(collectProblems(makeRoot([node("a")]))).toEqual([]);
  });
});
