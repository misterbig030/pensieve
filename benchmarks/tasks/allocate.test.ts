import { describe, expect, it, vi } from "vitest";
import type { allocatePlan } from "@/lib/ai/allocate";
import type { ModelCall } from "@/lib/ai/logged";
import type { ServiceEvent } from "@/lib/ai/serviceEvents";
import type { Material } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
import { DRAFT_TOPICS } from "@/evals/draft/topics";
import { BASELINE } from "../contestants";
import type { AllocateFixture } from "../fixtures";
import type { Contestant } from "../types";
import { AVAILABLE_MODELS, estimateCostUsd } from "@/lib/ai/models";
import { ALLOCATE_CRITERIA, codeResults, renderAllocation, runAllocateSample, voidReason, type AllocateCtx, type AllocateOutput } from "./allocate";

function material(id: string, title: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "book", url: `https://x/${id}`, title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, minutes: 60, ...extra } as Material;
}

const ALL_READING: PlanSplit = { readingShare: 100, practice: "reading", reason: "", formats: [] };

const FIXTURE: AllocateFixture = {
  id: "sde-1",
  topic: "sde",
  sourceRun: "run",
  commit: "abc1234",
  // 8 weeks at 6 hours a week: 48 hours, 2880 minutes.
  input: { topic: "Senior software engineer interview preparation", weeks: 8, daysPerWeek: 5, hoursPerWeek: 6, materials: [material("M1", "Designing Data-Intensive Applications", { author: "Martin Kleppmann" })] },
  baseline: null,
};
const CTX: AllocateCtx = { fixture: FIXTURE, topic: DRAFT_TOPICS.sde };
const NO_LABELS: AllocateCtx = { fixture: FIXTURE, topic: undefined };

function output(materials: Material[], extra: Partial<AllocateOutput> = {}): AllocateOutput {
  return { split: ALL_READING, materials, dropped: [], coverage: null, ...extra };
}

function result(out: AllocateOutput, id: string, ctx: AllocateCtx = CTX) {
  return codeResults(out, ctx).find((r) => r.id === id);
}

const KLEPPMANN = () => material("M1", "Designing Data-Intensive Applications", { author: "Martin Kleppmann", backbone: true });

const CALL = { label: "Allocate", costUsd: 0.25, latencyMs: 5 } as ModelCall;

function allocation(extra: { fallback?: boolean; fallbackReason?: string; events?: ServiceEvent[]; noCall?: boolean } = {}): typeof allocatePlan {
  return vi.fn(async (input) => {
    if (!extra.noCall) input.log?.onCall?.(CALL);
    for (const event of extra.events ?? []) input.log?.onService?.(event);
    const fallback = extra.fallback ?? false;
    return {
      split: ALL_READING,
      materials: [KLEPPMANN()],
      dropped: [],
      coverage: null,
      costUsd: 0.25,
      fallback,
      fallbackReason: fallback ? (extra.fallbackReason ?? "no time") : null,
    };
  });
}

function failure(extra: Partial<ServiceEvent>): ServiceEvent {
  return { type: "service", name: "anthropic", ok: false, final: true, ms: 0, ...extra };
}

describe("runAllocateSample", () => {
  it("completes on the model's own allocation", async () => {
    const sample = await runAllocateSample(FIXTURE, BASELINE, { allocate: allocation() });
    expect(sample.gate).toEqual({ status: "completed" });
    expect(sample.output?.materials.map((m) => m.id)).toEqual(["M1"]);
    expect(sample.calls).toEqual([CALL]);
    expect(sample.costUsd).toBe(0.25);
    expect(sample.ms).toBeGreaterThanOrEqual(0);
  });

  it("fails the gate on a fallback with no outside cause", async () => {
    const sample = await runAllocateSample(FIXTURE, BASELINE, { allocate: allocation({ fallback: true }) });
    expect(sample.gate).toEqual({ status: "failed", reason: "fallback: no time" });
  });

  it("names the allocation's own reason when no service event explains the fallback", async () => {
    const reason = "No object generated: response did not match schema.";
    const sample = await runAllocateSample(FIXTURE, BASELINE, { allocate: allocation({ fallback: true, fallbackReason: reason }) });
    expect(sample.gate).toEqual({ status: "failed", reason: `fallback: ${reason}` });
  });

  it("fails the gate on a fallback the code made of an unusable answer", async () => {
    for (const reason of ["no researched material mentioned", "no valid split from the allocation"]) {
      const sample = await runAllocateSample(FIXTURE, BASELINE, { allocate: allocation({ fallback: true, fallbackReason: reason }) });
      expect(sample.gate).toEqual({ status: "failed", reason: `fallback: ${reason}` });
    }
  });

  it("names the last service reason on a failed gate", async () => {
    const events = [failure({ status: 400, reason: "first" }), failure({ reason: "the request timed out", where: "allocate" })];
    const sample = await runAllocateSample(FIXTURE, BASELINE, { allocate: allocation({ fallback: true, events }) });
    expect(sample.gate).toEqual({ status: "failed", reason: "fallback: the request timed out" });
  });

  it("voids a fallback the gateway caused (503)", async () => {
    const sample = await runAllocateSample(FIXTURE, BASELINE, { allocate: allocation({ fallback: true, events: [failure({ status: 503, reason: "overloaded" })] }) });
    expect(sample.gate.status).toBe("void");
    expect(sample.gate).toMatchObject({ reason: expect.stringContaining("503") });
  });

  it("does not void our own timeout", async () => {
    const sample = await runAllocateSample(FIXTURE, BASELINE, { allocate: allocation({ fallback: true, events: [failure({ reason: "The operation was aborted due to timeout" })] }) });
    expect(sample.gate.status).toBe("failed");
  });

  describe("a call that ended without usage", () => {
    const WITH_TOKENS: AllocateFixture = { ...FIXTURE, baseline: { inputTokens: 20_000, outputTokens: 4_000, ms: 1 } };
    const flash: Contestant = { name: "flash", roles: { allocate: { model: "google/gemini-3-flash", effort: "medium" } } };
    const timedOut = [failure({ reason: "The operation was aborted due to timeout" })];

    it("is charged the fixture's baseline tokens at the contestant's allocate model", async () => {
      const sample = await runAllocateSample(WITH_TOKENS, flash, { allocate: allocation({ fallback: true, noCall: true, events: timedOut }) });
      const estimate = estimateCostUsd("google/gemini-3-flash", { inputTokens: 20_000, outputTokens: 4_000 });
      expect(estimate).toBeGreaterThan(0);
      expect(sample.estimatedCostUsd).toBeCloseTo(estimate);
      expect(sample.costUsd).toBeCloseTo(estimate);
      expect(sample.gate.status).toBe("failed");
    });

    it("is not estimated when a call was reported, or when the model's own answer stands", async () => {
      // A call reported with usage is the real cost; only a fallback with no Allocate call is estimated.
      const reported = await runAllocateSample(WITH_TOKENS, flash, { allocate: allocation({ fallback: true }) });
      expect(reported.estimatedCostUsd).toBeUndefined();
      expect(reported.costUsd).toBe(0.25);
      const completed = await runAllocateSample(WITH_TOKENS, flash, { allocate: allocation({ noCall: true }) });
      expect(completed.estimatedCostUsd).toBeUndefined();
      expect(completed.costUsd).toBe(0);
    });

    it("costs nothing to estimate without baseline tokens, and records no estimate", async () => {
      const sample = await runAllocateSample(FIXTURE, flash, { allocate: allocation({ fallback: true, noCall: true, events: timedOut }) });
      expect(sample.costUsd).toBe(0);
      expect(sample.estimatedCostUsd).toBeUndefined();
    });

    it("prices a contestant that leaves out the role at the baseline's allocate model", async () => {
      const sample = await runAllocateSample(WITH_TOKENS, { name: "bare", roles: {} }, { allocate: allocation({ fallback: true, noCall: true, events: timedOut }) });
      expect(sample.estimatedCostUsd).toBeCloseTo(estimateCostUsd(BASELINE.roles.allocate!.model, { inputTokens: 20_000, outputTokens: 4_000 }));
    });
  });

  it("passes the contestant's model and effort, and the app's time limit", async () => {
    const allocate = allocation();
    const contestant: Contestant = { name: "flash", roles: { allocate: { model: "google/gemini-3-flash", effort: "medium" } } };
    await runAllocateSample(FIXTURE, contestant, { allocate });
    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({ effort: "medium", timeoutMs: 90000, model: expect.objectContaining({ id: "google/gemini-3-flash" }), weeks: 8, hoursPerWeek: 6 }));
  });

  it("runs the baseline's model for a role the contestant leaves out", async () => {
    const allocate = allocation();
    await runAllocateSample(FIXTURE, { name: "bare", roles: {} }, { allocate });
    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({ effort: BASELINE.roles.allocate!.effort, model: expect.objectContaining({ id: BASELINE.roles.allocate!.model }) }));
  });
});

describe("voidReason", () => {
  it("is null without a final failure", () => {
    expect(voidReason([])).toBeNull();
    expect(voidReason([failure({ final: false, status: 503 })])).toBeNull();
    expect(voidReason([{ ...failure({ status: 503 }), ok: true }])).toBeNull();
  });

  it("gives a reason for a 5xx, a 429, or an error with no status that is not a timeout", () => {
    expect(voidReason([failure({ status: 500, reason: "boom" })])).toContain("500");
    expect(voidReason([failure({ status: 429, reason: "rate limited" })])).toContain("429");
    expect(voidReason([failure({ reason: "fetch failed" })])).toContain("fetch failed");
  });

  it("is null for a client error or a timeout", () => {
    expect(voidReason([failure({ status: 400, reason: "bad request" })])).toBeNull();
    expect(voidReason([failure({ reason: "Request timed out" })])).toBeNull();
    expect(voidReason([failure({ reason: "This operation was aborted" })])).toBeNull();
    expect(voidReason([failure({ reason: "TimeoutError: timeout" })])).toBeNull();
  });
});

describe("allocate code criteria", () => {
  it("backbone-labelled is met for the labelled book by its author", () => {
    expect(result(output([KLEPPMANN()]), "backbone-labelled")).toMatchObject({ met: true, grader: "code", evidence: expect.stringContaining("Kleppmann") });
  });

  it("backbone-labelled is not met for an essay titled like a labelled book", () => {
    const essay = material("M2", "System design interview questions in 2026", { kind: "docs", backbone: true });
    expect(result(output([essay]), "backbone-labelled")?.met).toBe(false);
  });

  it("backbone-labelled is not met for the right title under the wrong author", () => {
    const other = material("M2", "Designing Data-Intensive Applications", { author: "Somebody Else", backbone: true });
    expect(result(output([other]), "backbone-labelled")?.met).toBe(false);
  });

  it("backbone-labelled is not met when the labelled book is kept but not the backbone", () => {
    expect(result(output([{ ...KLEPPMANN(), backbone: false }]), "backbone-labelled")?.met).toBe(false);
  });

  it("backbone-chosen is met when some kept material is the backbone", () => {
    expect(result(output([KLEPPMANN()]), "backbone-chosen")?.met).toBe(true);
    expect(result(output([{ ...KLEPPMANN(), backbone: false }]), "backbone-chosen")?.met).toBe(false);
  });

  it("expected-books is met with two of the label's books kept", () => {
    const two = [KLEPPMANN(), material("M2", "System Design Interview", { author: "Alex Xu" })];
    expect(result(output(two), "expected-books")?.met).toBe(true);
    expect(result(output([KLEPPMANN()]), "expected-books")?.met).toBe(false);
  });

  it("learner-dropped is met when a learner's material is not kept", () => {
    const input = { ...FIXTURE.input, materials: [...FIXTURE.input.materials, material("M2", "My notes", { origin: "learner", kind: "docs" })] };
    const ctx: AllocateCtx = { fixture: { ...FIXTURE, input }, topic: DRAFT_TOPICS.sde };
    expect(result(output([KLEPPMANN()]), "learner-dropped", ctx)).toMatchObject({ met: true, evidence: expect.stringContaining("My notes") });
    expect(result(output([KLEPPMANN(), material("M2", "My notes", { origin: "learner" })]), "learner-dropped", ctx)?.met).toBe(false);
  });

  it("learner-dropped does not apply without a learner's material", () => {
    expect(result(output([KLEPPMANN()]), "learner-dropped")).toBeUndefined();
  });

  const list = (name: string, items: number) => ({
    format: "problem-set" as const,
    answers: true,
    minutes: 600,
    list: { url: `https://${name}.io`, items: Array.from({ length: items }, (_, i) => ({ title: `P${i}`, url: `https://${name}.io/${i}` })) },
  });

  it("named-list-kept is met by a kept named list with items", () => {
    const kept = material("M3", "NeetCode 150", { kind: "docs", minutes: null, practice: list("neetcode", 3) as Material["practice"] });
    expect(result(output([kept]), "named-list-kept")?.met).toBe(true);
  });

  it("named-list-kept is not met by a named list without items or an unnamed one", () => {
    const empty = material("M3", "NeetCode 150", { kind: "docs", minutes: null, practice: list("neetcode", 0) as Material["practice"] });
    const unnamed = material("M4", "Some problems", { kind: "docs", minutes: null, practice: list("other", 3) as Material["practice"] });
    expect(result(output([empty, unnamed]), "named-list-kept")?.met).toBe(false);
  });

  const halfPractice = { readingShare: 50, practice: "problem-set", reason: "", formats: [{ format: "problem-set", share: 100 }] } as PlanSplit;
  const neetcode = (minutes: number) => material("M3", "NeetCode 150", { minutes: null, practice: { ...list("neetcode", 3), minutes } as Material["practice"] });

  it("format-minutes is met unless a served format gets under half its share", () => {
    // Half of 2880 minutes is practice, all of it problems: a share of 1440, so under 720 is short.
    expect(result(output([KLEPPMANN(), neetcode(100)], { split: halfPractice }), "format-minutes")?.met).toBe(false);
    expect(result(output([KLEPPMANN(), neetcode(1200)], { split: halfPractice }), "format-minutes")?.met).toBe(true);
  });

  it("format-minutes is not met by a plan that keeps no time for practice", () => {
    expect(result(output([KLEPPMANN()]), "format-minutes")).toMatchObject({ met: false, evidence: "no practice time" });
    // A pick with no time: the reading took all of it.
    const crowdedOut = { ...halfPractice, readingShare: 100 } as PlanSplit;
    expect(result(output([KLEPPMANN(), neetcode(1200)], { split: crowdedOut }), "format-minutes")?.met).toBe(false);
  });

  it("overfull is met when the reading and practice together take over 1.1 times the plan's minutes", () => {
    // 1.1 times 2880 is 3168.
    expect(result(output([material("M1", "A", { minutes: 3200 })]), "overfull")?.met).toBe(true);
    expect(result(output([material("M1", "A", { minutes: 3100 })]), "overfull")?.met).toBe(false);
    // 2000 of reading fits; with 1200 of problems it does not.
    expect(result(output([material("M1", "A", { minutes: 2000 }), neetcode(1200)]), "overfull")).toMatchObject({ met: true, evidence: "2000 min of reading and 1200 min of practice against 3168 min" });
    expect(result(output([material("M1", "A", { minutes: 2000 }), neetcode(1000)]), "overfull")?.met).toBe(false);
  });

  it("coverage-stated is met with two covered areas that are not the topic itself", () => {
    const coverage = (covered: string[]) => output([KLEPPMANN()], { coverage: { covered, open: [] } });
    expect(result(coverage(["Databases", "Algorithms"]), "coverage-stated")?.met).toBe(true);
    expect(result(coverage(["Databases"]), "coverage-stated")?.met).toBe(false);
    expect(result(coverage(["Databases", "Senior software engineer interview preparation."]), "coverage-stated")?.met).toBe(false);
    expect(result(output([KLEPPMANN()], { coverage: { covered: [], open: ["Databases"] } }), "coverage-stated")?.met).toBe(false);
    expect(result(output([KLEPPMANN()]), "coverage-stated")?.met).toBe(false);
  });

  it("cov-claims asks for a stated coverage, so an empty one does not pass by default", () => {
    expect(ALLOCATE_CRITERIA.find((c) => c.id === "cov-claims")?.text).toMatch(/names the areas it covers/);
  });

  it("leaves out label criteria for a topic without labels", () => {
    const ids = codeResults(output([KLEPPMANN()]), NO_LABELS).map((r) => r.id);
    expect(ids).not.toContain("backbone-labelled");
    expect(ids).not.toContain("expected-books");
    expect(ids).not.toContain("named-list-kept");
    expect(ids).toEqual(expect.arrayContaining(["backbone-chosen", "format-minutes", "overfull", "coverage-stated"]));
  });

  it("holds the code criteria first, then the judge criteria", () => {
    const codeIds = ["backbone-labelled", "backbone-chosen", "expected-books", "learner-dropped", "named-list-kept", "format-minutes", "overfull", "coverage-stated"];
    expect(ALLOCATE_CRITERIA.filter((c) => c.grader === "code").map((c) => c.id)).toEqual(codeIds);
    expect(ALLOCATE_CRITERIA.slice(0, codeIds.length).every((c) => c.grader === "code")).toBe(true);
    const judged = ALLOCATE_CRITERIA.filter((c) => c.grader === "judge");
    expect(judged.map((c) => [c.id, c.dimension, c.weight])).toEqual([
      ["cov-claims", "coverage", 3],
      ["cov-core", "coverage", 3],
      ["cov-open-honest", "coverage", 1],
      ["fit-share", "fit", 3],
      ["fit-formats", "fit", 3],
      ["src-proportion", "fidelity", 3],
      ["src-offtopic", "fidelity", -5],
      ["src-better-dropped", "fidelity", -2],
    ]);
    expect(judged.every((c) => c.group === "quality")).toBe(true);
  });

  it("leaves out criteria the allocation's own code makes true by construction", () => {
    // applyAllocation drops a pick nothing serves and works the reading share from the kept reading itself.
    const ids = ALLOCATE_CRITERIA.map((c) => c.id);
    expect(ids).not.toContain("formats-served");
    expect(ids).not.toContain("fits-hours");
  });

  it("gives every criterion a distinct id", () => {
    const ids = ALLOCATE_CRITERIA.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("renderAllocation", () => {
  const split: PlanSplit = {
    readingShare: 60,
    practice: "problems and mocks",
    reason: "Interviews are won by practice.",
    formats: [
      { format: "problem-set", share: 70, focus: "data structures", reason: "Many small problems." },
      { format: "mock", share: 30, focus: "whole interviews", reason: "Pressure." },
    ],
  };
  const rendered = renderAllocation(
    output([KLEPPMANN()], {
      split,
      dropped: [{ title: "A blog post", reason: "Covered by the book" }],
      coverage: { covered: ["Databases"], open: ["Networking"] },
    }),
    { ...FIXTURE.input, instructions: "Focus on system design" },
  );

  it("states the request, the split, the kept and dropped materials and the coverage", () => {
    expect(rendered).toContain("Senior software engineer interview preparation");
    expect(rendered).toContain("Focus on system design");
    expect(rendered).toContain("8 weeks");
    expect(rendered).toContain("6 hours a week");
    expect(rendered).toContain("60%");
    expect(rendered).toContain("Interviews are won by practice.");
    expect(rendered).toContain("Problems");
    expect(rendered).toContain("data structures");
    expect(rendered).toContain("Designing Data-Intensive Applications");
    expect(rendered).toContain("A blog post");
    expect(rendered).toContain("Covered by the book");
    expect(rendered).toContain("Databases");
    expect(rendered).toContain("Networking");
  });

  it("renders no model name", () => {
    for (const { id } of AVAILABLE_MODELS) {
      expect(rendered).not.toContain(id);
      expect(rendered).not.toContain(id.split("/")[1]);
    }
  });

  it("says so when nothing was dropped or no coverage was stated", () => {
    const plain = renderAllocation(output([KLEPPMANN()]), FIXTURE.input);
    expect(plain).toMatch(/dropped[^\n]*\n\s*none/i);
    expect(plain).toMatch(/coverage[^\n]*\n\s*none stated/i);
  });
});
