import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelCall } from "@/lib/ai/logged";
import { DEFAULT_HOURS_PER_WEEK } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import { DRAFT_TOPICS } from "@/evals/draft/topics";
import { writeRun, type RunMeta, type RunRecord, type TimedEvent } from "@/evals/draft/record";
import { captureFixture, loadFixture } from "./fixtures";

const META: RunMeta = {
  topic: "sde",
  run: 1,
  startedAt: "2026-10-29T10:00:00.000Z",
  commit: "abc1234",
  key: "app",
  models: {},
  request: { topic: "Senior software engineer interview preparation", weeks: 8, daysPerWeek: 5, hoursPerWeek: 7, granularity: "day", instructions: "Focus on system design", materials: [] },
  ms: 1,
  costUsd: 0,
  costByStage: {},
};

function material(id: string, title: string): Material {
  return { id, origin: "research", type: "link", kind: "docs", url: "https://x", title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null } as Material;
}

function call(label: string, inputTokens: number | null, outputTokens: number | null, latencyMs: number): ModelCall {
  return { caller: "outline", model: "anthropic/claude-sonnet-5.5", effort: null, keyOwner: "app", inputTokens, outputTokens, cacheReadTokens: null, reasoningTokens: null, costUsd: 0.1, latencyMs, trackId: null, userId: null, label, system: null, prompt: "p", response: "r", finishReason: "stop", facts: [] };
}

const MATERIALS = [material("M1", "DDIA"), material("M2", "System Design Interview")];

function done(materials: Material[]): TimedEvent {
  return { type: "research.done", materials, dropped: [], counts: { searches: 1, fetches: 1 }, t: 10 } as TimedEvent;
}

function record(overrides: Partial<Omit<RunRecord, "meta">> & { meta?: Partial<RunMeta> } = {}): RunRecord {
  return {
    events: [{ type: "research.start", caps: { searches: 1, fetches: 1, steps: 1 }, t: 1 } as TimedEvent, done(MATERIALS)],
    calls: [call("Research", 5, 5, 5), call("Allocate", 1200, 340, 4200)],
    materials: { verified: [], allocated: null, dropped: [], coverage: null },
    split: null,
    plan: null,
    ...overrides,
    meta: { ...META, ...overrides.meta },
  };
}

let evals: string;
let root: string;
beforeEach(() => {
  evals = mkdtempSync(join(tmpdir(), "bench-evals-"));
  root = mkdtempSync(join(tmpdir(), "bench-fixtures-"));
});
afterEach(() => {
  rmSync(evals, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** Saves a run folder under the temp eval directory and returns its path. */
function saved(name: string, rec: RunRecord = record()): string {
  const dir = join(evals, name);
  writeRun(dir, rec);
  return dir;
}

describe("captureFixture", () => {
  it("freezes research's materials as the allocation input", () => {
    const fixture = captureFixture(saved("sde-1"), root);
    expect(fixture.input.materials).toEqual(MATERIALS);
    expect(fixture.input).toMatchObject({ topic: META.request!.topic, instructions: "Focus on system design", weeks: 8, daysPerWeek: 5, hoursPerWeek: 7 });
    expect(fixture).toMatchObject({ id: "sde-1", topic: "sde", sourceRun: "sde-1", commit: "abc1234" });
    expect(loadFixture("sde-1", root)).toEqual(fixture);
  });

  it("writes allocate.json pretty-printed", () => {
    captureFixture(saved("sde-1"), root);
    const text = readFileSync(join(root, "sde-1", "allocate.json"), "utf8");
    expect(text).toContain('\n  "id": "sde-1"');
  });

  it("takes the baseline from the Allocate call", () => {
    expect(captureFixture(saved("sde-1"), root).baseline).toEqual({ inputTokens: 1200, outputTokens: 340, ms: 4200 });
  });

  it("has no baseline when the allocation fell back", () => {
    const rec = record({ calls: [call("Research", 5, 5, 5)] });
    expect(captureFixture(saved("sde-1", rec), root).baseline).toBeNull();
  });

  it("defaults the hours per week and leaves out absent instructions", () => {
    const { hoursPerWeek: _hours, instructions: _instructions, ...request } = META.request!;
    const fixture = captureFixture(saved("sde-1", record({ meta: { request } })), root);
    expect(fixture.input.hoursPerWeek).toBe(DEFAULT_HOURS_PER_WEEK);
    expect(fixture.input).not.toHaveProperty("instructions");
  });

  it("falls back to the topic's request when the folder has none", () => {
    const fixture = captureFixture(saved("sde-1", record({ meta: { request: undefined } })), root);
    expect(fixture.input.topic).toBe(DRAFT_TOPICS.sde.request.topic);
    expect(fixture.input.weeks).toBe(DRAFT_TOPICS.sde.request.weeks);
  });

  it("numbers fixtures per topic", () => {
    expect(captureFixture(saved("sde-a"), root).id).toBe("sde-1");
    expect(captureFixture(saved("sde-b"), root).id).toBe("sde-2");
    expect(readdirSync(root).sort()).toEqual(["sde-1", "sde-2"]);
  });

  it("refuses a run with no research.done", () => {
    const dir = saved("sde-1", record({ events: [{ type: "research.start", caps: { searches: 1, fetches: 1, steps: 1 }, t: 1 } as TimedEvent] }));
    expect(() => captureFixture(dir, root)).toThrow(dir);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a run whose research found nothing", () => {
    const dir = saved("sde-1", record({ events: [done([])] }));
    expect(() => captureFixture(dir, root)).toThrow(dir);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a run with no request and no topic to fall back on", () => {
    const dir = saved("odd-1", record({ meta: { topic: "odd", request: undefined } }));
    expect(() => captureFixture(dir, root)).toThrow(dir);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a folder already captured", () => {
    const dir = saved("sde-1");
    captureFixture(dir, root);
    expect(() => captureFixture(dir, root)).toThrow(dir);
    expect(readdirSync(root)).toEqual(["sde-1"]);
  });
});

describe("loadFixture", () => {
  it("throws naming the id when there is no such fixture", () => {
    expect(existsSync(join(root, "sde-9"))).toBe(false);
    expect(() => loadFixture("sde-9", root)).toThrow("sde-9");
  });
});
