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
import { ALLOCATE_CRITERIA, codeResults, runAllocateSample, voidReason, type AllocateCtx, type AllocateOutput } from "./allocate";

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

function allocation(extra: { fallback?: boolean; events?: ServiceEvent[] } = {}): typeof allocatePlan {
  return vi.fn(async (input) => {
    input.log?.onCall?.(CALL);
    for (const event of extra.events ?? []) input.log?.onService?.(event);
    return { split: ALL_READING, materials: [KLEPPMANN()], dropped: [], coverage: null, costUsd: 0.25, fallback: extra.fallback ?? false };
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

  it("formats-served is met unless a picked format has no material and cannot be generated", () => {
    const served = output([KLEPPMANN()], { split: { readingShare: 100, practice: "p", reason: "", formats: [] } });
    expect(result(served, "formats-served")?.met).toBe(true);
    const unserved = output([KLEPPMANN()], { split: { readingShare: 50, practice: "problem-set", reason: "", formats: [{ format: "problem-set", share: 100 }] } as PlanSplit });
    expect(result(unserved, "formats-served")).toMatchObject({ met: false, evidence: expect.stringContaining("problem-set") });
  });

  it("format-minutes is met unless a served format gets under half its share", () => {
    const split = { readingShare: 50, practice: "problem-set", reason: "", formats: [{ format: "problem-set", share: 100 }] } as PlanSplit;
    const small = material("M3", "NeetCode 150", { minutes: null, practice: { ...list("neetcode", 3), minutes: 100 } as Material["practice"] });
    const big = material("M3", "NeetCode 150", { minutes: null, practice: { ...list("neetcode", 3), minutes: 1200 } as Material["practice"] });
    expect(result(output([KLEPPMANN(), small], { split }), "format-minutes")?.met).toBe(false);
    expect(result(output([KLEPPMANN(), big], { split }), "format-minutes")?.met).toBe(true);
  });

  it("fits-hours is met when the reading stays within 1.2 times its share of the plan", () => {
    // Reading share 50% of 2880 minutes is 1440; 1.2 times is 1728.
    const split = { ...ALL_READING, readingShare: 50 };
    expect(result(output([material("M1", "A", { minutes: 1700 })], { split }), "fits-hours")).toMatchObject({ met: true, evidence: expect.stringContaining("1728") });
    expect(result(output([material("M1", "A", { minutes: 1800 })], { split }), "fits-hours")?.met).toBe(false);
  });

  it("fits-hours leaves practice-only materials out of the reading", () => {
    const practiceOnly = material("M3", "NeetCode 150", { minutes: null, practice: { format: "problem-set", answers: true, minutes: 9000, list: null } as Material["practice"] });
    expect(result(output([material("M1", "A", { minutes: 1000 }), practiceOnly]), "fits-hours")?.met).toBe(true);
  });

  it("overfull is met when the reading exceeds 1.5 times all the plan's minutes", () => {
    // 1.5 times 2880 is 4320.
    expect(result(output([material("M1", "A", { minutes: 4400 })]), "overfull")?.met).toBe(true);
    expect(result(output([material("M1", "A", { minutes: 4300 })]), "overfull")?.met).toBe(false);
  });

  it("coverage-stated is met with at least one covered area", () => {
    expect(result(output([KLEPPMANN()], { coverage: { covered: ["Databases"], open: [] } }), "coverage-stated")?.met).toBe(true);
    expect(result(output([KLEPPMANN()], { coverage: { covered: [], open: ["Databases"] } }), "coverage-stated")?.met).toBe(false);
    expect(result(output([KLEPPMANN()]), "coverage-stated")?.met).toBe(false);
  });

  it("leaves out label criteria for a topic without labels", () => {
    const ids = codeResults(output([KLEPPMANN()]), NO_LABELS).map((r) => r.id);
    expect(ids).not.toContain("backbone-labelled");
    expect(ids).not.toContain("expected-books");
    expect(ids).not.toContain("named-list-kept");
    expect(ids).toEqual(expect.arrayContaining(["backbone-chosen", "formats-served", "format-minutes", "fits-hours", "overfull", "coverage-stated"]));
  });

  it("holds code criteria only, each with an id, a group and a weight", () => {
    expect(ALLOCATE_CRITERIA.map((c) => c.id)).toEqual([
      "backbone-labelled", "backbone-chosen", "expected-books", "learner-dropped", "named-list-kept", "formats-served", "format-minutes", "fits-hours", "overfull", "coverage-stated",
    ]);
    expect(ALLOCATE_CRITERIA.every((c) => c.grader === "code")).toBe(true);
  });
});
