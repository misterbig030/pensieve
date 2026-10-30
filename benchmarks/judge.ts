/**
 * The judge: grades the quality criteria of one rubric dimension per call, with the rendered output as a cached prefix
 * shared by a sample's calls. Answers are kept in a file keyed by what went in, so re-scoring never pays twice.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateObject } from "ai";
import { z } from "zod";
import { buildGenerationLogRow, effortSettings, type ModelCall } from "@/lib/ai/logged";
import type { CriterionResult, JudgeCriterion, RoleModel, Sample } from "./types";

/** The one judge a benchmark version uses, and the second opinion from another provider on a fifth of the samples. */
export const JUDGE: RoleModel = { model: "anthropic/claude-opus-5.5", effort: "high" };
export const SECOND_JUDGE: RoleModel = { model: "openai/gpt-5.4", effort: "high" };

/** Where judgments are kept between runs: one JSON line per judged dimension. */
const CACHE_FILE = "benchmarks/cache/judge.jsonl";

/** Judgments by key; a miss is `undefined`. */
export interface JudgeCache {
  get(key: string): CriterionResult[] | undefined;
  set(key: string, results: CriterionResult[]): void;
}

/**
 * A cache in a JSON-lines file. It reads the file on the first `get` or `set` (a missing file is an empty cache) and
 * appends a line for each `set`, creating the folder as needed; a later line for a key wins.
 */
export function fileJudgeCache(path: string = CACHE_FILE): JudgeCache {
  let entries: Map<string, CriterionResult[]> | null = null;
  const load = () => {
    if (entries) return entries;
    entries = new Map();
    if (!existsSync(path)) return entries;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { key, results } = JSON.parse(line) as { key: string; results: CriterionResult[] };
      entries.set(key, results);
    }
    return entries;
  };
  return {
    get: (key) => load().get(key),
    set: (key, results) => {
      load().set(key, results);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ key, results })}\n`);
    },
  };
}

/** The cache key: a hash of the rendered output, the dimension, each criterion's id and text, and the judge's model and effort. */
export function judgeKey(rendered: string, dimension: string, criteria: JudgeCriterion[], judge: RoleModel): string {
  const parts = [rendered, dimension, criteria.map((c) => ({ id: c.id, text: c.text })), judge.model, judge.effort];
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
  return [
    "You are grading the allocation of a study plan, shown above: how the learner's time is split and which materials were kept.",
    "Judge each criterion on its own, from the allocation alone, and say why in one sentence.",
    'A criterion that describes a harm (something the plan should not do) is "met" when the harm is present.',
    "Answer for every id given, once each.",
    "",
    "Criteria:",
    ...criteria.map((c) => `- ${c.id}: ${c.text}`),
  ].join("\n");
}

/**
 * Grades one dimension's criteria in a single call. A cache hit makes no call and costs nothing. An id the judge made up
 * is ignored, a repeated id keeps its first verdict, and a criterion it skipped is not met.
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
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  const verdicts = new Map<string, { met: boolean; reason: string }>();
  for (const v of object.verdicts) if (!verdicts.has(v.id)) verdicts.set(v.id, v);
  const results = criteria.map((c): CriterionResult => {
    const v = verdicts.get(c.id);
    return { id: c.id, met: v?.met ?? false, evidence: v ? v.reason : "judge gave no verdict", grader: "judge", judge: judge.model };
  });
  cache.set(key, results);

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
