/**
 * The saved record of one draft run: the whole event stream with timestamps, the model calls, what research found and
 * the allocation kept, the split and the plan. The checks and the reports read only this, so a folder can be rescored
 * later without running anything.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallEvent } from "@/lib/ai/callEvents";
import type { DraftRequestBody } from "@/lib/ai/draftRequest";
import type { ModelCall } from "@/lib/ai/logged";
import type { Coverage, DroppedMaterial, ResearchEvent } from "@/lib/ai/research/events";
import type { ServiceEvent } from "@/lib/ai/serviceEvents";
import type { PlanDraftEvent } from "@/lib/planChat";
import type { PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import type { PlanSplit } from "@/lib/studyTime";

export type TimedEvent = (PlanDraftEvent | CallEvent | ServiceEvent | { type: "error"; message: string }) & {
  /** Milliseconds since the run started. */
  t: number;
};

export interface RunMeta {
  topic: string;
  run: number;
  startedAt: string;
  commit: string;
  key: "app" | "user";
  models: Record<string, string>;
  /** The reasoning effort each role ran at, as the app sets it. Absent in folders saved before it was recorded. */
  effort?: Record<string, string>;
  /** The request the run drafted, so a rescore judges it by its own inputs. Absent in older folders: the topic's is used. */
  request?: DraftRequestBody;
  ms: number;
  costUsd: number;
  costByStage: Record<string, number>;
}

export interface RunRecord {
  meta: RunMeta;
  events: TimedEvent[];
  calls: ModelCall[];
  materials: {
    verified: Extract<ResearchEvent, { type: "research.verified" }>[];
    allocated: Material[] | null;
    dropped: DroppedMaterial[];
    coverage: Coverage | null;
  };
  split: PlanSplit | null;
  plan: PlanNode | null;
}

/** What the caller knows before the run; capture computes the rest. */
export type CaptureMeta = Omit<RunMeta, "ms" | "costUsd" | "costByStage">;

/** The stage a model call's cost belongs to: research's structure finders share one, other research another, the rest take the label's first part. */
function stageOf(label: string): string {
  if (label.startsWith("Research · structure") || label.startsWith("Research · items")) return "structure";
  if (label.startsWith("Research")) return "research";
  return label.split(" · ")[0];
}

/**
 * Consumes a draft stream into a record. A stream that throws ends the record with an `error` event instead of
 * rethrowing, so a failed run is still saved and scored.
 */
export async function captureRun(stream: AsyncIterable<PlanDraftEvent | CallEvent | ServiceEvent>, meta: CaptureMeta): Promise<RunRecord> {
  const startedAt = performance.now();
  const startedEpoch = Date.now();
  const events: TimedEvent[] = [];
  const calls: ModelCall[] = [];
  const materials: RunRecord["materials"] = { verified: [], allocated: null, dropped: [], coverage: null };
  let split: PlanSplit | null = null;
  let plan: PlanNode | null = null;
  let finishCost: number | null = null;
  // An event stamped when it happened (`at`, a service event queued until the next event) is timed by that stamp.
  const push = (event: PlanDraftEvent | CallEvent | ServiceEvent | { type: "error"; message: string }) => {
    const { at, ...rest } = event as typeof event & { at?: number };
    const t = typeof at === "number" ? Math.max(0, at - startedEpoch) : performance.now() - startedAt;
    events.push({ ...rest, t: Math.round(t) } as TimedEvent);
  };

  try {
    for await (const event of stream) {
      push(event);
      switch (event.type) {
        case "call":
          calls.push(event.call);
          break;
        case "research.verified":
          materials.verified.push(event);
          break;
        case "allocated":
          materials.allocated = event.materials;
          materials.dropped = event.dropped;
          materials.coverage = event.coverage;
          break;
        case "split":
          split = event.split;
          break;
        case "finish":
          plan = event.root;
          finishCost = event.costUsd;
          break;
      }
    }
  } catch (error) {
    push({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  const costByStage: Record<string, number> = {};
  for (const call of calls) {
    const stage = stageOf(call.label);
    costByStage[stage] = (costByStage[stage] ?? 0) + call.costUsd;
  }
  const costUsd = calls.length > 0 ? calls.reduce((sum, call) => sum + call.costUsd, 0) : (finishCost ?? 0);
  return { meta: { ...meta, ms: Math.round(performance.now() - startedAt), costUsd, costByStage }, events, calls, materials, split, plan };
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets

const SECRET_NAMES = ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "TAVILY_API_KEY", "OPEN_LIBRARY_CONTACT", "DATABASE_URL", "VERCEL_OIDC_TOKEN"];
const MIN_SECRET_LENGTH = 8;

/**
 * Replaces the values of the keys, the contact, the database address and the Vercel token with `[redacted]`, as written and as JSON would escape them, and
 * likewise any `extra` values (a user's decrypted key, which no environment variable holds). Values under 8
 * characters are left alone: replacing something that short would mangle the text everywhere.
 */
export function scrubSecrets(text: string, env: Record<string, string | undefined> = process.env, extra: string[] = []): string {
  let scrubbed = text;
  const values = [...SECRET_NAMES.map((name) => env[name]), ...extra];
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) scrubbed = scrubbed.split(form).join("[redacted]");
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------------------------------------------
// The run folder

const FILES = ["run.json", "events.ndjson", "calls.json", "materials.json", "plan.json"] as const;

/** Writes the record as five files. Every file passes through `scrubSecrets` (with `extraSecrets` too). `run.json` is an object so scoring can add keys (verdicts) later. */
export function writeRun(dir: string, record: RunRecord, env?: Record<string, string | undefined>, extraSecrets: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  const files: Record<(typeof FILES)[number], string> = {
    "run.json": JSON.stringify({ meta: record.meta }, null, 2),
    "events.ndjson": record.events.map((event) => JSON.stringify(event)).join("\n") + (record.events.length > 0 ? "\n" : ""),
    "calls.json": JSON.stringify(record.calls, null, 2),
    "materials.json": JSON.stringify(record.materials, null, 2),
    "plan.json": JSON.stringify({ split: record.split, plan: record.plan }, null, 2),
  };
  for (const name of FILES) writeFileSync(join(dir, name), scrubSecrets(files[name], env, extraSecrets));
}

function readFile(dir: string, name: (typeof FILES)[number]): string {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`Run folder ${dir} is missing ${name}`);
  return readFileSync(path, "utf8");
}

function parse<T>(dir: string, name: (typeof FILES)[number], text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Run folder ${dir} has an unreadable ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads a run folder back. Throws an `Error` naming the first file that is missing or unreadable. */
export function readRun(dir: string): RunRecord {
  const run = parse<{ meta: RunMeta }>(dir, "run.json", readFile(dir, "run.json"));
  const events = readFile(dir, "events.ndjson")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parse<TimedEvent>(dir, "events.ndjson", line));
  const calls = parse<ModelCall[]>(dir, "calls.json", readFile(dir, "calls.json"));
  const materials = parse<RunRecord["materials"]>(dir, "materials.json", readFile(dir, "materials.json"));
  const plan = parse<{ split: PlanSplit | null; plan: PlanNode | null }>(dir, "plan.json", readFile(dir, "plan.json"));
  return { meta: run.meta, events, calls, materials, split: plan.split, plan: plan.plan };
}
