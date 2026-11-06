/**
 * The model benchmark command: runs contestants over frozen fixtures, judges and scores the results, and writes a report.
 *
 *   npx tsx benchmarks/run.ts --capture evals/results/draft-<ts>-sde-1 [<dir> …]   freeze a draft-eval run as a fixture
 *   npx tsx benchmarks/run.ts --task allocate --fixtures sde-1,sde-2,sde-3 --contestants gemini-3-flash,gpt-5.4-mini
 *   npx tsx benchmarks/run.ts --task allocate ... --epochs 5 --max-usd 20 --margin 0.05
 *   npx tsx benchmarks/run.ts --task outline --groups leaves --fixtures csapp-1/top,csapp-1/week-1 --contestants gpt-5.4-mini
 *   npx tsx benchmarks/run.ts --rescore benchmarks/results/<ts>-allocate      no contestant calls; judges only what changed
 *   npx tsx benchmarks/run.ts --calibrate benchmarks/results/<ts>-allocate    pick samples for the owner to grade
 *
 * Rescore and calibrate take the task from the run's `run.json` (allocate when it names none). A task with groups
 * (outline: top, inner, leaves) gets one report section and chart per group, then which contestant each group could route to.
 *
 * Always on the app's gateway key (AI_GATEWAY_API_KEY in .env.local); never reads or writes the database.
 */
import "../evals/draft/env";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scrubSecrets } from "@/evals/draft/record";
import { mapLimit, stamp } from "@/evals/draft/run";
import { cutAdvice, estimateRun, SpendCap, type Estimate } from "./budget";
import { CALIBRATION_DIR, checkedCriteria, pickCalibration, writeCalibration, type CalibrationFile } from "./calibration";
import { contestantsFor } from "./contestants";
import { captureFixture, FIXTURES_ROOT } from "./fixtures";
import { fileJudgeCache, JUDGE, judgeDimension, SECOND_JUDGE, secondJudgeSamples, type JudgeCache } from "./judge";
import { renderChart, renderReport, renderRouting, sampleName, summarize, type ContestantSummary } from "./report";
import { sampleScore, type ScoredCriterion } from "./score";
import { TASKS, type BenchTask, type TaskName } from "./task";
import type { CallGroup } from "./tasks/outlineFixtures";
import type { Contestant, CriterionResult, JudgeCriterion, RoleModel, Sample } from "./types";

const RESULTS_DIR = "benchmarks/results";
/** The task a command runs when it names none, and a saved run's when its `run.json` names none. */
const DEFAULT_TASK: TaskName = "allocate";
const CALL_GROUPS: CallGroup[] = ["top", "inner", "leaves"];
/** Samples in flight at once. */
const CONCURRENCY = 4;

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/** The task named `name` (the default when there is none); an unknown name is an error listing the known ones. */
function taskNamed(name: string | undefined): TaskName {
  const task = name ?? DEFAULT_TASK;
  if (!Object.hasOwn(TASKS, task)) throw new Error(`Unknown task "${task}"; known: ${Object.keys(TASKS).join(", ")}`);
  return task as TaskName;
}

/**
 * Calls `fn` with the named task, keeping its fixture, output and context types together. The task is looked up by name,
 * so one added to `TASKS` needs nothing here; `fn` is generic over every task, so the one cast loses nothing it reads.
 */
function withTask<R>(name: TaskName, fn: <F extends { id: string }, O, C>(task: BenchTask<F, O, C>) => R): R {
  return fn(TASKS[name] as BenchTask<{ id: string }, unknown, unknown>);
}

/** Every judge criterion the task has. */
const judgeCriteriaOf = <F extends { id: string }, O, C>(task: BenchTask<F, O, C>) => task.criteria.filter((c): c is JudgeCriterion => c.grader === "judge");

/** The criteria grouped by the rubric dimension one judge call grades, in the order first seen. */
function byDimension(criteria: JudgeCriterion[]): Map<string, JudgeCriterion[]> {
  const dimensions = new Map<string, JudgeCriterion[]>();
  for (const criterion of criteria) dimensions.set(criterion.dimension, [...(dimensions.get(criterion.dimension) ?? []), criterion]);
  return dimensions;
}

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
function loadChecked<F extends { id: string }, O, C>(task: BenchTask<F, O, C>, dir: string): Checked {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readCalibrationFile(join(dir, name)))
        .filter((file) => file.task === task.name)
    : [];
  return checkedCriteria(files, JUDGE.model, judgeCriteriaOf(task));
}

/** Reads the judge cache now, so a problem with it shows before any paid call, and says how many stored lines were unreadable. */
function loadCache(cache: JudgeCache, print: (line: string) => void): void {
  const skipped = cache.load?.().skippedLines ?? 0;
  if (skipped > 0) print(`Judge cache: skipped ${skipped} unreadable line${skipped === 1 ? "" : "s"}; those answers will be asked again`);
}

type JudgeFn = typeof judgeDimension;
type Checked = ReturnType<typeof checkedCriteria>;

/** Why judging stopped short: the spend cap was reached, or a judge call failed. */
type Stop = "cap" | "error" | null;

/**
 * Grades a rendered output on each of `dimensions` with `judge`, the dimensions at once, adding each call's cost to the
 * cap. The cap is checked once, before the calls, so a pass can overshoot it by its own calls. Returns the answers it got,
 * by dimension, and why it stopped short when it did: the cap was already reached, or a call threw (the others still count).
 */
async function judgeAll(
  rendered: string,
  instructions: string,
  model: RoleModel,
  dimensions: Map<string, JudgeCriterion[]>,
  deps: { judge: JudgeFn; cache: JudgeCache; cap: SpendCap; print: (line: string) => void },
): Promise<{ fresh: Map<string, CriterionResult[]>; stopped: Stop }> {
  const fresh = new Map<string, CriterionResult[]>();
  if (deps.cap.reached) return { fresh, stopped: "cap" };
  let stopped: Stop = null;
  await Promise.all(
    [...dimensions].map(async ([dimension, criteria]) => {
      try {
        const judged = await deps.judge({ rendered, dimension, criteria, judge: model, cache: deps.cache, instructions });
        deps.cap.add(judged.costUsd);
        fresh.set(dimension, judged.results);
      } catch (error) {
        deps.print(`${model.model} could not judge ${dimension}: ${error instanceof Error ? error.message : String(error)}`);
        stopped = "error";
      }
    }),
  );
  return { fresh, stopped };
}

/**
 * Judges a completed sample and sets its results and `judged`. Code results are always recomputed. The judge criteria
 * are the ones the task says apply to this output, one judge call per dimension. Each criterion takes the new answer
 * when there is one and keeps its saved result otherwise, so a short cap, a failed call or a skipped criterion never
 * destroys an earlier judgment. `judged` is true when every applicable judge criterion has a result, old or new. The
 * second judge runs when `second` is set and the primary did not fail on an error (a cap stop is left to the second
 * judge's own cap check); its results replace the saved ones only when it answered every applicable criterion.
 */
async function judgeSample<F extends { id: string }, O, C>(
  task: BenchTask<F, O, C>,
  sample: Sample<O>,
  fixture: F,
  second: boolean,
  deps: { judge: JudgeFn; cache: JudgeCache; cap: SpendCap; print: (line: string) => void },
): Promise<void> {
  const output = sample.output!;
  const ctx = task.ctxFor(fixture);
  const applicable = task.judgeCriteria(output, ctx);
  const dimensions = byDimension(applicable);
  const rendered = task.render(output, fixture);
  const saved = sample.results.filter((r) => r.grader === "judge");
  const primary = await judgeAll(rendered, task.judgeInstructions, JUDGE, dimensions, deps);
  const fresh = [...primary.fresh.values()].flat();
  const judgeResults = applicable.flatMap((c) => [fresh.find((r) => r.id === c.id) ?? saved.find((r) => r.id === c.id)].filter((r) => r !== undefined));
  sample.results = [...task.codeResults(output, ctx), ...judgeResults];
  sample.judged = judgeResults.length === applicable.length;
  if (second && primary.stopped !== "error") {
    const other = [...(await judgeAll(rendered, task.judgeInstructions, SECOND_JUDGE, dimensions, deps)).fresh.values()].flat();
    if (applicable.every((c) => other.some((r) => r.id === c.id))) sample.secondJudge = other;
  }
}

interface OutputArgs {
  samples: Sample[];
  contestants: Contestant[];
  fixtures: string[];
  epochs: number;
  maxUsd: number;
  spentUsd: number;
  margin: number;
  commit: string;
  checked: Checked;
  /** Each fixture's group, for a task with groups; null for one without. */
  groupOf: Map<string, string> | null;
}

/** The report's run facts: the commit, the fixtures, the epochs, the spend, the judges and the margin. */
const reportRun = (args: OutputArgs, fixtures: string[]) => ({
  commit: args.commit,
  fixtures,
  epochs: args.epochs,
  capUsd: args.maxUsd,
  spentUsd: args.spentUsd,
  judge: JUDGE,
  secondJudge: SECOND_JUDGE,
  margin: args.margin,
});

/**
 * Everything a finished or rescored round writes after its samples: scores, the report and the chart. A task with groups
 * gets them per group: `scores.json` by group, a header stating the run's spend once, a report section (with no spend of
 * its own) and a `chart-<group>.svg` for each group in the order its fixtures were named, then the routing. Returns the summaries over all the samples, and per group when there are groups.
 */
function writeOutputs<F extends { id: string }, O, C>(
  dir: string,
  task: BenchTask<F, O, C>,
  args: OutputArgs,
): { summaries: ContestantSummary[]; groups?: Record<string, ContestantSummary[]> } {
  const { samples, contestants, margin, checked } = args;
  const summaries = summarize(samples, task.criteria, contestants, margin);
  if (!args.groupOf) {
    writeJson(join(dir, "scores.json"), { task: task.name, margin, summaries });
    writeScrubbed(join(dir, "report.md"), renderReport({ task: task.name, summaries, samples, criteria: task.criteria, checked, run: reportRun(args, args.fixtures) }));
    writeScrubbed(join(dir, "chart.svg"), renderChart(summaries));
    return { summaries };
  }

  const groupOf = args.groupOf;
  const groups: Record<string, ContestantSummary[]> = {};
  const sections: string[] = [];
  for (const group of new Set(args.fixtures.map((id) => groupOf.get(id)!))) {
    const own = samples.filter((s) => groupOf.get(s.fixture) === group);
    groups[group] = summarize(own, task.criteria, contestants, margin);
    const chart = `chart-${group}.svg`;
    // The spend is the run's, stated once above the sections, not a group's own.
    const report = renderReport({
      task: `${task.name}, ${group}`,
      summaries: groups[group],
      samples: own,
      criteria: task.criteria,
      checked,
      chart,
      spend: false,
      run: reportRun(args, args.fixtures.filter((id) => groupOf.get(id) === group)),
    });
    // The group's report, its title dropped (the group heading stands for it) and its headings two levels down.
    sections.push(`## Group: ${group}`, "", report.replace(/^# .*\n\n/, "").replace(/^(#+) /gm, "##$1 "));
    writeScrubbed(join(dir, chart), renderChart(groups[group]));
  }
  writeJson(join(dir, "scores.json"), { task: task.name, margin, groups });
  const header = [`# Model benchmark: ${task.name}`, "", `- Spend: ${usd(args.spentUsd)} of the ${usd(args.maxUsd)} cap`, ""];
  writeScrubbed(join(dir, "report.md"), [...header, ...sections, renderRouting(groups)].join("\n"));
  return { summaries, groups };
}

/** The one line printed as a sample ends: `gpt-5.4-mini sde-1 #2: 0.72 · 14 s · $0.03`. */
function sampleLine(sample: Sample, criteria: ScoredCriterion[]): string {
  const score = sampleScore(sample, criteria);
  const what =
    sample.gate.status !== "completed" ? sample.gate.status : !sample.judged ? "unjudged" : score === null ? "n/a" : score.toFixed(2);
  return `${sample.contestant} ${sample.fixture} #${sample.epoch}: ${what} · ${Math.round(sample.ms / 1000)} s · ${usd(sample.costUsd)}`;
}

type SampleRun<O> = Pick<Sample<O>, "gate" | "output" | "calls" | "costUsd" | "estimatedCostUsd" | "ms">;

export interface RunOptions {
  task: TaskName;
  fixtures: string[];
  /** Only the fixtures of these call groups; outline only. */
  groups?: CallGroup[];
  contestants: string[];
  epochs: number;
  maxUsd: number;
  margin: number;
  /** Where the run folder goes; `benchmarks/results` by default. */
  outDir?: string;
  /** The run's start as an ISO time, for the folder's name and `run.json`. */
  now?: string;
  /** Runs one sample; the task's own by default. Takes the task's fixture. */
  runSample?: (fixture: never, contestant: Contestant) => Promise<SampleRun<unknown>>;
  judge?: JudgeFn;
  print?: (line: string) => void;
  /** The cost estimate; `estimateRun` by default. */
  estimate?: typeof estimateRun;
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
 * Throws before any call when a contestant is unknown, `groups` is given to a task without groups, no fixture is left
 * to run, the judge cache cannot be read or the estimate is over the cap. Once the real spend passes the cap
 * no new sample starts and no more judge calls are made; samples never started are not saved, and finished ones left
 * unjudged are saved with `judged: false` for `--rescore`.
 */
export async function runBenchmark(
  opts: RunOptions,
): Promise<{ dir: string; summaries: ContestantSummary[]; groups?: Record<string, ContestantSummary[]> }> {
  return withTask(taskNamed(opts.task), (task) => runTask(task, opts));
}

async function runTask<F extends { id: string }, O, C>(
  task: BenchTask<F, O, C>,
  opts: RunOptions,
): Promise<{ dir: string; summaries: ContestantSummary[]; groups?: Record<string, ContestantSummary[]> }> {
  const { epochs, maxUsd, margin } = opts;
  const groupOf = task.groupOf?.bind(task);
  if (opts.groups && !groupOf) throw new Error(`--groups applies only to --task outline, not --task ${task.name}`);
  const print = opts.print ?? console.log;
  const runSample = (opts.runSample as BenchTask<F, O, C>["runSample"] | undefined) ?? task.runSample;
  const judge = opts.judge ?? judgeDimension;
  const estimate = opts.estimate ?? estimateRun;
  const cache = opts.cache ?? fileJudgeCache();
  const fixturesRoot = opts.fixturesRoot ?? FIXTURES_ROOT;
  const calibrationDir = opts.calibrationDir ?? CALIBRATION_DIR;

  const contestants = contestantsFor(opts.contestants);
  const named = opts.fixtures.map((id) => task.loadFixture(id, fixturesRoot));
  const groups: string[] | undefined = opts.groups;
  const fixtures = groups && groupOf ? named.filter((f) => groups.includes(groupOf(f))) : named;
  if (fixtures.length === 0) throw new Error(groups ? `No fixtures to run on in --groups ${groups.join(",")}` : "No fixtures to run on");
  const fixtureIds = groups ? fixtures.map((f) => f.id) : opts.fixtures;
  // Read before any paid call, so a calibration file broken by hand fails the run now and not after the spend.
  const checked = loadChecked(task, calibrationDir);
  loadCache(cache, print);

  const renderedChars = fixtures.reduce((sum, f) => sum + task.judgeViewChars(f), 0) / fixtures.length;
  const estimated: Estimate = estimate({
    baselines: fixtures.map((f) => task.baseline(f)),
    role: task.role,
    contestants,
    epochs,
    judgeDimensions: task.judgeDimensions,
    renderedChars,
  });
  const advice = cutAdvice(estimated, maxUsd, { epochs, fixtures: fixtures.length, contestants: contestants.length });
  if (advice) throw new Error(advice);
  print(`Estimate, contestants: ${usd(estimated.contestantsUsd)}`);
  print(`Estimate, judging: ${usd(estimated.judgingUsd)}; total ${usd(estimated.totalUsd)} of the ${usd(maxUsd)} cap`);

  const startedAt = opts.now ?? new Date().toISOString();
  const dir = join(opts.outDir ?? RESULTS_DIR, `${stamp(new Date(startedAt))}-${task.name}`);
  const commit = opts.commit ?? gitCommit();
  const cap = new SpendCap(maxUsd);
  let notStarted = 0;
  const runInfo = () => ({
    task: task.name,
    fixtures: fixtureIds,
    ...(groups ? { groups } : {}),
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
  const attempt = async (fixture: F, contestant: Contestant): Promise<SampleRun<O>> => {
    try {
      return await runSample(fixture, contestant);
    } catch (error) {
      return { gate: { status: "void" as const, reason: `harness error: ${error instanceof Error ? error.message : String(error)}` }, output: null, calls: [], costUsd: 0, ms: 0 };
    }
  };

  // Set once a sample's gate says halt (the gateway refuses the key, is out of funds, or does not know a contestant's
  // model): every later call would meet the same refusal, or the run's config needs fixing, so nothing more starts.
  let halted: string | null = null;
  const done = await mapLimit(planned, opts.concurrency ?? CONCURRENCY, async ({ contestant, fixture, epoch }): Promise<Sample<O> | null> => {
    if (cap.reached || halted !== null) return null;
    let ran = await attempt(fixture, contestant);
    cap.add(ran.costUsd);
    if (ran.gate.status === "void" && ran.gate.halt) halted = ran.gate.reason;
    else if (ran.gate.status === "void" && !cap.reached) {
      const first = ran;
      ran = await attempt(fixture, contestant);
      cap.add(ran.costUsd);
      // The sample is the final attempt, but it was paid for twice: keep the first attempt's calls and cost with it.
      const estimatedCostUsd = (first.estimatedCostUsd ?? 0) + (ran.estimatedCostUsd ?? 0);
      ran = { ...ran, calls: [...first.calls, ...ran.calls], costUsd: first.costUsd + ran.costUsd, ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}) };
    }

    const sample: Sample<O> = { task: task.name, fixture: fixture.id, contestant: contestant.name, epoch, ...ran, results: [], judged: true };
    if (sample.gate.status === "completed" && sample.output) {
      await judgeSample(task, sample, fixture, secondNames.has(sampleName(sample)), { judge, cache, cap, print });
    }
    writeJson(join(dir, "samples", `${sampleName(sample)}.json`), sample);
    print(sampleLine(sample, task.criteria));
    return sample;
  });

  const samples = done.filter((s): s is Sample<O> => s !== null);
  notStarted = planned.length - samples.length;
  if (notStarted > 0) print(`${notStarted} of ${planned.length} samples not started: ${halted ?? "the spend cap was reached"}`);
  const withEstimate = samples.filter((s) => s.estimatedCostUsd !== undefined).length;
  if (withEstimate > 0) print(`${withEstimate} of ${samples.length} samples carry an estimated cost: the call ended without usage`);
  writeJson(join(dir, "run.json"), runInfo());
  const written = writeOutputs(dir, task, {
    samples,
    contestants,
    fixtures: fixtureIds,
    epochs,
    maxUsd,
    spentUsd: cap.spentUsd,
    margin,
    commit,
    checked,
    groupOf: groupOf ? new Map(fixtures.map((f) => [f.id, groupOf(f)])) : null,
  });
  print(`Spent ${usd(cap.spentUsd)} of the ${usd(maxUsd)} cap`);
  print(`Report: ${join(dir, "report.md")}`);
  return { dir, ...written };
}

/** What a saved run's `run.json` holds that a rescore or calibration reads. */
interface SavedRun {
  /** Absent in runs saved before there was more than one task: those are allocate. */
  task?: string;
  fixtures: string[];
  contestants: Contestant[];
  epochs: number;
  maxUsd: number;
  margin: number;
  commit: string;
  spentUsd: number;
}

/** A saved run and its samples, in the run's own order. The samples' output is the run's task's. */
function readSaved(dir: string): { run: SavedRun; samples: Sample[] } {
  const runPath = join(dir, "run.json");
  if (!existsSync(runPath)) throw new Error(`${dir} has no run.json`);
  const run = JSON.parse(readFileSync(runPath, "utf8")) as SavedRun;
  const samplesDir = join(dir, "samples");
  const samples = existsSync(samplesDir)
    ? readdirSync(samplesDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(samplesDir, name), "utf8")) as Sample)
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
 * Rewrites the samples, `scores.json`, `report.md` and the charts, and adds the judging spend to `run.json`'s; no
 * contestant is called. The task is the one `run.json` names, allocate when it names none.
 */
export async function rescoreBenchmark(
  dir: string,
  deps: RescoreDeps = {},
): Promise<{ dir: string; summaries: ContestantSummary[]; groups?: Record<string, ContestantSummary[]> }> {
  const saved = readSaved(dir);
  return withTask(taskNamed(saved.run.task), (task) => rescoreTask(task, dir, saved.run, saved.samples as Sample<never>[], deps));
}

async function rescoreTask<F extends { id: string }, O, C>(
  task: BenchTask<F, O, C>,
  dir: string,
  run: SavedRun,
  samples: Sample<O>[],
  deps: RescoreDeps,
): Promise<{ dir: string; summaries: ContestantSummary[]; groups?: Record<string, ContestantSummary[]> }> {
  const print = deps.print ?? console.log;
  const judge = deps.judge ?? judgeDimension;
  const cache = deps.cache ?? fileJudgeCache();
  const fixturesRoot = deps.fixturesRoot ?? FIXTURES_ROOT;
  const checked = loadChecked(task, deps.calibrationDir ?? CALIBRATION_DIR);
  loadCache(cache, print);
  const maxUsd = deps.maxUsd ?? run.maxUsd;
  const cap = new SpendCap(maxUsd);

  // The same second-opinion samples as the run chose, from its plan.
  const planned = run.contestants.flatMap((c) =>
    run.fixtures.flatMap((fixture) => Array.from({ length: run.epochs }, (_, i) => ({ contestant: c.name, fixture, epoch: i + 1 }))),
  );
  const secondNames = new Set([...secondJudgeSamples(planned)].map(sampleName));

  // The samples' fixtures, and with groups every fixture the run named, since each one's group heads a report section.
  const groupOf = task.groupOf?.bind(task);
  const fixtures = new Map<string, F>();
  for (const id of new Set([...(groupOf ? run.fixtures : []), ...samples.map((s) => s.fixture)])) fixtures.set(id, task.loadFixture(id, fixturesRoot));

  await mapLimit(samples, deps.concurrency ?? CONCURRENCY, async (sample) => {
    if (sample.gate.status !== "completed" || !sample.output) return;
    await judgeSample(task, sample, fixtures.get(sample.fixture)!, secondNames.has(sampleName(sample)), { judge, cache, cap, print });
    writeJson(join(dir, "samples", `${sampleName(sample)}.json`), sample);
  });

  // The round's total spend goes back into run.json, so a second rescore starts from it and no judging is lost.
  const spentUsd = run.spentUsd + cap.spentUsd;
  writeJson(join(dir, "run.json"), { ...run, spentUsd });

  const written = writeOutputs(dir, task, {
    samples,
    contestants: run.contestants,
    fixtures: run.fixtures,
    epochs: run.epochs,
    maxUsd: run.maxUsd,
    spentUsd,
    margin: run.margin,
    commit: run.commit,
    checked,
    groupOf: groupOf ? new Map([...fixtures].map(([id, f]) => [id, groupOf(f)])) : null,
  });
  print(`Rescored ${samples.length} samples; judging cost ${usd(cap.spentUsd)}`);
  print(`Report: ${join(dir, "report.md")}`);
  return { dir, ...written };
}

/**
 * Picks samples of a saved round for the owner to grade and writes the calibration file; returns its path. The task is
 * the one `run.json` names, allocate when it names none.
 */
export function calibrateBenchmark(dir: string, deps: { fixturesRoot?: string; calibrationDir?: string } = {}): string {
  const { run, samples } = readSaved(dir);
  const picked = pickCalibration(samples);
  return withTask(taskNamed(run.task), (task) => {
    const render = (s: Sample) => task.render((s as Sample<never>).output!, task.loadFixture(s.fixture, deps.fixturesRoot ?? FIXTURES_ROOT));
    return writeCalibration(task.name, picked, render, judgeCriteriaOf(task), deps.calibrationDir ?? CALIBRATION_DIR);
  });
}

/** Captures each run folder as a fixture, printing the new id or why it was refused and going on to the next. True when none was refused. */
export async function captureFixtures(runDirs: string[], root: string = FIXTURES_ROOT, print: (line: string) => void = console.log): Promise<boolean> {
  let allCaptured = true;
  for (const runDir of runDirs) {
    try {
      const fixture = await captureFixture(runDir, root);
      const skipped = fixture.skipped.length > 0 ? `; skipped: ${fixture.skipped.join(", ")}` : "";
      print(`${fixture.id} captured from ${runDir} (+${fixture.outline.length} outline${skipped})`);
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
      task: { type: "string", default: DEFAULT_TASK },
      groups: { type: "string" },
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
    if (!(await captureFixtures(positionals))) process.exitCode = 1;
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

  if (!Object.hasOwn(TASKS, values.task)) throw new Error(`--task is one of ${Object.keys(TASKS).join(", ")}, not "${values.task}"`);
  const task = values.task as TaskName;
  let groups: CallGroup[] | undefined;
  if (values.groups !== undefined) {
    if (task !== "outline") throw new Error(`--groups applies only to --task outline, not --task ${task}`);
    groups = list(values.groups).map((group) => {
      if (!CALL_GROUPS.includes(group as CallGroup)) throw new Error(`--groups takes ${CALL_GROUPS.join(", ")}, not "${group}"`);
      return group as CallGroup;
    });
    if (groups.length === 0) throw new Error(`--groups takes one or more of ${CALL_GROUPS.join(", ")}`);
  }
  const fixtures = list(values.fixtures);
  if (fixtures.length === 0) {
    throw new Error(`Pass --fixtures <id,id,…>, ids from benchmarks/fixtures${task === "outline" ? ` ("csapp-1/top", "csapp-1/week-1")` : ""}`);
  }
  await runBenchmark({
    task,
    ...(groups ? { groups } : {}),
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
