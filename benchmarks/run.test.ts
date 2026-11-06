import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { generateObject } from "ai";
import type { ModelCall } from "@/lib/ai/logged";
import { writeRun, type RunRecord, type TimedEvent } from "@/evals/draft/record";
import type { Material } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";
import { calibrateBenchmark, captureFixtures, rescoreBenchmark, runBenchmark } from "./run";
import { JUDGE, JUDGE_INSTRUCTIONS, SECOND_JUDGE, judgeDimension, type JudgeCache } from "./judge";
import type { AllocateFixture } from "./fixtures";
import type { AllocateOutput, runAllocateSample } from "./tasks/allocate";
import { OUTLINE_JUDGE_INSTRUCTIONS, type OutlineOutput, type runOutlineSample } from "./tasks/outline";
import { outlineFixturePath, type OutlineFixture } from "./tasks/outlineFixtures";
import { layout, makeRoot, type PlanNode } from "@/lib/planTree";
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
    // Allocate's judge is sent allocate's instructions, unchanged, so its cached answers still apply.
    expect(judgeFn.mock.calls.every(([a]) => a.instructions === JUDGE_INSTRUCTIONS)).toBe(true);

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

  it("leaves the second judge off a sample when the cap is reached before it starts", async () => {
    const runSample = runner(() => completed(0.3));
    // 0.3 + three primary calls at 0.25 is 1.05, over the cap of 1: the second judge makes no call.
    const judgeFn = judge(0.25);
    const { dir } = await runBenchmark({ ...base({ maxUsd: 1, fixtures: ["sde-1"], epochs: 1 }), concurrency: 1, runSample, judge: judgeFn });
    const [sample] = readSamples(dir).filter((s) => s.contestant === "baseline");
    expect(judgeFn).toHaveBeenCalledTimes(3);
    expect(sample.judged).toBe(true);
    expect(sample.secondJudge).toBeUndefined();
  });

  it("asks the dimensions at once and leaves the second judge off when one of its calls fails", async () => {
    const runSample = runner(() => completed(0.3));
    let calls = 0;
    const answer = judge(0.1);
    // Calls 1–3 are the primary judge's dimensions, 4–6 the second judge's; the fifth fails.
    const judgeFn = vi.fn(async (args: Parameters<typeof judgeDimension>[0]) => {
      if (++calls === 5) throw new Error("gateway 500");
      return answer(args);
    }) as unknown as typeof judgeDimension;
    const lines: string[] = [];
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, print: (l: string) => lines.push(l) }), concurrency: 1, runSample, judge: judgeFn });
    const [sample] = readSamples(dir).filter((s) => s.contestant === "baseline");
    expect(calls).toBe(12); // both judges on each contestant's first sample
    expect(sample.judged).toBe(true);
    expect(sample.secondJudge).toBeUndefined();
    expect(lines.some((l) => l.includes("could not judge") && l.includes("gateway 500"))).toBe(true);
  });

  it("re-runs a void sample once and saves the final attempt's outcome with both attempts' calls and costs", async () => {
    let calls = 0;
    const firstCall = { label: "first", costUsd: 0.2 } as ModelCall;
    const secondCall = { label: "second", costUsd: 0.1 } as ModelCall;
    const runSample = runner(() =>
      ++calls === 1 ? { gate: { status: "void", reason: "gateway 503" }, output: null, calls: [firstCall], costUsd: 0.2, ms: 1 } : { ...completed(0.1), calls: [secondCall] },
    );
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample, judge: judge() });
    expect(runSample).toHaveBeenCalledTimes(2);
    const [sample] = readSamples(dir);
    expect(sample.gate).toEqual({ status: "completed" });
    expect(sample.calls.map((c) => c.label)).toEqual(["first", "second"]);
    expect(sample.costUsd).toBeCloseTo(0.3);
    expect(sample.ms).toBe(14_000);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).spentUsd).toBeCloseTo(0.3);
  });

  it("keeps both attempts' estimated costs on a re-run sample, and counts the cap on them", async () => {
    let calls = 0;
    const runSample = runner(() =>
      ++calls === 1
        ? { gate: { status: "void", reason: "gateway 503" }, output: null, calls: [], costUsd: 0.2, estimatedCostUsd: 0.2, ms: 1 }
        : { gate: { status: "failed", reason: "fallback: timeout" }, output: OUTPUT, calls: [], costUsd: 0.1, estimatedCostUsd: 0.1, ms: 1 },
    );
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample, judge: judge() });
    const [sample] = readSamples(dir);
    expect(sample.costUsd).toBeCloseTo(0.3);
    expect(sample.estimatedCostUsd).toBeCloseTo(0.3);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).spentUsd).toBeCloseTo(0.3);
  });

  it("says at the end how many samples carried an estimated cost", async () => {
    let n = 0;
    const runSample = runner(() => ({ ...completed(0.1), ...(++n % 4 === 0 ? { estimatedCostUsd: 0.05 } : {}) }));
    const lines: string[] = [];
    const { dir } = await runBenchmark({ ...base({ print: (l: string) => lines.push(l) }), concurrency: 1, runSample, judge: judge() });
    expect(lines).toContain("2 of 8 samples carry an estimated cost: the call ended without usage");
    expect(lines.indexOf("2 of 8 samples carry an estimated cost: the call ended without usage")).toBeLessThan(lines.findIndex((l) => l.startsWith("Spent ")));
    expect(readSamples(dir).filter((s) => s.estimatedCostUsd !== undefined)).toHaveLength(2);
  });

  it("says nothing about estimates when no sample carried one", async () => {
    const lines: string[] = [];
    await runBenchmark({ ...base({ print: (l: string) => lines.push(l) }), runSample: runner(), judge: judge() });
    expect(lines.some((l) => l.includes("estimated"))).toBe(false);
  });

  it("reads the judge cache before any call and says how many lines it skipped", async () => {
    const order: string[] = [];
    const cache: JudgeCache = { get: () => undefined, set: () => {}, load: () => (order.push("load"), { skippedLines: 2 }) };
    const lines: string[] = [];
    const runSample = runner(() => (order.push("run"), completed()));
    await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, print: (l: string) => lines.push(l) }), runSample, judge: judge(), cache });
    expect(order[0]).toBe("load");
    expect(lines.some((l) => /skipped 2 unreadable lines/.test(l))).toBe(true);
  });

  it("fails before any call when the judge cache cannot be read", async () => {
    const cache: JudgeCache = {
      get: () => undefined,
      set: () => {},
      load: () => {
        throw new Error("EISDIR: illegal operation on a directory");
      },
    };
    const runSample = runner();
    await expect(runBenchmark({ ...base(), runSample, judge: judge(), cache })).rejects.toThrow(/EISDIR/);
    expect(runSample).not.toHaveBeenCalled();
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

  it("stops starting samples once the gateway refuses the key, without re-running that one", async () => {
    const runSample = runner(() => ({ gate: { status: "void", reason: "allocate 402: API key budget exceeded", halt: true }, output: null, calls: [], costUsd: 0, ms: 1 }));
    const lines: string[] = [];
    const { dir, summaries } = await runBenchmark({ ...base({ concurrency: 1, print: (line: string) => lines.push(line) }), runSample, judge: judge() });
    expect(runSample).toHaveBeenCalledTimes(1);
    expect(readSamples(dir)).toHaveLength(1);
    expect(summaries.every((s) => s.verdict !== "worse")).toBe(true);
    expect(lines).toContain("7 of 8 samples not started: allocate 402: API key budget exceeded");
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).notStarted).toBe(7);
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

  it("reads the judge cache before any judge call and says how many lines it skipped", async () => {
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1 }), runSample: runner(), judge: judge(), cache: memoryCache().cache });
    const order: string[] = [];
    const cache: JudgeCache = { get: () => undefined, set: () => {}, load: () => (order.push("load"), { skippedLines: 3 }) };
    const spy = vi.fn(async (args: Parameters<typeof judgeDimension>[0]) => (order.push("judge"), judge()(args)));
    const lines: string[] = [];
    await rescoreBenchmark(dir, { judge: spy as unknown as typeof judgeDimension, cache, fixturesRoot, calibrationDir, print: (l) => lines.push(l) });
    expect(order[0]).toBe("load");
    expect(lines.some((l) => /skipped 3 unreadable lines/.test(l))).toBe(true);
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
    // The first sample's pass costs 15, over the cap of 1: it finishes its three calls, and no later sample asks again.
    expect(expensive).toHaveBeenCalledTimes(3);
    for (const sample of readSamples(dir)) {
      expect(sample.judged).toBe(true);
      expect(sample.results.filter((r) => r.grader === "judge")).toHaveLength(8);
    }
  });

  it("adds each rescore's judge spend to the run's, in run.json and the report", async () => {
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1 }), runSample: runner(() => completed(0.3)), judge: judge(), cache: memoryCache().cache });
    const spentAt = () => (JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as { spentUsd: number }).spentUsd;
    const before = spentAt();
    expect(before).toBeCloseTo(0.6);

    // Each rescore has an empty cache, so every judge call is paid for again.
    const first = judge(0.1);
    await rescoreBenchmark(dir, { judge: first, cache: memoryCache().cache, fixturesRoot, calibrationDir, print: () => {} });
    const afterFirst = before + first.mock.calls.length * 0.1;
    expect(first.mock.calls.length).toBeGreaterThan(0);
    expect(spentAt()).toBeCloseTo(afterFirst);

    const second = judge(0.1);
    await rescoreBenchmark(dir, { judge: second, cache: memoryCache().cache, fixturesRoot, calibrationDir, print: () => {} });
    const total = afterFirst + second.mock.calls.length * 0.1;
    expect(spentAt()).toBeCloseTo(total);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain(`Spend: $${total.toFixed(2)} of the`);
    // The rest of run.json is as the run wrote it.
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toMatchObject({ task: "allocate", epochs: 1, maxUsd: 100, judge: JUDGE, startedAt: "2026-10-29T10:00:00.000Z" });
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

  /** A judge that answers every criterion but `skip`, meeting each with `met`. */
  const skipping = (skip: string, met: boolean) =>
    vi.fn(async (args: Parameters<typeof judgeDimension>[0]) => ({
      results: args.criteria.filter((c) => c.id !== skip).map((c): CriterionResult => ({ id: c.id, met, evidence: "new", grader: "judge", judge: args.judge.model })),
      costUsd: 0,
      calls: [],
    })) as unknown as typeof judgeDimension;

  it("leaves a sample unjudged when the judge skipped a criterion", async () => {
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample: runner(), judge: skipping("src-offtopic", true), cache: memoryCache().cache });
    const [sample] = readSamples(dir);
    expect(sample.judged).toBe(false);
    expect(sample.results.some((r) => r.id === "src-offtopic")).toBe(false);
    expect(sample.secondJudge).toBeUndefined();
  });

  it("rescores a saved allocate run that has no task in run.json", async () => {
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1 }), runSample: runner(), judge: judge(), cache: memoryCache().cache });
    await rescoreBenchmark(dir, { judge: judge(), cache: memoryCache().cache, fixturesRoot, calibrationDir, print: () => {} });
    const expected = readFileSync(join(dir, "scores.json"), "utf8");
    expect(JSON.parse(expected)).toMatchObject({ task: "allocate" });

    const runPath = join(dir, "run.json");
    const { task: _task, ...withoutTask } = JSON.parse(readFileSync(runPath, "utf8"));
    writeFileSync(runPath, JSON.stringify(withoutTask));
    await rescoreBenchmark(dir, { judge: judge(), cache: memoryCache().cache, fixturesRoot, calibrationDir, print: () => {} });
    expect(readFileSync(join(dir, "scores.json"), "utf8")).toBe(expected);
  });

  it("takes a rescore's answers criterion by criterion, keeping the saved one the judge skipped", async () => {
    const { dir } = await runBenchmark({ ...base({ fixtures: ["sde-1"], epochs: 1, contestants: [] }), runSample: runner(), judge: judge(), cache: memoryCache().cache });
    await rescoreBenchmark(dir, { judge: skipping("cov-core", false), cache: memoryCache().cache, fixturesRoot, calibrationDir, print: () => {} });
    const [sample] = readSamples(dir);
    expect(sample.judged).toBe(true);
    expect(sample.results.find((r) => r.id === "cov-core")).toMatchObject({ met: true, evidence: "ok" });
    expect(sample.results.find((r) => r.id === "cov-claims")).toMatchObject({ met: false, evidence: "new" });
  });
});

describe("the outline task", () => {
  function planNode(extra: Partial<PlanNode>): PlanNode {
    return { id: "n", level: "day", title: "t", summary: "s", len: 1, status: "pending", budgetHours: null, manualSplit: false, children: null, start: 1, end: 1, ...extra };
  }
  const BOOK = material("csapp", "Computer Systems: A Programmer's Perspective", { minutes: 600 });
  const WEEK = planNode({ id: "w1", level: "week", title: "Bits and bytes", summary: "How data is stored", len: 2, covers: [{ id: "csapp", chapter: null, note: null }], time: { reading: 240, practice: {} } });
  const TREE = layout(makeRoot([WEEK, planNode({ id: "w2", level: "week", title: "Machine code", summary: "Assembly", len: 2 })]));

  const LEAVES: OutlineFixture = {
    id: "csapp-1/week-1", topic: "csapp", sourceRun: "run", commit: "abc1234", label: "Week 1 · 2 days", group: "leaves", leaf: true,
    request: { topic: "Computer systems", granularity: "day", weeks: 2, daysPerWeek: 2, hoursPerWeek: 4 },
    materials: [BOOK], split: ALL_READING, level: "day", spans: [1, 1], tree: TREE, parentId: "w1", timeLimitMs: 197_295,
    baseline: { inputTokens: 20_000, outputTokens: 4_000, ms: 30_000 },
  };
  const TOP: OutlineFixture = { ...LEAVES, id: "csapp-1/top", label: "Top level · 2 weeks", group: "top", leaf: false, level: "week", spans: [2, 2], tree: undefined, parentId: undefined };

  const DAYS: OutlineOutput = {
    nodes: [
      planNode({ id: "d1", title: "Bits", summary: "How numbers are stored", materials: [{ id: "csapp", chapter: null, tier: "must", minutes: 60, note: "The first part" }] }),
      planNode({ id: "d2", title: "Bytes", summary: "How bytes are ordered", materials: [{ id: "csapp", chapter: null, tier: "must", minutes: 60, note: "The second part" }] }),
    ],
    units: [],
    breaches: [],
    problems: [],
  };
  const WEEKS: OutlineOutput = { nodes: [WEEK, planNode({ id: "w2", level: "week", title: "Machine code", summary: "Assembly", len: 2, time: { reading: 240, practice: {} } })], units: [], breaches: [], problems: [] };

  type OutlineRun = Awaited<ReturnType<typeof runOutlineSample>>;
  const outlineRunner = () =>
    vi.fn(async (f: OutlineFixture, _contestant: unknown): Promise<OutlineRun> => ({ gate: { status: "completed" }, output: f.leaf ? DAYS : WEEKS, calls: [], costUsd: 0.1, ms: 9_000 })) as unknown as typeof runOutlineSample &
      ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const f of [LEAVES, TOP]) {
      const path = outlineFixturePath(f.id, fixturesRoot);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(f));
    }
  });

  const outline = (over: Record<string, unknown> = {}) => base({ task: "outline", fixtures: ["csapp-1/top", "csapp-1/week-1"], ...over });

  it("runs the outline task with a fake sample and writes one report section per group plus routing", async () => {
    const runSample = outlineRunner();
    const judgeFn = judge();
    const { dir } = await runBenchmark({ ...outline(), task: "outline", runSample, judge: judgeFn, commit: "abc1234" });

    expect(dir).toBe(join(outDir, "2026-10-29T10-00-00-000Z-outline"));
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).task).toBe("outline");
    // A fixture id's "/" becomes "__" in the sample's file name; the sample keeps its id.
    const sample = JSON.parse(readFileSync(join(dir, "samples/baseline-csapp-1__top-1.json"), "utf8")) as Sample;
    expect(sample).toMatchObject({ task: "outline", fixture: "csapp-1/top", judged: true });
    expect(sample.results.filter((r) => r.grader === "judge").every((r) => r.id.startsWith("head-"))).toBe(true);
    const leaf = JSON.parse(readFileSync(join(dir, "samples/baseline-csapp-1__week-1-1.json"), "utf8")) as Sample;
    expect(leaf.results.filter((r) => r.grader === "judge").every((r) => r.id.startsWith("leaf-"))).toBe(true);
    // One judge call per applicable dimension: a level is a leaf or a heading, so one per sample.
    expect(judgeFn.mock.calls.every(([a]) => a.dimension === "leaf" || a.dimension === "heading")).toBe(true);
    // Each judge call is told it grades a level of an outline, not an allocation.
    expect(judgeFn.mock.calls.every(([a]) => a.instructions === OUTLINE_JUDGE_INSTRUCTIONS)).toBe(true);
    // Two contestants on two fixtures, one epoch each of two, and the second judge on every fifth sample per contestant.
    expect(judgeFn.mock.calls.filter(([a]) => a.judge.model === JUDGE.model)).toHaveLength(8);

    const report = readFileSync(join(dir, "report.md"), "utf8");
    expect(report).toContain("## Group: top");
    expect(report).toContain("## Group: leaves");
    expect(report).toContain("## Routing");
    expect(report).toContain("(samples/baseline-csapp-1__top-1.json)");
    expect(report.indexOf("## Group: top")).toBeLessThan(report.indexOf("## Routing"));
    expect(report.indexOf("## Group: leaves")).toBeLessThan(report.indexOf("## Routing"));

    const scores = JSON.parse(readFileSync(join(dir, "scores.json"), "utf8"));
    expect(scores).toMatchObject({ task: "outline", margin: 0.05 });
    expect(scores.groups.top.map((s: { name: string }) => s.name)).toEqual(["baseline", "gpt-5.4-mini"]);
    expect(scores.groups.leaves.map((s: { name: string }) => s.name)).toEqual(["baseline", "gpt-5.4-mini"]);
    for (const file of ["chart-top.svg", "chart-leaves.svg"]) expect(existsSync(join(dir, file)), file).toBe(true);
    expect(existsSync(join(dir, "chart.svg"))).toBe(false);
  });

  it("filters outline fixtures by --groups", async () => {
    const runSample = outlineRunner();
    const { dir } = await runBenchmark({ ...outline(), task: "outline", groups: ["leaves"], runSample, judge: judge() });
    expect(runSample.mock.calls.every(([f]) => (f as OutlineFixture).id === "csapp-1/week-1")).toBe(true);
    expect(runSample).toHaveBeenCalledTimes(2 * 2);
    expect(readSamples(dir).every((s) => s.fixture === "csapp-1/week-1")).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "scores.json"), "utf8")).groups)).toEqual(["leaves"]);
  });

  it("refuses --groups with the allocate task, naming the flag", async () => {
    const runSample = runner();
    await expect(runBenchmark({ ...base(), groups: ["leaves"], runSample, judge: judge() })).rejects.toThrow(/--groups/);
    expect(runSample).not.toHaveBeenCalled();
  });

  it("rescores a saved outline run by the task in run.json, keeping the groups", async () => {
    const { dir } = await runBenchmark({ ...outline(), task: "outline", runSample: outlineRunner(), judge: judge() });
    const before = readFileSync(join(dir, "scores.json"), "utf8");
    await rescoreBenchmark(dir, { judge: judge(), cache: { get: () => undefined, set: () => {} }, fixturesRoot, calibrationDir, print: () => {} });
    expect(readFileSync(join(dir, "scores.json"), "utf8")).toBe(before);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("## Routing");
  });

  it("calibrates a saved outline run by the task in run.json", async () => {
    const { dir } = await runBenchmark({ ...outline({ epochs: 1 }), task: "outline", runSample: outlineRunner(), judge: judge() });
    const file = JSON.parse(readFileSync(calibrateBenchmark(dir, { fixturesRoot, calibrationDir }), "utf8"));
    expect(file.task).toBe("outline");
    expect(file.items[0].rendered).toContain("The level as written");
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
  const captureNode = (extra: Partial<PlanNode>): PlanNode => ({ id: "n", level: "day", title: "t", summary: "s", len: 1, status: "pending", budgetHours: null, manualSplit: false, children: null, start: 1, end: 1, ...extra });
  /** A saved draft-eval run with research done, no outline call and `plan`. */
  const captureRecord = (plan: PlanNode | null): RunRecord => ({
    meta: {
      topic: "sde", run: 1, startedAt: "2026-10-29T10:00:00.000Z", commit: "abc1234", key: "app", models: {}, ms: 1, costUsd: 0, costByStage: {},
      request: { topic: "Senior software engineer interview preparation", weeks: 2, daysPerWeek: 2, hoursPerWeek: 4, granularity: "day", materials: [] },
    },
    events: [{ type: "research.done", materials: [material("M1", "DDIA")], dropped: [], counts: { searches: 1, fetches: 1 }, t: 10 } as TimedEvent],
    calls: [],
    materials: { verified: [], allocated: null, dropped: [], coverage: null },
    split: null,
    plan,
  });

  it("prints each folder it captured with its outline count", async () => {
    const runDir = join(root, "evals", "sde-run");
    writeRun(runDir, captureRecord(null));
    const lines: string[] = [];
    expect(await captureFixtures([runDir], fixturesRoot, (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual([`sde-3 captured from ${runDir} (+0 outline)`]);
  });

  it("prints why a folder was refused and goes on to the next", async () => {
    const lines: string[] = [];
    const ok = await captureFixtures([join(root, "missing-1"), join(root, "missing-2")], fixturesRoot, (l) => lines.push(l));
    expect(ok).toBe(false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("missing-1 refused:");
    expect(lines[1]).toContain("missing-2 refused:");
  });

  it("names the planned levels it found no recorded call for", async () => {
    // A plan whose top level and Week 1 were planned, with no outline call recorded for either.
    const day = (id: string) => captureNode({ id, level: "day", title: id, summary: id });
    const week1 = captureNode({ id: "w1", level: "week", title: "Week one", summary: "s", len: 2, children: [day("d1"), day("d2")] });
    const week2 = captureNode({ id: "w2", level: "week", title: "Week two", summary: "s", len: 2 });
    const runDir = join(root, "evals", "sde-run");
    writeRun(runDir, captureRecord(layout(makeRoot([week1, week2]))));
    const lines: string[] = [];
    expect(await captureFixtures([runDir], fixturesRoot, (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual([`sde-3 captured from ${runDir} (+0 outline; skipped: Top level, Week 1)`]);
  });
});
