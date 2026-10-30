/**
 * The judge: grades the quality criteria of one rubric dimension per call, with the rendered output as a cached prefix
 * shared by a sample's calls. Answers are kept in a file keyed by what went in, so re-scoring never pays twice.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateObject } from "ai";
import { z } from "zod";
import { scrubSecrets } from "@/evals/draft/record";
import { buildGenerationLogRow, effortSettings, type ModelCall } from "@/lib/ai/logged";
import type { CriterionResult, JudgeCriterion, RoleModel, Sample } from "./types";

/** The one judge a benchmark version uses, and the second opinion from another provider on a fifth of the samples. */
export const JUDGE: RoleModel = { model: "anthropic/claude-opus-5.5", effort: "high" };
export const SECOND_JUDGE: RoleModel = { model: "openai/gpt-5.4", effort: "high" };

/** Where judgments are kept between runs: one JSON line per judged dimension. */
const CACHE_FILE = "benchmarks/cache/judge.jsonl";

/** How long one judge call may take before it is aborted, so a hung call cannot stall the run. */
export const JUDGE_TIMEOUT_MS = 120_000;

/** Judgments by key; a miss is `undefined`. */
export interface JudgeCache {
  get(key: string): CriterionResult[] | undefined;
  set(key: string, results: CriterionResult[]): void;
  /** Reads what is kept now instead of on first use, and says how many stored lines could not be read. Optional: a cache in memory has nothing to read. */
  load?(): { skippedLines: number };
}

/** A stored line as `{ key, results }`, or null when it is not one. */
function parseLine(line: string): { key: string; results: CriterionResult[] } | null {
  try {
    const entry = JSON.parse(line) as { key?: unknown; results?: unknown } | null;
    return typeof entry?.key === "string" && Array.isArray(entry.results) ? { key: entry.key, results: entry.results as CriterionResult[] } : null;
  } catch {
    return null;
  }
}

/**
 * A cache in a JSON-lines file. It reads the file on the first `get`, `set` or `load` (a missing file is an empty cache)
 * and appends a line for each `set` (through `scrubSecrets`), creating the folder as needed; a later line for a key wins.
 * A line that cannot be read (a write cut short, a hand-edit) is skipped and counted, not fatal; `load` reports the count.
 */
export function fileJudgeCache(path: string = CACHE_FILE): JudgeCache & { load(): { skippedLines: number } } {
  let entries: Map<string, CriterionResult[]> | null = null;
  let skippedLines = 0;
  let endsMidLine = false;
  const read = () => {
    if (entries) return entries;
    entries = new Map();
    if (!existsSync(path)) return entries;
    const text = readFileSync(path, "utf8");
    endsMidLine = text.length > 0 && !text.endsWith("\n");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (entry) entries.set(entry.key, entry.results);
      else skippedLines++;
    }
    return entries;
  };
  return {
    get: (key) => read().get(key),
    set: (key, results) => {
      read().set(key, results);
      mkdirSync(dirname(path), { recursive: true });
      // A last line cut short has no newline; without one the new entry would join it and be lost with it.
      appendFileSync(path, scrubSecrets(`${endsMidLine ? "\n" : ""}${JSON.stringify({ key, results })}\n`));
      endsMidLine = false;
    },
    load: () => {
      read();
      return { skippedLines };
    },
  };
}

/** The fixed instructions the judge is sent after the rendered output; the cache key hashes them, so editing them reuses no old answer. */
export const JUDGE_INSTRUCTIONS = [
  "You are grading the allocation of a study plan, shown above: how the learner's time is split and which materials were kept.",
  "Judge each criterion on its own, from the allocation alone, and say why in one sentence.",
  'A criterion that describes a harm (something the plan should not do) is "met" when the harm is present.',
  "Answer for every id given, once each.",
].join("\n");

/**
 * The cache key: a hash of the rendered output, the dimension, each criterion's id and text, the judge's model and
 * effort, and the instructions the judge is sent.
 */
export function judgeKey(
  rendered: string,
  dimension: string,
  criteria: JudgeCriterion[],
  judge: RoleModel,
  instructions: string = JUDGE_INSTRUCTIONS,
): string {
  const parts = [rendered, dimension, criteria.map((c) => ({ id: c.id, text: c.text })), judge.model, judge.effort, instructions];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string().describe("The id of a criterion, exactly as given"),
      met: z.boolean().describe("Whether the criterion is met"),
      reason: z.string().describe("One sentence saying why"),
    }),
  ),
});

/** The instructions and criteria that follow the rendered output. Weights are never shown to the judge. */
function criteriaPrompt(criteria: JudgeCriterion[]): string {
  return [JUDGE_INSTRUCTIONS, "", "Criteria:", ...criteria.map((c) => `- ${c.id}: ${c.text}`)].join("\n");
}

/**
 * Grades one dimension's criteria in a single call, aborted after `JUDGE_TIMEOUT_MS` (the abort is an error the caller
 * handles; nothing is cached). A cache hit makes no call and costs nothing. An id the judge made up is ignored, a
 * repeated id keeps its first verdict, and a criterion it skipped is not met; such an answer is returned but not cached.
 */
export async function judgeDimension(args: {
  rendered: string;
  dimension: string;
  criteria: JudgeCriterion[];
  judge: RoleModel;
  cache: JudgeCache;
  generate?: typeof generateObject;
}): Promise<{ results: CriterionResult[]; costUsd: number; calls: ModelCall[] }> {
  const { rendered, dimension, criteria, judge, cache } = args;
  const key = judgeKey(rendered, dimension, criteria, judge);
  const cached = cache.get(key);
  if (cached) return { results: cached, costUsd: 0, calls: [] };

  const generate = args.generate ?? generateObject;
  const instructions = criteriaPrompt(criteria);
  const startedAt = performance.now();
  const { object, usage, finishReason } = await generate({
    model: judge.model,
    schema: verdictsSchema,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: rendered, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
          { type: "text", text: instructions },
        ],
      },
    ],
    ...effortSettings(judge.effort, judge.model),
    abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  const verdicts = new Map<string, { met: boolean; reason: string }>();
  for (const v of object.verdicts) if (!verdicts.has(v.id)) verdicts.set(v.id, v);
  const results = criteria.map((c): CriterionResult => {
    const v = verdicts.get(c.id);
    return { id: c.id, met: v?.met ?? false, evidence: v ? v.reason : "judge gave no verdict", grader: "judge", judge: judge.model };
  });
  // An answer with a skipped criterion is not kept, so a rescore asks again instead of reusing the gap.
  if (criteria.every((c) => verdicts.has(c.id))) cache.set(key, results);

  const row = buildGenerationLogRow({ caller: "judge", model: judge.model, usage, latencyMs, effort: judge.effort });
  const call: ModelCall = {
    ...row,
    label: `Judge · ${dimension}`,
    system: null,
    prompt: `${rendered}\n\n${instructions}`,
    response: JSON.stringify(object, null, 2),
    finishReason: finishReason ?? null,
    facts: [],
  };
  return { results, costUsd: row.costUsd, calls: [call] };
}

/** Every fifth sample of each contestant in (fixture, epoch) order, the first included: the ones the second judge re-grades. */
export function secondJudgeSamples<T extends Pick<Sample, "contestant" | "fixture" | "epoch">>(samples: T[]): Set<T> {
  const byContestant = new Map<string, T[]>();
  for (const sample of samples) byContestant.set(sample.contestant, [...(byContestant.get(sample.contestant) ?? []), sample]);
  const picked = new Set<T>();
  for (const own of byContestant.values()) {
    own.sort((a, b) => a.fixture.localeCompare(b.fixture, undefined, { numeric: true }) || a.epoch - b.epoch);
    own.forEach((sample, i) => {
      if (i % 5 === 0) picked.add(sample);
    });
  }
  return picked;
}
