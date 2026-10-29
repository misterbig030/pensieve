/**
 * The draft eval: runs the app's researched draft for a known topic and checks the plan against the criteria in
 * `checks.ts`. The draft is the route's own path (`researchedDraftInput`), so a run costs what a user's draft costs.
 *
 *   npx tsx evals/draft/run.ts --topic sde                   three runs, one at a time, on the app's gateway key
 *   npx tsx evals/draft/run.ts --topic sde --runs 1          one run
 *   npx tsx evals/draft/run.ts --topic sde --parallel 2      two runs at once
 *   npx tsx evals/draft/run.ts --topic sde --key user        on the stored key of EVAL_USER_ID
 *   npx tsx evals/draft/run.ts --rescore <dir> <dir>         re-check saved folders; no calls, no cost
 *
 * Env (.env.local): AI_GATEWAY_API_KEY, TAVILY_API_KEY; EVAL_USER_ID and DATABASE_URL with --key user.
 * Output: evals/results/draft-<timestamp>-<topic>-<n>/ per run, and draft-<timestamp>-<topic>-summary.md per round.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import "./env";
import { withCallEvents } from "@/lib/ai/callEvents";
import { researchedDraftInput } from "@/lib/ai/draftRequest";
import { DRAFT_BUDGET_MS, streamResearchedPlanDraft } from "@/lib/ai/planDraft";
import type { GenerationLogContext } from "@/lib/ai/logged";
import type { PlanDraftEvent } from "@/lib/planChat";
import { resolveWith, type ResolvedModels } from "@/lib/ai/resolve";
import { checkRun } from "./checks";
import { captureRun, readRun, scrubSecrets, writeRun, type RunMeta, type RunRecord } from "./record";
import type { CallEvent } from "@/lib/ai/callEvents";
import type { ServiceEvent } from "@/lib/ai/serviceEvents";
import { renderRunReport, renderSummary, type SummaryRow } from "./report";
import { DRAFT_TOPICS, type DraftTopic } from "./topics";

type CheckResult = ReturnType<typeof checkRun>;

const RESULTS_DIR = path.join("evals", "results");

/** The round's shared stamp, safe in a file name: `2026-10-29T10-00-00-000Z`. */
export function stamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** One line as a run ends: `run 1: pass 5/6 · 212 s · $1.31`; `fail` when any applicable verdict fails. */
export function runLine(run: number, result: CheckResult, meta: Pick<RunMeta, "ms" | "costUsd">): string {
  const applicable = result.verdicts.filter((v) => v.status !== "n/a");
  const passes = applicable.filter((v) => v.status === "pass").length;
  return `run ${run}: ${result.passed ? "pass" : "fail"} ${passes}/${applicable.length} · ${Math.round(meta.ms / 1000)} s · $${meta.costUsd.toFixed(2)}`;
}

/** `fn` over `items` with at most `limit` in flight; results in the order of `items`. `fn` must not throw. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Writes `report.md` and adds the check result to `run.json` beside its meta. `secrets` are scrubbed too. */
export function writeScored(dir: string, record: RunRecord, result: CheckResult, secrets: string[] = []): void {
  const runPath = path.join(dir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;
  writeFileSync(runPath, scrubSecrets(JSON.stringify({ ...run, result }, null, 2), process.env, secrets));
  writeFileSync(path.join(dir, "report.md"), scrubSecrets(renderRunReport(record, result), process.env, secrets));
}

/** Reads a saved folder, checks it against its topic, and rewrites its report. Throws when the folder cannot be scored. */
function scoreFolder(dir: string): { record: RunRecord; result: CheckResult } {
  const record = readRun(dir);
  const topic = DRAFT_TOPICS[record.meta.topic];
  if (!topic) throw new Error(`Run folder ${dir} is for an unknown topic "${record.meta.topic}"`);
  const result = checkRun(record, topic);
  writeScored(dir, record, result);
  return { record, result };
}

/** Re-checks saved folders with the current checks. Writes each folder's report and a summary next to the first folder. */
export async function rescore(
  dirs: string[],
  options: { now?: string; print?: (line: string) => void } = {},
): Promise<{ summaryPath: string; rows: SummaryRow[] }> {
  const print = options.print ?? console.log;
  const rows: SummaryRow[] = dirs.map((dir) => {
    try {
      const { record, result } = scoreFolder(dir);
      print(runLine(record.meta.run, result, record.meta));
      return { dir, result, meta: record.meta };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      print(`${path.basename(dir)}: could not be scored: ${message}`);
      return { dir, result: null, error: message };
    }
  });
  const summaryPath = path.join(path.dirname(dirs[0]), `draft-${options.now ?? stamp()}-rescore-summary.md`);
  writeFileSync(summaryPath, scrubSecrets(renderSummary(rows)));
  return { summaryPath, rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Running

type KeyRoute = "app" | "user";

interface EvalModels {
  models: ResolvedModels;
  userId?: string;
  /** The user's decrypted keys, so they can be scrubbed from every saved file. */
  secrets?: string[];
}

async function resolveEvalModels(key: KeyRoute): Promise<EvalModels> {
  if (key === "app") return { models: { ...resolveWith({}), keyErrors: {} } };
  const userId = process.env.EVAL_USER_ID;
  if (!userId) throw new Error("--key user needs EVAL_USER_ID in .env.local: the id of the user whose stored key the run should use.");
  // Only this route touches the database; the default route never loads it.
  const [{ resolveModels }, { getUserApiKeys }, { openSecret }] = await Promise.all([import("@/lib/ai/resolve"), import("@/lib/db/userApiKeys"), import("@/lib/secrets")]);
  const rows = await getUserApiKeys(userId);
  return { models: await resolveModels(userId), userId, secrets: rows.map((row) => openSecret(row.ciphertext, row.secretVersion)) };
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** What one run's draft needs; the default draft streams the route's own path. */
export interface DraftArgs {
  request: DraftTopic["request"];
  models: ResolvedModels;
  deadline: number;
  log: GenerationLogContext;
  key: KeyRoute;
  userId?: string;
}

export type DraftStream = (args: DraftArgs) => AsyncIterable<PlanDraftEvent | CallEvent | ServiceEvent>;

/** The route's nesting: on the user's key, the guard sits around the draft inside the call-event wrapper. */
async function* routeDraft({ request, models, deadline, log, key, userId }: DraftArgs): AsyncGenerator<PlanDraftEvent> {
  const draft = streamResearchedPlanDraft(researchedDraftInput({ request, models, deadline, log }));
  if (key !== "user" || !userId) {
    yield* draft;
    return;
  }
  const { guardUserKey } = await import("@/lib/ai/userKeyError");
  yield* guardUserKey(draft, { userId, models, record: async () => {}, clear: async () => {} });
}

export interface RoundOptions {
  topic: string;
  runs: number;
  parallel: number;
  key: KeyRoute;
  outDir?: string;
  now?: string;
  print?: (line: string) => void;
  /** Tests inject these; the command uses the defaults. */
  draft?: DraftStream;
  resolve?: (key: KeyRoute) => Promise<EvalModels>;
}

/** Runs a round of one topic, writing a folder and a report per run and a summary for the round. */
export async function runRound(options: RoundOptions): Promise<{ summaryPath: string; rows: SummaryRow[] }> {
  const print = options.print ?? console.log;
  const draft = options.draft ?? routeDraft;
  const topic = DRAFT_TOPICS[options.topic];
  if (!topic) throw new Error(`Unknown topic "${options.topic}"; use ${Object.keys(DRAFT_TOPICS).join(", ")}`);
  const { models, userId, secrets = [] } = await (options.resolve ?? resolveEvalModels)(options.key);
  const outDir = options.outDir ?? RESULTS_DIR;
  const ts = options.now ?? stamp();
  const commit = gitCommit();
  mkdirSync(outDir, { recursive: true });

  const numbers = Array.from({ length: options.runs }, (_, i) => i + 1);
  const rows = await mapLimit(numbers, options.parallel, async (run): Promise<SummaryRow> => {
    const dir = path.join(outDir, `draft-${ts}-${options.topic}-${run}`);
    try {
      // The log has no `onLog`: nothing is written to the database. `withCallEvents` supplies `onCall` and `onService`.
      const log = { keyOwner: models.research.keyOwner, ...(userId ? { userId } : {}) };
      const deadline = Date.now() + DRAFT_BUDGET_MS;
      const stream = withCallEvents(true, log, (l) => draft({ request: topic.request, models, deadline, log: l, key: options.key, userId }));
      const record = await captureRun(stream, {
        topic: options.topic,
        run,
        startedAt: new Date().toISOString(),
        commit,
        key: options.key,
        models: { research: models.research.id, outline: models.outline.id, allocate: models.allocate.id },
      });
      writeRun(dir, record, undefined, secrets);
      const result = checkRun(record, topic);
      writeScored(dir, record, result, secrets);
      print(runLine(run, result, record.meta));
      return { dir, result, meta: record.meta };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      print(`run ${run}: could not be scored: ${message}`);
      return { dir, result: null, error: message };
    }
  });
  const summaryPath = path.join(outDir, `draft-${ts}-${options.topic}-summary.md`);
  writeFileSync(summaryPath, scrubSecrets(renderSummary(rows), process.env, secrets));
  return { summaryPath, rows };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      topic: { type: "string" },
      runs: { type: "string", default: "3" },
      parallel: { type: "string", default: "1" },
      key: { type: "string", default: "app" },
      rescore: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.rescore) {
    if (positionals.length === 0) throw new Error("--rescore needs one or more run folders: --rescore <dir> <dir>");
    const { summaryPath } = await rescore(positionals);
    console.log(`\nWrote ${summaryPath}`);
    return;
  }

  if (!values.topic) throw new Error(`Pass --topic <id>; topics: ${Object.keys(DRAFT_TOPICS).join(", ")}`);
  if (values.key !== "app" && values.key !== "user") throw new Error(`--key is app or user, not "${values.key}"`);
  const parallel = Number(values.parallel);
  if (parallel !== 1 && parallel !== 2) throw new Error("--parallel is 1 or 2");
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs is a whole number of 1 or more");

  const { summaryPath } = await runRound({ topic: values.topic, runs, parallel, key: values.key });
  console.log(`\nWrote ${summaryPath}`);
}

// Run only as the command, so tests can import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
