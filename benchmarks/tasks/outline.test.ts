import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelCall } from "@/lib/ai/logged";
import type { draftLevel } from "@/lib/ai/planDraft";
import type { Breach } from "@/lib/materials";
import { layout, makeRoot, type PlanNode } from "@/lib/planTree";
import type { ChapterList, Material } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";
import { BASELINE } from "../contestants";
import { listPriceUsd } from "../price";
import type { Contestant } from "../types";
import type { OutlineFixture } from "./outlineFixtures";
import { codeResults, judgeCriteriaFor, OUTLINE_CRITERIA, renderOutline, runOutlineSample, type OutlineOutput } from "./outline";

function chapters(minutes: number[]): ChapterList {
  return {
    source: "catalogue",
    url: "https://example.com/toc",
    printPages: false,
    end: null,
    chapters: minutes.map((m, i) => ({ n: i + 1, title: `Chapter ${i + 1}`, page: null, sections: [], minutes: m })),
  };
}

function material(id: string, title: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "book", url: `https://x/${id}`, title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, minutes: 600, ...extra } as Material;
}

function node(extra: Partial<PlanNode>): PlanNode {
  return { id: "n", level: "day", title: "t", summary: "s", len: 1, status: "pending", budgetHours: null, manualSplit: false, children: null, start: 1, end: 1, ...extra };
}

const BOOK = material("csapp", "Computer Systems: A Programmer's Perspective", { toc: chapters([120, 120, 120]), backbone: true });
const ESSAY = material("essay", "What every programmer should know about memory", { kind: "essay", toc: null, minutes: 90 });

const WEEK: PlanNode = node({
  id: "w1",
  level: "week",
  title: "Bits and bytes",
  summary: "How data is stored",
  len: 2,
  covers: [{ id: "csapp", chapter: 1, note: null }],
  time: { reading: 240, practice: {} },
});

const TREE = layout(makeRoot([WEEK, node({ id: "w2", level: "week", title: "Machine code", summary: "Assembly", len: 2 })]));

const REQUEST: OutlineFixture["request"] = { topic: "Computer systems", granularity: "day", weeks: 2, daysPerWeek: 2, hoursPerWeek: 4 };

const LEAF: OutlineFixture = {
  id: "csapp-1/week-1",
  topic: "csapp",
  sourceRun: "run",
  commit: "abc1234",
  label: "Week 1 · 2 days",
  group: "leaves",
  leaf: true,
  request: REQUEST,
  materials: [BOOK],
  split: { readingShare: 100, practice: "reading", reason: "", formats: [] },
  level: "day",
  spans: [1, 1],
  tree: TREE,
  parentId: "w1",
  timeLimitMs: 197_295,
  baseline: { inputTokens: 20_000, outputTokens: 4_000, ms: 30_000 },
};

const HEADING: OutlineFixture = { ...LEAF, id: "csapp-1/top", label: "Top level · 2 weeks", group: "top", leaf: false, level: "week", spans: [2, 2], tree: undefined, parentId: undefined };

const DAY_UNITS: UnitDraft[] = [
  { title: "Bits", summary: "How numbers are stored", materials: [{ id: "M1.1", tier: "must", minutes: 60, note: "Sections 1.1–1.4" }] },
  { title: "Bytes", summary: "How bytes are ordered", materials: [{ id: "M1.1", tier: "must", minutes: 60, note: "Sections 1.5–1.9" }] },
];

const DAYS: PlanNode[] = [
  node({ id: "d1", title: "Bits", summary: "How numbers are stored", materials: [{ id: "csapp", chapter: 1, tier: "must", minutes: 60, note: "Sections 1.1–1.4" }] }),
  node({ id: "d2", title: "Bytes", summary: "How bytes are ordered", materials: [{ id: "csapp", chapter: 1, tier: "must", minutes: 60, note: "Sections 1.5–1.9" }] }),
];

function breach(kind: Breach["kind"], text = `${kind} on Day 1`): Breach {
  return { kind, index: 0, unit: "Day 1", refs: [], names: "", text };
}

function leafOutput(extra: Partial<OutlineOutput> = {}): OutlineOutput {
  return { nodes: DAYS, units: DAY_UNITS, breaches: [], problems: [], ...extra };
}

const result = (out: OutlineOutput, id: string, fixture = LEAF) => codeResults(out, { fixture }).find((r) => r.id === id);

describe("outline criteria", () => {
  it("prefixes every id by its kind, and gives judge criteria the kind's dimension", () => {
    for (const c of OUTLINE_CRITERIA) {
      expect(c.id).toMatch(/^(leaf|head)-/);
      if (c.grader === "judge") expect(c.dimension).toBe(c.id.startsWith("leaf-") ? "leaf" : "heading");
    }
  });
});

describe("codeResults", () => {
  it("marks leaf-time unmet on an over-budget breach", () => {
    expect(result(leafOutput({ breaches: [breach("over-budget", "Day 1 runs 150 min against 120")] }), "leaf-time")).toMatchObject({
      met: false,
      grader: "code",
      evidence: expect.stringContaining("150 min"),
    });
  });

  it("marks leaf-time met with no breach, and gives head-* criteria no result on a leaf call", () => {
    const results = codeResults(leafOutput(), { fixture: LEAF });
    expect(results.find((r) => r.id === "leaf-time")?.met).toBe(true);
    expect(results.some((r) => r.id.startsWith("head-"))).toBe(false);
  });

  it("holds the top level to budget-miss under leaf-time, and other levels not", () => {
    const missed = leafOutput({ breaches: [breach("budget-miss")] });
    expect(result(missed, "leaf-time")?.met).toBe(true);
    expect(result(missed, "leaf-time", { ...LEAF, group: "top", tree: undefined, parentId: undefined })?.met).toBe(false);
  });

  it("checks minutes in code only where the material gives a size", () => {
    expect(result(leafOutput(), "leaf-minutes-code")?.met).toBe(true);
    const unsized: UnitDraft[] = [{ title: "Bits", summary: "s", materials: [{ id: "M1", tier: "must", minutes: 60 }] }];
    expect(result(leafOutput({ units: unsized }), "leaf-minutes-code")).toBeUndefined();
  });

  it("finds ids in the units' prose", () => {
    const leaked: UnitDraft[] = [{ ...DAY_UNITS[0], summary: "Read M1.1 closely" }];
    expect(result(leafOutput({ units: leaked }), "leaf-words-code")).toMatchObject({ met: false, evidence: expect.stringContaining("M1.1") });
    expect(result(leafOutput(), "leaf-words-code")?.met).toBe(true);
  });

  it("marks leaf-order-code unmet on a chapter read out of order", () => {
    const back = [node({ id: "d1", materials: [{ id: "csapp", chapter: 2, tier: "must", minutes: 60, note: null }] }), node({ id: "d2", materials: [{ id: "csapp", chapter: 1, tier: "must", minutes: 60, note: null }] })];
    expect(result(leafOutput({ nodes: back }), "leaf-order-code")?.met).toBe(false);
    expect(result(leafOutput(), "leaf-order-code")?.met).toBe(true);
  });

  it("gives a heading call only head-* results", () => {
    const weeks = [node({ id: "a", level: "week", covers: [{ id: "csapp", chapter: 1, note: null }], time: { reading: 120, practice: {} } })];
    const results = codeResults({ nodes: weeks, units: [{ title: "a", summary: "s" }], breaches: [breach("no-time")], problems: [] }, { fixture: HEADING });
    expect(results.every((r) => r.id.startsWith("head-"))).toBe(true);
    expect(results.find((r) => r.id === "head-time")?.met).toBe(false);
    expect(results.find((r) => r.id === "head-set-aside-code")?.met).toBe(true);
  });
});

describe("judgeCriteriaFor", () => {
  it("leaves out leaf-order-judge when every material the level reads has a toc", () => {
    const ids = judgeCriteriaFor(leafOutput(), { fixture: LEAF }).map((c) => c.id);
    expect(ids).not.toContain("leaf-order-judge");
    expect(ids).toContain("leaf-note");
    expect(ids.every((id) => id.startsWith("leaf-"))).toBe(true);
  });

  it("includes leaf-order-judge when a material the level reads has none", () => {
    const fixture = { ...LEAF, materials: [BOOK, ESSAY] };
    const nodes = [...DAYS, node({ id: "d3", materials: [{ id: "essay", chapter: null, tier: "must", minutes: 45, note: "The first half" }] })];
    const ids = judgeCriteriaFor(leafOutput({ nodes }), { fixture }).map((c) => c.id);
    expect(ids).toContain("leaf-order-judge");
  });

  it("asks the judge about minutes only for rows with no size", () => {
    expect(judgeCriteriaFor(leafOutput(), { fixture: LEAF }).map((c) => c.id)).not.toContain("leaf-minutes-judge");
    const unsized: UnitDraft[] = [{ title: "Bits", summary: "s", materials: [{ id: "M1", tier: "must", minutes: 60 }] }];
    expect(judgeCriteriaFor(leafOutput({ units: unsized }), { fixture: LEAF }).map((c) => c.id)).toContain("leaf-minutes-judge");
  });

  it("gives a heading call the heading criteria", () => {
    const ids = judgeCriteriaFor({ nodes: [], units: [], breaches: [], problems: [] }, { fixture: HEADING }).map((c) => c.id);
    expect(ids).toEqual(["head-title", "head-builds", "head-words-judge"]);
  });
});

describe("renderOutline", () => {
  const text = renderOutline(leafOutput(), LEAF);

  it("marks the parent and shows each unit's title", () => {
    expect(text).toContain(">> Week 1");
    expect(text).toContain("Bits");
    expect(text).toContain("Bytes");
    expect(text).toContain("Sections 1.5–1.9");
  });

  it("names no model and shows no JSON", () => {
    expect(text).not.toContain("gpt-test");
    expect(text).not.toContain('{"');
  });

  it("shows what the parent set aside and the level's budgets", () => {
    expect(text).toContain("What the parent set aside");
    expect(text).toContain("Chapter 1");
    expect(text).toContain("4 h reading");
    expect(text).toMatch(/Each day: about 2 h/);
  });

  it("places a top-level call's units at the top", () => {
    const weeks = [node({ id: "a", level: "week", title: "Foundations", summary: "s", len: 2 }), node({ id: "b", level: "week", title: "Machines", summary: "s", len: 2 })];
    const top = renderOutline({ nodes: weeks, units: [], breaches: [], problems: [] }, HEADING);
    expect(top).toContain("Foundations");
    expect(top).not.toContain(">>");
  });
});

const CALL = { label: "Week 1 · 2 days", model: "anthropic/claude-opus-5.5", costUsd: 0.4, inputTokens: 1000, outputTokens: 100, latencyMs: 5 } as ModelCall;

type Done = { breaches?: Breach[]; calls?: ModelCall[] };

/** A draft that reports `calls` and finishes with the leaf output, or throws `error`. */
function fakeDraft(opts: Done & { error?: unknown } = {}) {
  return vi.fn<typeof draftLevel>(async function* (input) {
    if (opts.error !== undefined) throw opts.error;
    for (const call of opts.calls ?? [CALL]) input.log?.onCall?.(call);
    yield { type: "done", nodes: DAYS, problems: [], costUsd: 0.4, units: DAY_UNITS, breaches: opts.breaches ?? [] };
  });
}

function apiError(statusCode: number) {
  return new APICallError({ message: `status ${statusCode}`, url: "https://ai-gateway.vercel.sh", requestBodyValues: {}, statusCode });
}

describe("runOutlineSample", () => {
  it("completes with the level, its calls and their cost", async () => {
    const unpriced = { ...CALL, costUsd: null } as ModelCall;
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ calls: [CALL, unpriced] }) });
    expect(sample.gate).toEqual({ status: "completed" });
    expect(sample.output?.units).toEqual(DAY_UNITS);
    expect(sample.calls).toHaveLength(2);
    expect(sample.costUsd).toBeCloseTo(0.4 + listPriceUsd("anthropic/claude-opus-5.5", unpriced));
    expect(sample.ms).toBeGreaterThanOrEqual(0);
  });

  it("fails an aborted call as timed out after the fixture's limit", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error: abort }) });
    expect(sample.gate).toEqual({ status: "failed", reason: "timed out after 197.295 s" });
    expect(sample.output).toBeNull();
  });

  it("voids a gateway outage (503) without halting", async () => {
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error: apiError(503) }) });
    expect(sample.gate.status).toBe("void");
    expect(sample.gate).not.toHaveProperty("halt");
  });

  it("voids and halts on the gateway refusing the key or its budget (402)", async () => {
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error: apiError(402) }) });
    expect(sample.gate).toMatchObject({ status: "void", halt: true });
  });

  it("fails any other error with its message", async () => {
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ error: new Error("No object generated: response did not match schema.") }) });
    expect(sample.gate).toEqual({ status: "failed", reason: "No object generated: response did not match schema." });
  });

  it("fails a level past the time ceiling, and keeps its output", async () => {
    const sample = await runOutlineSample(LEAF, BASELINE, { draft: fakeDraft({ breaches: [breach("over-budget", "Day 1 runs 300 min against 120")] }) });
    expect(sample.gate.status).toBe("failed");
    expect(sample.gate).toMatchObject({ reason: expect.stringMatching(/^over the time ceiling/) });
    expect(sample.output).not.toBeNull();
  });

  it("passes the contestant's outline model and effort, and a deadline from the fixture's limit", async () => {
    const draft = fakeDraft();
    const contestant: Contestant = { name: "gpt-test", roles: { outline: { model: "google/gemini-3-flash", effort: "low" } } };
    const before = Date.now();
    await runOutlineSample(LEAF, contestant, { draft });
    const input = draft.mock.calls[0][0];
    expect(input.ctx.effort).toBe("low");
    expect(input.ctx.outlineModel.id).toBe("google/gemini-3-flash");
    expect(input.ctx.deadline).toBeGreaterThanOrEqual(before + LEAF.timeLimitMs);
    expect(input.parentId).toBe("w1");
  });

  it("runs the baseline's outline model for a contestant that leaves the role out", async () => {
    const draft = fakeDraft();
    await runOutlineSample(LEAF, { name: "bare", roles: {} }, { draft });
    expect(draft.mock.calls[0][0].ctx).toMatchObject({ effort: BASELINE.roles.outline!.effort, outlineModel: { id: BASELINE.roles.outline!.model } });
  });
});
