import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { generateObject } from "ai";
import type { Material } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
import { calibrateBenchmark, captureFixtures, rescoreBenchmark, runBenchmark } from "./run";
import { JUDGE, SECOND_JUDGE, judgeDimension, type JudgeCache } from "./judge";
import type { AllocateFixture } from "./fixtures";
import type { AllocateOutput, runAllocateSample } from "./tasks/allocate";
import type { CriterionResult, Sample } from "./types";

function material(id: string, title: string, extra: Partial<Material> = {}): Material {
  return { id, origin: "research", type: "link", kind: "book", url: `https://x/${id}`, title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null, minutes: 60, ...extra } as Material;
}

const ALL_READING: PlanSplit = { readingShare: 100, practice: "reading", reason: "", formats: [] };
const OUTPUT: AllocateOutput = { split: ALL_READING, materials: [material("M1", "Designing Data-Intensive Applications", { author: "Martin Kleppmann", backbone: true })], dropped: [], coverage: null };

function fixture(id: string, baseline: AllocateFixture["baseline"] = null): AllocateFixture {
  return {
    id, topic: "sde", sourceRun: `run-${id}`, commit: "abc1234", baseline,
    input: { topic: "Senior software engineer interview preparation", weeks: 8, daysPerWeek: 5, hoursPerWeek: 6, materials: [material("M1", "Designing Data-Intensive Applications")] },
  };
}

let root: string;
let fixturesRoot: string;
let outDir: string;
let calibrationDir: string;

function saveFixture(f: AllocateFixture) {
  mkdirSync(join(fixturesRoot, f.id), { recursive: true });
  writeFileSync(join(fixturesRoot, f.id, "allocate.json"), JSON.stringify(f));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-run-"));
  fixturesRoot = join(root, "fixtures");
  outDir = join(root, "results");
  calibrationDir = join(root, "calibration");
  saveFixture(fixture("sde-1"));
  saveFixture(fixture("sde-2"));
});

type SampleRun = Awaited<ReturnType<typeof runAllocateSample>>;
const completed = (costUsd = 0.1): SampleRun => ({ gate: { status: "completed" }, output: OUTPUT, calls: [], costUsd, ms: 14_000 });

/** A sample runner that answers with `answer` for every call. */
const runner = (answer: () => SampleRun = () => completed()) => vi.fn(async (_fixture: AllocateFixture, _contestant: unknown) => answer()) as unknown as typeof runAllocateSample & ReturnType<typeof vi.fn>;

/** A judge stand-in that meets every criterion it is given and charges `costUsd` a call. */
const judge = (costUsd = 0) =>
  vi.fn(async (args: Parameters<typeof judgeDimension>[0]) => ({
    results: args.criteria.map((c): CriterionResult => ({ id: c.id, met: true, evidence: "ok", grader: "judge", judge: args.judge.model })),
    costUsd,
    calls: [],
  })) as unknown as typeof judgeDimension & ReturnType<typeof vi.fn>;

const cheap = () => ({ contestantsUsd: 0.1, judgingUsd: 0.1, totalUsd: 0.2 });

function base(over: Record<string, unknown> = {}) {
  return {
    task: "allocate" as const, fixtures: ["sde-1", "sde-2"], contestants: ["gpt-5.4-mini"], epochs: 2, maxUsd: 100, margin: 0.05,
    outDir, fixturesRoot, calibrationDir, now: "2026-10-29T10:00:00.000Z", print: () => {}, estimate: cheap, ...over,
  };
}

function readSamples(dir: string): Sample[] {
  return readdirSync(join(dir, "samples")).sort().map((f) => JSON.parse(readFileSync(join(dir, "samples", f), "utf8")) as Sample);
}

describe("runBenchmark", () => {
  it("refuses over the cap before any call", async () => {
    const runSample = runner();
    const judgeFn = judge();
    const heavy = [fixture("sde-1", { inputTokens: 200_000, outputTokens: 50_000, ms: 1 }), fixture("sde-2", { inputTokens: 200_000, outputTokens: 50_000, ms: 1 })];
    heavy.forEach(saveFixture);
    await expect(runBenchmark({ ...base({ maxUsd: 0.01 }), estimate: undefined, runSample, judge: judgeFn })).rejects.toThrow(/over the \$0\.01 cap/);
    expect(runSample).not.toHaveBeenCalled();
    expect(judgeFn).not.toHaveBeenCalled();
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses an unknown contestant before any call", async () => {
    const runSample = runner();
    await expect(runBenchmark({ ...base({ contestants: ["nope"] }), runSample, judge: judge() })).rejects.toThrow(/Unknown contestant "nope"/);
    expect(runSample).not.toHaveBeenCalled();
  });

  it("writes the run folder and a report", async () => {
    const lines: string[] = [];
    const runSample = runner();
    const judgeFn = judge();
    const { dir, summaries } = await runBenchmark({ ...base({ print: (l: string) => lines.push(l) }), runSample, judge: judgeFn, commit: "abc1234" });

    expect(dir).toBe(join(outDir, "2026-10-29T10-00-00-000Z-allocate"));
    for (const file of ["run.json", "scores.json", "report.md", "chart.svg", "samples/baseline-sde-1-1.json", "samples/gpt-5.4-mini-sde-2-2.json"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    expect(readdirSync(join(dir, "samples"))).toHaveLength(8);
    expect(summaries.map((s) => s.name)).toEqual(["baseline", "gpt-5.4-mini"]);

    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect(run).toMatchObject({
      task: "allocate", fixtures: ["sde-1", "sde-2"], epochs: 2, maxUsd: 100, margin: 0.05, commit: "abc1234", startedAt: "2026-10-29T10:00:00.000Z",
      judge: JUDGE, secondJudge: SECOND_JUDGE, estimate: cheap(),
    });
    expect(run.contestants.map((c: { name: string }) => c.name)).toEqual(["baseline", "gpt-5.4-mini"]);
    expect(run.contestants[1].roles.allocate.model).toBe("openai/gpt-5.4-mini");

    const sample = JSON.parse(readFileSync(join(dir, "samples/baseline-sde-1-1.json"), "utf8")) as Sample;
    expect(sample).toMatchObject({ task: "allocate", fixture: "sde-1", contestant: "baseline", epoch: 1, judged: true });
    expect(sample.output).toEqual(OUTPUT);
    expect(sample.results.some((r) => r.grader === "code")).toBe(true);
    expect(sample.results.filter((r) => r.grader === "judge")).toHaveLength(8);
    expect(sample.secondJudge).toHaveLength(8);

    // Three dimensions per sample, and the second judge on the first of each contestant's four samples.
    expect(judgeFn).toHaveBeenCalledTimes(8 * 3 + 2 * 3);
    expect(judgeFn.mock.calls.filter(([a]) => a.judge.model === SECOND_JUDGE.model)).toHaveLength(6);

    const report = readFileSync(join(dir, "report.md"), "utf8");
    expect(report).toContain("# Model benchmark: allocate");
    expect(report).toContain("(unchecked)");
    expect(lines.filter((l) => /^baseline sde-1 #1: \d\.\d\d · 14 s · \$0\.10$/.test(l))).toHaveLength(1);
    expect(lines.at(-1)).toBe(`Report: ${join(dir, "report.md")}`);
  });

  it("stops starting samples once the cap is reached and writes the report", async () => {
    const runSample = runner(() => completed(0.3));
    const lines: string[] = [];
    const { dir } = await runBenchmark({ ...base({ maxUsd: 1, print: (l: string) => lines.push(l) }), concurrency: 1, runSample, judge: judge() });
    expect(runSample).toHaveBeenCalledTimes(4);
    expect(lines).toContain("4 of 8 samples not started: the spend cap was reached");
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).notStarted).toBe(4);
    expect(readdirSync(join(dir, "samples"))).toHaveLength(4);
    expect(existsSync(join(dir, "report.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).spentUsd).toBeCloseTo(1.2);
  });

  it("makes no more judge calls once the cap is reached and marks the sample unjudged", async () => {
    const runSample = runner(() => completed(0.3));
    const judgeFn = judge(0.1);
    const { dir, summaries } = await runBenchmark({ ...base({ maxUsd: 1 }), concurrency: 1, runSample, judge: judgeFn });
    // First sample: 0.3 + three judge calls + three of the second judge = 0.9. The second sample starts, reaches 1.2, is not judged.
    expect(runSample).toHaveBeenCalledTimes(2);
    expect(judgeFn).toHaveBeenCalledTimes(6);
    const [first, second] = readSamples(dir);
    expect(first.judged).toBe(true);
    expect(second.judged).toBe(false);
    expect(second.results.every((r) => r.grader === "code")).toBe(true);
    expect(summaries.find((s) => s.name === "baseline")?.unjudged).toBe(1);
  });

  it("leaves the second judge off a sample when the cap stops it part way", async () => {
    const runSample = runner(() => completed(0.3));
    // 0.3 + three primary calls at 0.2 reaches 0.9; the second judge's first call (0.9 is under 1) takes it to 1.1.
    const { dir } = await runBenchmark({ ...base({ maxUsd: 1, fixtures: ["sde-1"], epochs: 1 }), concurrency: 1, runSample, judge: judge(0.2) });
    const [sample] = readSamples(dir).filter((s) => s.contestant === "baseline");
    expect(sample.judged).toBe(true);
    expect(sample.secondJudge).toBeUndefined();
  });

  it("re-runs a void sample once and saves the final attempt, counting both costs", async () => {
    let calls = 0;
    const runSample = runner(() => (++calls === 1 ? { gate: { status: "void", reason: "gateway 503" }, output: null, calls: [], costUsd: 0.2, ms: 1 } : completed(0.1)));
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample, judge: judge() });
    expect(runSample).toHaveBeenCalledTimes(2);
    const [sample] = readSamples(dir);
    expect(sample.gate).toEqual({ status: "completed" });
    expect(sample.costUsd).toBe(0.1);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).spentUsd).toBeCloseTo(0.3);
  });

  it("keeps a sample void when the re-run is void too, and does not judge it", async () => {
    const runSample = runner(() => ({ gate: { status: "void", reason: "gateway 503" }, output: null, calls: [], costUsd: 0, ms: 1 }));
    const judgeFn = judge();
    const { dir, summaries } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample, judge: judgeFn });
    expect(runSample).toHaveBeenCalledTimes(2);
    expect(judgeFn).not.toHaveBeenCalled();
    expect(readSamples(dir)[0].gate.status).toBe("void");
    expect(summaries[0].voids).toBe(1);
  });

  it("skips the second judge for a sample whose primary judge failed", async () => {
    const judgeFn = vi.fn(async (args: Parameters<typeof judgeDimension>[0]) => {
      if (args.judge.model === JUDGE.model) throw new Error("gateway down");
      throw new Error("the second judge must not be asked");
    }) as unknown as typeof judgeDimension & ReturnType<typeof vi.fn>;
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1 }), runSample: runner(), judge: judgeFn });
    expect(judgeFn.mock.calls.every(([a]) => a.judge.model === JUDGE.model)).toBe(true);
    expect(readSamples(dir).every((s) => !s.judged && s.secondJudge === undefined)).toBe(true);
  });

  it("fails before any call when a calibration file is broken, naming it", async () => {
    mkdirSync(calibrationDir, { recursive: true });
    writeFileSync(join(calibrationDir, "allocate-broken.json"), '{ "task": "allocate", ');
    const runSample = runner();
    await expect(runBenchmark({ ...base(), runSample, judge: judge() })).rejects.toThrow(/allocate-broken\.json is not valid JSON/);
    expect(runSample).not.toHaveBeenCalled();
  });

  it("saves a failed sample as judged, with no judge calls", async () => {
    const runSample = runner(() => ({ gate: { status: "failed", reason: "fallback: no time" }, output: OUTPUT, calls: [], costUsd: 0.1, ms: 1 }));
    const judgeFn = judge();
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample, judge: judgeFn });
    expect(judgeFn).not.toHaveBeenCalled();
    expect(readSamples(dir)[0]).toMatchObject({ judged: true, results: [] });
  });

  it("keeps going when a sample's run throws, voiding that sample", async () => {
    const runSample = runner(() => {
      throw new Error("boom");
    });
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample, judge: judge() });
    expect(readSamples(dir)[0].gate).toEqual({ status: "void", reason: "harness error: boom" });
  });
});

/** A generate stand-in that meets every id it might be asked about. */
function fakeGenerate() {
  const ids = ["cov-claims", "cov-core", "cov-open-honest", "fit-share", "fit-formats", "src-proportion", "src-offtopic", "src-better-dropped"];
  return vi.fn(async (_options: Record<string, unknown>) => ({
    object: { verdicts: ids.map((id) => ({ id, met: true, reason: "ok" })) },
    usage: { inputTokens: 1000, outputTokens: 100 },
    finishReason: "stop",
  }));
}

describe("rescoreBenchmark", () => {
  function memoryCache() {
    const store = new Map<string, CriterionResult[]>();
    const cache: JudgeCache = { get: (key) => store.get(key), set: (key, results) => void store.set(key, results) };
    return { store, cache };
  }

  it("judges only what the cache lacks", async () => {
    const generate = fakeGenerate();
    const { store, cache } = memoryCache();
    const judgeFn = ((args: Parameters<typeof judgeDimension>[0]) => judgeDimension({ ...args, generate: generate as unknown as typeof generateObject })) as typeof judgeDimension;

    // The contestants answer differently, so no two samples share a cache entry.
    const runSample = vi.fn(async (_fixture: AllocateFixture, contestant: { name: string }) =>
      contestant.name === "baseline" ? completed() : { ...completed(), output: { ...OUTPUT, materials: [material("M2", "Another book")] } },
    ) as unknown as typeof runAllocateSample;
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1 }), runSample, judge: judgeFn, cache });
    const asked = generate.mock.calls.length;
    expect(asked).toBe(2 * 3 + 2 * 3);

    // Tamper with a saved sample so the rescore has code results to recompute.
    const path = join(dir, "samples/baseline-sde-1-1.json");
    const saved = JSON.parse(readFileSync(path, "utf8")) as Sample;
    writeFileSync(path, JSON.stringify({ ...saved, results: saved.results.filter((r) => r.grader === "judge") }));

    await rescoreBenchmark(dir, { judge: judgeFn, cache, fixturesRoot, calibrationDir, print: () => {} });
    expect(generate.mock.calls.length).toBe(asked);
    const rescored = JSON.parse(readFileSync(path, "utf8")) as Sample;
    expect(rescored.results.some((r) => r.id === "backbone-chosen" && r.grader === "code")).toBe(true);

    // Forget one dimension's answer: the rescore asks once, for that.
    store.delete([...store.keys()][0]);
    await rescoreBenchmark(dir, { judge: judgeFn, cache, fixturesRoot, calibrationDir, print: () => {} });
    expect(generate.mock.calls.length).toBe(asked + 1);
  });

  it("judges the samples a cap left unjudged and rewrites the report", async () => {
    const { cache } = memoryCache();
    const runSample = runner(() => completed(0.3));
    const { dir } = await runBenchmark({ ...base({ maxUsd: 1 }), concurrency: 1, runSample, judge: judge(0.1), cache });
    expect(readSamples(dir).filter((s) => !s.judged)).toHaveLength(1);

    const fresh = judge(0);
    const { summaries } = await rescoreBenchmark(dir, { judge: fresh, cache, fixturesRoot, calibrationDir, print: () => {} });
    expect(readSamples(dir).every((s) => s.judged)).toBe(true);
    expect(summaries.find((s) => s.name === "baseline")?.unjudged).toBe(0);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("# Model benchmark: allocate");
  });

  it("stops asking the judge once its own cap is reached, keeping the saved judgments", async () => {
    const { cache } = memoryCache();
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1 }), runSample: runner(), judge: judge(), cache });
    const expensive = judge(5);
    await rescoreBenchmark(dir, { judge: expensive, cache: memoryCache().cache, maxUsd: 1, concurrency: 1, fixturesRoot, calibrationDir, print: () => {} });
    // The first call costs 5, over the cap of 1: no second call is made, and the other dimensions keep their saved answers.
    expect(expensive).toHaveBeenCalledTimes(1);
    for (const sample of readSamples(dir)) {
      expect(sample.judged).toBe(true);
      expect(sample.results.filter((r) => r.grader === "judge")).toHaveLength(8);
    }
  });

  it("keeps the saved judge results when a rescore gets no new answer", async () => {
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1 }), runSample: runner(), judge: judge(), cache: memoryCache().cache });
    const before = readSamples(dir);
    expect(before.every((s) => s.judged && s.secondJudge)).toBe(true);

    // An empty cache and a judge that cannot answer: nothing new is obtained.
    const broken = vi.fn(async () => {
      throw new Error("gateway down");
    }) as unknown as typeof judgeDimension;
    await rescoreBenchmark(dir, { judge: broken, cache: memoryCache().cache, maxUsd: 0, fixturesRoot, calibrationDir, print: () => {} });
    const after = readSamples(dir);
    expect(after.map((s) => s.judged)).toEqual([true, true]);
    expect(after.map((s) => s.results)).toEqual(before.map((s) => s.results));
    expect(after.map((s) => s.secondJudge)).toEqual(before.map((s) => s.secondJudge));
  });
});

describe("calibrateBenchmark", () => {
  it("writes a calibration file for the judged samples and returns its path", async () => {
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 2 }), runSample: runner(), judge: judge() });
    const path = calibrateBenchmark(dir, { fixturesRoot, calibrationDir });
    expect(path.startsWith(calibrationDir)).toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file).toMatchObject({ task: "allocate", judge: JUDGE.model });
    expect(file.items).toHaveLength(4);
    expect(file.items[0].rendered).toContain("Kept materials");
    expect(file.items[0].grades.every((g: { owner: unknown }) => g.owner === null)).toBe(true);
  });
});

describe("captureFixtures", () => {
  it("prints why a folder was refused and goes on to the next", () => {
    const lines: string[] = [];
    const ok = captureFixtures([join(root, "missing-1"), join(root, "missing-2")], fixturesRoot, (l) => lines.push(l));
    expect(ok).toBe(false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("missing-1 refused:");
    expect(lines[1]).toContain("missing-2 refused:");
  });
});
