/**
 * The model benchmark command: runs contestants over frozen fixtures, judges and scores the results, and writes a report.
 *
 *   npx tsx benchmarks/run.ts --capture evals/results/draft-<ts>-sde-1 [<dir> …]   freeze a draft-eval run as a fixture
 *   npx tsx benchmarks/run.ts --task allocate --fixtures sde-1,sde-2,sde-3 --contestants gemini-3-flash,gpt-5.4-mini
 *   npx tsx benchmarks/run.ts --task allocate ... --epochs 5 --max-usd 20 --margin 0.05
 *   npx tsx benchmarks/run.ts --rescore benchmarks/results/<ts>-allocate      no contestant calls; judges only what changed
 *   npx tsx benchmarks/run.ts --calibrate benchmarks/results/<ts>-allocate    pick samples for the owner to grade
 *
 * Always on the app's gateway key (AI_GATEWAY_API_KEY in .env.local); never reads or writes the database.
 */
import "../evals/draft/env";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderMaterials } from "@/lib/ai/planPrompt";
import { scrubSecrets } from "@/evals/draft/record";
import { mapLimit, stamp } from "@/evals/draft/run";
import { DRAFT_TOPICS } from "@/evals/draft/topics";
import { cutAdvice, estimateAllocateRun, SpendCap, type Estimate } from "./budget";
import { CALIBRATION_DIR, checkedCriteria, pickCalibration, writeCalibration, type CalibrationFile } from "./calibration";
import { contestantsFor } from "./contestants";
import { captureFixture, FIXTURES_ROOT, loadFixture, type AllocateFixture } from "./fixtures";
import { fileJudgeCache, JUDGE, judgeDimension, SECOND_JUDGE, secondJudgeSamples, type JudgeCache } from "./judge";
import { renderChart, renderReport, summarize, type ContestantSummary } from "./report";
import { sampleScore } from "./score";
import { ALLOCATE_CRITERIA, codeResults, renderAllocation, runAllocateSample, type AllocateCtx, type AllocateOutput } from "./tasks/allocate";
import type { Contestant, CriterionResult, JudgeCriterion, RoleModel, Sample } from "./types";

const RESULTS_DIR = "benchmarks/results";
const TASK = "allocate";
/** Samples in flight at once for the frozen allocate task. */
const CONCURRENCY = 4;

/** The judge criteria of the allocate task, and the same grouped by the rubric dimension one judge call grades. */
const JUDGE_CRITERIA = ALLOCATE_CRITERIA.filter((c): c is JudgeCriterion => c.grader === "judge");
const DIMENSIONS = new Map<string, JudgeCriterion[]>();
for (const criterion of JUDGE_CRITERIA) DIMENSIONS.set(criterion.dimension, [...(DIMENSIONS.get(criterion.dimension) ?? []), criterion]);

const ctxFor = (fixture: AllocateFixture): AllocateCtx => ({ fixture, topic: DRAFT_TOPICS[fixture.topic] });
const sampleName = (s: Pick<Sample, "contestant" | "fixture" | "epoch">) => `${s.contestant}-${s.fixture}-${s.epoch}`;
const usd = (amount: number) => `$${amount.toFixed(2)}`;

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

/** Writes `text` to `path` through `scrubSecrets`, creating the folder. */
function writeScrubbed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scrubSecrets(text));
}

const writeJson = (path: string, value: unknown) => writeScrubbed(path, JSON.stringify(value, null, 2) + "\n");

/** A calibration file as saved; a hand-edit that broke the JSON is an error naming the file. */
function readCalibrationFile(path: string): CalibrationFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CalibrationFile;
  } catch (error) {
    throw new Error(`Calibration file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The calibration files for this task in `dir`, and from them which judge criteria the owner has checked. A missing folder means none. */
function loadChecked(dir: string): Checked {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readCalibrationFile(join(dir, name)))
        .filter((file) => file.task === TASK)
    : [];
  return checkedCriteria(files, JUDGE.model, JUDGE_CRITERIA);
}

type JudgeFn = typeof judgeDimension;
type Checked = ReturnType<typeof checkedCriteria>;

/** Why judging stopped short: the spend cap was reached, or a judge call failed. */
type Stop = "cap" | "error" | null;

/**
 * Grades a rendered output on every judge dimension with `judge`, adding each call's cost to the cap. Returns the answers
 * it got, by dimension, and why it stopped short when it did: the cap was reached (checked before each call) or a call threw.
 */
async function judgeAll(
  rendered: string,
  model: RoleModel,
  deps: { judge: JudgeFn; cache: JudgeCache; cap: SpendCap; print: (line: string) => void },
): Promise<{ fresh: Map<string, CriterionResult[]>; stopped: Stop }> {
  const fresh = new Map<string, CriterionResult[]>();
  for (const [dimension, criteria] of DIMENSIONS) {
    if (deps.cap.reached) return { fresh, stopped: "cap" };
    try {
      const judged = await deps.judge({ rendered, dimension, criteria, judge: model, cache: deps.cache });
      deps.cap.add(judged.costUsd);
      fresh.set(dimension, judged.results);
    } catch (error) {
      deps.print(`${model.model} could not judge ${dimension}: ${error instanceof Error ? error.message : String(error)}`);
      return { fresh, stopped: "error" };
    }
  }
  return { fresh, stopped: null };
}

/**
 * Judges a completed sample and sets its results and `judged`. Code results are always recomputed. For each dimension a
 * new answer replaces the saved one; where none was obtained the saved results stay, so a short cap or cache never
 * destroys an earlier judgment. `judged` is true when every judge criterion has a result, old or new. The second judge
 * runs when `second` is set and the primary did not fail on an error (a cap stop is left to the second judge's own cap
 * check); its results replace the saved ones only when every dimension was answered.
 */
async function judgeSample(
  sample: Sample<AllocateOutput>,
  fixture: AllocateFixture,
  second: boolean,
  deps: { judge: JudgeFn; cache: JudgeCache; cap: SpendCap; print: (line: string) => void },
): Promise<void> {
  const rendered = renderAllocation(sample.output!, fixture.input);
  const saved = sample.results.filter((r) => r.grader === "judge");
  const primary = await judgeAll(rendered, JUDGE, deps);
  const judgeResults: CriterionResult[] = [];
  let complete = true;
  for (const [dimension, criteria] of DIMENSIONS) {
    const kept = criteria.flatMap((c) => saved.filter((r) => r.id === c.id).slice(0, 1));
    const results = primary.fresh.get(dimension) ?? kept;
    judgeResults.push(...results);
    if (results.length < criteria.length) complete = false;
  }
  sample.results = [...codeResults(sample.output!, ctxFor(fixture)), ...judgeResults];
  sample.judged = complete;
  if (second && primary.stopped !== "error") {
    const other = await judgeAll(rendered, SECOND_JUDGE, deps);
    if (other.fresh.size === DIMENSIONS.size) sample.secondJudge = [...other.fresh.values()].flat();
  }
}

/** Everything a finished or rescored round writes after its samples: scores, the report and the chart. */
function writeOutputs(
  dir: string,
  args: { samples: Sample[]; contestants: Contestant[]; fixtures: string[]; epochs: number; maxUsd: number; spentUsd: number; margin: number; commit: string; checked: Checked },
): ContestantSummary[] {
  const { samples, contestants, margin } = args;
  const summaries = summarize(samples, ALLOCATE_CRITERIA, contestants, margin);
  writeJson(join(dir, "scores.json"), { task: TASK, margin, summaries });
  writeScrubbed(
    join(dir, "report.md"),
    renderReport({
      task: TASK,
      summaries,
      samples,
      criteria: ALLOCATE_CRITERIA,
      checked: args.checked,
      run: { commit: args.commit, fixtures: args.fixtures, epochs: args.epochs, capUsd: args.maxUsd, spentUsd: args.spentUsd, judge: JUDGE, secondJudge: SECOND_JUDGE, margin },
    }),
  );
  writeScrubbed(join(dir, "chart.svg"), renderChart(summaries));
  return summaries;
}

/** The one line printed as a sample ends: `gpt-5.4-mini sde-1 #2: 0.72 · 14 s · $0.03`. */
function sampleLine(sample: Sample): string {
  const score = sampleScore(sample, ALLOCATE_CRITERIA);
  const what =
    sample.gate.status !== "completed" ? sample.gate.status : !sample.judged ? "unjudged" : score === null ? "n/a" : score.toFixed(2);
  return `${sample.contestant} ${sample.fixture} #${sample.epoch}: ${what} · ${Math.round(sample.ms / 1000)} s · ${usd(sample.costUsd)}`;
}

export interface RunOptions {
  task: "allocate";
  fixtures: string[];
  contestants: string[];
  epochs: number;
  maxUsd: number;
  margin: number;
  /** Where the run folder goes; `benchmarks/results` by default. */
  outDir?: string;
  /** The run's start as an ISO time, for the folder's name and `run.json`. */
  now?: string;
  runSample?: typeof runAllocateSample;
  judge?: JudgeFn;
  print?: (line: string) => void;
  /** The cost estimate; `estimateAllocateRun` by default. */
  estimate?: typeof estimateAllocateRun;
  cache?: JudgeCache;
  /** Samples in flight at once; 4 by default. */
  concurrency?: number;
  fixturesRoot?: string;
  calibrationDir?: string;
  /** The commit to record; `git rev-parse --short HEAD` by default. */
  commit?: string;
}

/**
 * Runs every contestant over every fixture for `epochs` epochs, judges and scores the samples, and writes the run folder.
 * Throws before any call when a contestant is unknown or the estimate is over the cap. Once the real spend passes the cap
 * no new sample starts and no more judge calls are made; samples never started are not saved, and finished ones left
 * unjudged are saved with `judged: false` for `--rescore`.
 */
export async function runBenchmark(opts: RunOptions): Promise<{ dir: string; summaries: ContestantSummary[] }> {
  const { epochs, maxUsd, margin } = opts;
  const print = opts.print ?? console.log;
  const runSample = opts.runSample ?? runAllocateSample;
  const judge = opts.judge ?? judgeDimension;
  const estimate = opts.estimate ?? estimateAllocateRun;
  const cache = opts.cache ?? fileJudgeCache();
  const fixturesRoot = opts.fixturesRoot ?? FIXTURES_ROOT;
  const calibrationDir = opts.calibrationDir ?? CALIBRATION_DIR;

  const contestants = contestantsFor(opts.contestants);
  const fixtures = opts.fixtures.map((id) => loadFixture(id, fixturesRoot));
  if (fixtures.length === 0) throw new Error("No fixtures to run on");
  // Read before any paid call, so a calibration file broken by hand fails the run now and not after the spend.
  const checked = loadChecked(calibrationDir);

  const renderedChars = fixtures.reduce((sum, f) => sum + renderMaterials(f.input.materials).length, 0) / fixtures.length;
  const estimated: Estimate = estimate({ fixtures, contestants, epochs, judgeDimensions: DIMENSIONS.size, renderedChars });
  const advice = cutAdvice(estimated, maxUsd, { epochs, fixtures: fixtures.length, contestants: contestants.length });
  if (advice) throw new Error(advice);
  print(`Estimate, contestants: ${usd(estimated.contestantsUsd)}`);
  print(`Estimate, judging: ${usd(estimated.judgingUsd)}; total ${usd(estimated.totalUsd)} of the ${usd(maxUsd)} cap`);

  const startedAt = opts.now ?? new Date().toISOString();
  const dir = join(opts.outDir ?? RESULTS_DIR, `${stamp(new Date(startedAt))}-${TASK}`);
  const commit = opts.commit ?? gitCommit();
  const cap = new SpendCap(maxUsd);
  let notStarted = 0;
  const runInfo = () => ({
    task: TASK,
    fixtures: opts.fixtures,
    contestants: contestants.map(({ name, roles }) => ({ name, roles })),
    epochs,
    maxUsd,
    margin,
    judge: JUDGE,
    secondJudge: SECOND_JUDGE,
    commit,
    estimate: estimated,
    spentUsd: cap.spentUsd,
    notStarted,
    startedAt,
  });
  writeJson(join(dir, "run.json"), runInfo());

  const planned = contestants.flatMap((contestant) =>
    fixtures.flatMap((fixture) => Array.from({ length: epochs }, (_, i) => ({ contestant, fixture, epoch: i + 1 }))),
  );
  // Chosen over the whole plan, before anything runs, so the same samples get the second opinion whatever the cap does.
  const second = secondJudgeSamples(planned.map((p) => ({ ...p, contestant: p.contestant.name, fixture: p.fixture.id })));
  const secondNames = new Set([...second].map(sampleName));

  /** One attempt: a throw is a void sample marked as ours, since the harness broke and that says nothing about the model. */
  const attempt = async (fixture: AllocateFixture, contestant: Contestant) => {
    try {
      return await runSample(fixture, contestant);
    } catch (error) {
      return { gate: { status: "void" as const, reason: `harness error: ${error instanceof Error ? error.message : String(error)}` }, output: null, calls: [], costUsd: 0, ms: 0 };
    }
  };

  const done = await mapLimit(planned, opts.concurrency ?? CONCURRENCY, async ({ contestant, fixture, epoch }): Promise<Sample<AllocateOutput> | null> => {
    if (cap.reached) return null;
    let ran = await attempt(fixture, contestant);
    cap.add(ran.costUsd);
    if (ran.gate.status === "void" && !cap.reached) {
      ran = await attempt(fixture, contestant);
      cap.add(ran.costUsd);
    }

    const sample: Sample<AllocateOutput> = { task: TASK, fixture: fixture.id, contestant: contestant.name, epoch, ...ran, results: [], judged: true };
    if (sample.gate.status === "completed" && sample.output) {
      await judgeSample(sample, fixture, secondNames.has(sampleName(sample)), { judge, cache, cap, print });
    }
    writeJson(join(dir, "samples", `${sampleName(sample)}.json`), sample);
    print(sampleLine(sample));
    return sample;
  });

  const samples = done.filter((s): s is Sample<AllocateOutput> => s !== null);
  notStarted = planned.length - samples.length;
  if (notStarted > 0) print(`${notStarted} of ${planned.length} samples not started: the spend cap was reached`);
  writeJson(join(dir, "run.json"), runInfo());
  const summaries = writeOutputs(dir, { samples, contestants, fixtures: opts.fixtures, epochs, maxUsd, spentUsd: cap.spentUsd, margin, commit, checked });
  print(`Spent ${usd(cap.spentUsd)} of the ${usd(maxUsd)} cap`);
  print(`Report: ${join(dir, "report.md")}`);
  return { dir, summaries };
}

/** What a saved run's `run.json` holds that a rescore or calibration reads. */
interface SavedRun {
  fixtures: string[];
  contestants: Contestant[];
  epochs: number;
  maxUsd: number;
  margin: number;
  commit: string;
  spentUsd: number;
}

function readSaved(dir: string): { run: SavedRun; samples: Sample<AllocateOutput>[] } {
  const runPath = join(dir, "run.json");
  if (!existsSync(runPath)) throw new Error(`${dir} has no run.json`);
  const run = JSON.parse(readFileSync(runPath, "utf8")) as SavedRun;
  const samplesDir = join(dir, "samples");
  const samples = existsSync(samplesDir)
    ? readdirSync(samplesDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(samplesDir, name), "utf8")) as Sample<AllocateOutput>)
    : [];
  // The run's own order: contestants, then fixtures, then epochs.
  const rank = (s: Sample) => [run.contestants.findIndex((c) => c.name === s.contestant), run.fixtures.indexOf(s.fixture), s.epoch];
  samples.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return { run, samples };
}

export interface RescoreDeps {
  judge?: JudgeFn;
  cache?: JudgeCache;
  /** The spend cap for this rescore; the run's own cap by default. */
  maxUsd?: number;
  print?: (line: string) => void;
  concurrency?: number;
  fixturesRoot?: string;
  calibrationDir?: string;
}

/**
 * Scores a saved round again with the current criteria. Code results are recomputed from each completed sample's saved
 * output; judge results are asked again through the cache, so only what the cache lacks is paid for, within a fresh cap.
 * Rewrites the samples, `scores.json`, `report.md` and `chart.svg`; no contestant is called.
 */
export async function rescoreBenchmark(dir: string, deps: RescoreDeps = {}): Promise<{ dir: string; summaries: ContestantSummary[] }> {
  const print = deps.print ?? console.log;
  const judge = deps.judge ?? judgeDimension;
  const cache = deps.cache ?? fileJudgeCache();
  const fixturesRoot = deps.fixturesRoot ?? FIXTURES_ROOT;
  const { run, samples } = readSaved(dir);
  const checked = loadChecked(deps.calibrationDir ?? CALIBRATION_DIR);
  const maxUsd = deps.maxUsd ?? run.maxUsd;
  const cap = new SpendCap(maxUsd);

  // The same second-opinion samples as the run chose, from its plan.
  const planned = run.contestants.flatMap((c) =>
    run.fixtures.flatMap((fixture) => Array.from({ length: run.epochs }, (_, i) => ({ contestant: c.name, fixture, epoch: i + 1 }))),
  );
  const secondNames = new Set([...secondJudgeSamples(planned)].map(sampleName));

  const fixtures = new Map<string, AllocateFixture>();
  for (const id of new Set(samples.map((s) => s.fixture))) fixtures.set(id, loadFixture(id, fixturesRoot));

  await mapLimit(samples, deps.concurrency ?? CONCURRENCY, async (sample) => {
    if (sample.gate.status !== "completed" || !sample.output) return;
    await judgeSample(sample, fixtures.get(sample.fixture)!, secondNames.has(sampleName(sample)), { judge, cache, cap, print });
    writeJson(join(dir, "samples", `${sampleName(sample)}.json`), sample);
  });

  const summaries = writeOutputs(dir, {
    samples,
    contestants: run.contestants,
    fixtures: run.fixtures,
    epochs: run.epochs,
    maxUsd: run.maxUsd,
    spentUsd: run.spentUsd + cap.spentUsd,
    margin: run.margin,
    commit: run.commit,
    checked,
  });
  print(`Rescored ${samples.length} samples; judging cost ${usd(cap.spentUsd)}`);
  print(`Report: ${join(dir, "report.md")}`);
  return { dir, summaries };
}

/** Picks samples of a saved round for the owner to grade and writes the calibration file; returns its path. */
export function calibrateBenchmark(dir: string, deps: { fixturesRoot?: string; calibrationDir?: string } = {}): string {
  const { samples } = readSaved(dir);
  const picked = pickCalibration(samples);
  const render = (s: Sample) => renderAllocation((s as Sample<AllocateOutput>).output!, loadFixture(s.fixture, deps.fixturesRoot ?? FIXTURES_ROOT).input);
  return writeCalibration(TASK, picked, render, JUDGE_CRITERIA, deps.calibrationDir ?? CALIBRATION_DIR);
}

/** Captures each run folder as a fixture, printing the new id or why it was refused and going on to the next. True when none was refused. */
export function captureFixtures(runDirs: string[], root: string = FIXTURES_ROOT, print: (line: string) => void = console.log): boolean {
  let allCaptured = true;
  for (const runDir of runDirs) {
    try {
      print(`${captureFixture(runDir, root).id} captured from ${runDir}`);
    } catch (error) {
      print(`${runDir} refused: ${error instanceof Error ? error.message : String(error)}`);
      allCaptured = false;
    }
  }
  return allCaptured;
}

/** A flag's value as a number the command accepts, or a message naming the flag. */
function numberFlag(name: string, value: string, ok: (n: number) => boolean, expected: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !ok(n)) throw new Error(`--${name} is ${expected}, not "${value}"`);
  return n;
}

const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      capture: { type: "boolean", default: false },
      task: { type: "string", default: TASK },
      fixtures: { type: "string" },
      contestants: { type: "string" },
      epochs: { type: "string", default: "3" },
      "max-usd": { type: "string" },
      margin: { type: "string", default: "0.05" },
      rescore: { type: "string" },
      calibrate: { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.capture) {
    if (positionals.length === 0) throw new Error("--capture needs one or more draft-eval run folders: --capture <dir> <dir>");
    if (!captureFixtures(positionals)) process.exitCode = 1;
    return;
  }

  if (values.rescore) {
    await rescoreBenchmark(values.rescore, { maxUsd: values["max-usd"] ? numberFlag("max-usd", values["max-usd"], (n) => n > 0, "a positive number") : undefined });
    return;
  }

  if (values.calibrate) {
    const path = calibrateBenchmark(values.calibrate);
    console.log(`Wrote ${path}`);
    console.log("Open it and set each grade's owner to true or false (does the criterion hold for that output?); leave null what you cannot tell.");
    return;
  }

  if (values.task !== TASK) throw new Error(`--task is "${TASK}", not "${values.task}"`);
  const fixtures = list(values.fixtures);
  if (fixtures.length === 0) throw new Error("Pass --fixtures <id,id,…>, ids from benchmarks/fixtures");
  await runBenchmark({
    task: TASK,
    fixtures,
    contestants: list(values.contestants),
    epochs: numberFlag("epochs", values.epochs, (n) => Number.isInteger(n) && n >= 1, "a whole number of 1 or more"),
    maxUsd: numberFlag("max-usd", values["max-usd"] ?? "10", (n) => n > 0, "a positive number"),
    margin: numberFlag("margin", values.margin, (n) => n >= 0, "0 or more"),
  });
}

// Run only as the command, so tests can import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
