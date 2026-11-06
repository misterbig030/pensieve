/**
 * Fixtures for the model benchmark: the exact input the allocation step received in a saved draft-eval run, frozen so
 * every contestant gets the same one. A fixture is one `allocate.json` under the fixtures root, named for its topic,
 * with an `outline-<call>.json` beside it for each outline call the run made (`tasks/outlineFixtures`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AllocationInput } from "@/lib/ai/allocate";
import { DEFAULT_HOURS_PER_WEEK } from "@/lib/planTree";
import { DRAFT_TOPICS } from "@/evals/draft/topics";
import { readRun, scrubSecrets } from "@/evals/draft/record";
import { captureOutline, outlineFixturePath, type OutlineFixture } from "./tasks/outlineFixtures";

export const FIXTURES_ROOT = "benchmarks/fixtures";

const FIXTURE_FILE = "allocate.json";
/** The label the app's allocation step logs its model call under. */
const ALLOCATE_LABEL = "Allocate";

export interface AllocateFixture {
  /** "<topic>-<n>", n the next free number for the topic under the fixtures root. */
  id: string;
  /** A DRAFT_TOPICS key. */
  topic: string;
  /** The basename of the eval folder the fixture was captured from. */
  sourceRun: string;
  commit: string;
  /** The request's fields and the materials research handed the allocation. */
  input: AllocationInput;
  /** The tokens and time of the run's allocation call; null when the allocation fell back and there was none. */
  baseline: { inputTokens: number; outputTokens: number; ms: number } | null;
}

/** The fixtures under the root, as saved. A folder without an `allocate.json` is not one. */
function savedFixtures(root: string): AllocateFixture[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, FIXTURE_FILE)))
    .map((entry) => JSON.parse(readFileSync(join(root, entry.name, FIXTURE_FILE), "utf8")) as AllocateFixture);
}

/** The next free number for the topic: one past the highest taken, so a number is never reused. */
function nextNumber(topic: string, taken: AllocateFixture[]): number {
  const prefix = `${topic}-`;
  const numbers = taken
    .filter((fixture) => fixture.id.startsWith(prefix))
    .map((fixture) => Number(fixture.id.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
  return Math.max(0, ...numbers) + 1;
}

/**
 * Freezes the allocation input of a saved draft-eval run as the next fixture for its topic under `root`, with each of
 * the run's outline calls beside it. Throws, naming the folder (or the outline call) and writing nothing, when the
 * folder was already captured, has no request, research did not finish with materials, or an outline call cannot be
 * rebuilt as it was recorded.
 */
export async function captureFixture(runDir: string, root: string = FIXTURES_ROOT): Promise<AllocateFixture & { outline: OutlineFixture[]; skipped: string[] }> {
  const sourceRun = basename(runDir);
  const record = readRun(runDir);
  const { meta } = record;

  const existing = savedFixtures(root);
  if (existing.some((fixture) => fixture.sourceRun === sourceRun)) throw new Error(`Run folder ${runDir} is already captured as a fixture`);

  const request = meta.request ?? DRAFT_TOPICS[meta.topic]?.request;
  if (!request) throw new Error(`Run folder ${runDir} has no request, and topic "${meta.topic}" has none to fall back on`);

  const done = record.events.find((event) => event.type === "research.done");
  if (!done || done.type !== "research.done") throw new Error(`Run folder ${runDir} has no research.done event`);
  if (done.materials.length === 0) throw new Error(`Run folder ${runDir} has no materials: research found nothing to allocate`);

  const allocate = record.calls.find((call) => call.label === ALLOCATE_LABEL);
  const fixture: AllocateFixture = {
    id: `${meta.topic}-${nextNumber(meta.topic, existing)}`,
    topic: meta.topic,
    sourceRun,
    commit: meta.commit,
    input: {
      topic: request.topic,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      weeks: request.weeks,
      daysPerWeek: request.daysPerWeek,
      hoursPerWeek: request.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
      materials: done.materials,
    },
    baseline: allocate ? { inputTokens: allocate.inputTokens ?? 0, outputTokens: allocate.outputTokens ?? 0, ms: allocate.latencyMs } : null,
  };

  // Every outline call is rebuilt and checked against its recording before anything is written.
  const { fixtures: outline, skipped } = await captureOutline(runDir, fixture.id);

  const dir = join(root, fixture.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FIXTURE_FILE), scrubSecrets(JSON.stringify(fixture, null, 2)));
  for (const call of outline) writeFileSync(outlineFixturePath(call.id, root), scrubSecrets(JSON.stringify(call, null, 2)));
  return { ...fixture, outline, skipped };
}

/** Reads a fixture back by id. Throws an `Error` naming the id when there is none. */
export function loadFixture(id: string, root: string = FIXTURES_ROOT): AllocateFixture {
  const path = join(root, id, FIXTURE_FILE);
  if (!existsSync(path)) throw new Error(`No fixture "${id}" under ${root}`);
  return JSON.parse(readFileSync(path, "utf8")) as AllocateFixture;
}
