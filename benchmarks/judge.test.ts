import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { generateObject } from "ai";
import { JUDGE, SECOND_JUDGE, fileJudgeCache, judgeDimension, judgeKey, secondJudgeSamples, type JudgeCache } from "./judge";
import type { CriterionResult, JudgeCriterion } from "./types";

function criterion(id: string, text = `${id} text`): JudgeCriterion {
  return { id, group: "quality", weight: 3, text, grader: "judge", dimension: "coverage" };
}
const CRITERIA = [criterion("a"), criterion("b")];

interface Verdict {
  id: string;
  met: boolean;
  reason: string;
}

/** A generate stand-in that answers with the verdicts and a fixed usage (1M tokens in, 100k out). */
function fakeGenerate(verdicts: Verdict[]) {
  return vi.fn(async (_options: Record<string, unknown>) => ({ object: { verdicts }, usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, finishReason: "stop" }));
}
const asGenerate = (fake: ReturnType<typeof fakeGenerate>) => fake as unknown as typeof generateObject;

function memoryCache(): JudgeCache {
  const store = new Map<string, CriterionResult[]>();
  return { get: (key) => store.get(key), set: (key, results) => void store.set(key, results) };
}

describe("judgeDimension", () => {
  const args = (generate: ReturnType<typeof fakeGenerate>, cache: JudgeCache = memoryCache()) => ({
    rendered: "THE OUTPUT",
    dimension: "coverage",
    criteria: CRITERIA,
    judge: JUDGE,
    cache,
    generate: asGenerate(generate),
  });

  it("returns one result per criterion of the dimension", async () => {
    const generate = fakeGenerate([
      { id: "a", met: true, reason: "It does." },
      { id: "b", met: false, reason: "It does not." },
    ]);
    const { results, costUsd, calls } = await judgeDimension(args(generate));
    expect(results).toEqual([
      { id: "a", met: true, evidence: "It does.", grader: "judge", judge: JUDGE.model },
      { id: "b", met: false, evidence: "It does not.", grader: "judge", judge: JUDGE.model },
    ]);
    expect(generate).toHaveBeenCalledTimes(1);
    // Opus 5.5: 1M in at $4 plus 100k out at $20.
    expect(costUsd).toBeCloseTo(6);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ caller: "judge", model: JUDGE.model, effort: JUDGE.effort, label: "Judge · coverage", costUsd: expect.closeTo(6) });
  });

  it("sends the output as a cached first part and the criteria, without weights, as the second", async () => {
    const generate = fakeGenerate([]);
    await judgeDimension(args(generate));
    const call = generate.mock.calls[0][0] as { model: string; providerOptions: unknown; messages: { role: string; content: { type: string; text: string; providerOptions?: unknown }[] }[] };
    expect(call.model).toBe(JUDGE.model);
    expect(call.providerOptions).toEqual({ anthropic: { effort: JUDGE.effort } });
    const [message] = call.messages;
    expect(message.role).toBe("user");
    const [first, second] = message.content;
    expect(first).toEqual({ type: "text", text: "THE OUTPUT", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } });
    expect(second.providerOptions).toBeUndefined();
    expect(second.text).toContain("a: a text");
    expect(second.text).toContain("b: b text");
    expect(second.text).not.toMatch(/weight/i);
    expect(second.text).not.toMatch(/\b3\b/);
  });

  it("sends the portable reasoning setting to a model that is not Anthropic's", async () => {
    const generate = fakeGenerate([]);
    await judgeDimension({ ...args(generate), judge: SECOND_JUDGE });
    expect(generate.mock.calls[0][0]).toMatchObject({ model: SECOND_JUDGE.model, reasoning: SECOND_JUDGE.effort });
  });

  it("ignores ids the judge invented", async () => {
    const generate = fakeGenerate([
      { id: "a", met: true, reason: "ok" },
      { id: "zzz", met: true, reason: "invented" },
      { id: "b", met: true, reason: "ok" },
    ]);
    const { results } = await judgeDimension(args(generate));
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps the first verdict of a repeated id", async () => {
    const generate = fakeGenerate([
      { id: "a", met: true, reason: "first" },
      { id: "a", met: false, reason: "second" },
      { id: "b", met: true, reason: "ok" },
    ]);
    const { results } = await judgeDimension(args(generate));
    expect(results[0]).toMatchObject({ id: "a", met: true, evidence: "first" });
  });

  it("marks a criterion the judge skipped as not met", async () => {
    const generate = fakeGenerate([{ id: "a", met: true, reason: "ok" }]);
    const { results } = await judgeDimension(args(generate));
    expect(results[1]).toEqual({ id: "b", met: false, evidence: "judge gave no verdict", grader: "judge", judge: JUDGE.model });
  });

  it("makes no call on a cache hit", async () => {
    const cache = memoryCache();
    const first = fakeGenerate([
      { id: "a", met: true, reason: "ok" },
      { id: "b", met: true, reason: "ok" },
    ]);
    const fresh = await judgeDimension(args(first, cache));
    const second = fakeGenerate([]);
    const hit = await judgeDimension(args(second, cache));
    expect(second).not.toHaveBeenCalled();
    expect(hit.results).toEqual(fresh.results);
    expect(hit.costUsd).toBe(0);
    expect(hit.calls).toEqual([]);
  });

  it("keys the cache on criterion text and judge", () => {
    const base = judgeKey("out", "coverage", CRITERIA, JUDGE);
    expect(judgeKey("out", "coverage", CRITERIA, JUDGE)).toBe(base);
    expect(judgeKey("out", "coverage", [criterion("a", "changed"), criterion("b")], JUDGE)).not.toBe(base);
    expect(judgeKey("out", "coverage", [criterion("a"), criterion("c", "b text")], JUDGE)).not.toBe(base);
    expect(judgeKey("out", "coverage", CRITERIA, SECOND_JUDGE)).not.toBe(base);
    expect(judgeKey("out", "coverage", CRITERIA, { ...JUDGE, effort: "low" })).not.toBe(base);
    expect(judgeKey("other", "coverage", CRITERIA, JUDGE)).not.toBe(base);
    expect(judgeKey("out", "fit", CRITERIA, JUDGE)).not.toBe(base);
  });
});

describe("fileJudgeCache", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "judge-cache-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const RESULTS: CriterionResult[] = [{ id: "a", met: true, evidence: "ok", grader: "judge", judge: JUDGE.model }];

  it("treats a missing file as an empty cache", () => {
    const cache = fileJudgeCache(join(dir, "none", "judge.jsonl"));
    expect(cache.get("k")).toBeUndefined();
  });

  it("appends a line per set, creating the folder, and a new cache reads them back", () => {
    const path = join(dir, "cache", "judge.jsonl");
    const cache = fileJudgeCache(path);
    cache.set("k1", RESULTS);
    cache.set("k2", []);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(cache.get("k1")).toEqual(RESULTS);
    const reread = fileJudgeCache(path);
    expect(reread.get("k1")).toEqual(RESULTS);
    expect(reread.get("k2")).toEqual([]);
    expect(reread.get("k3")).toBeUndefined();
  });

  it("reads the file lazily, not when the cache is made", () => {
    const path = join(dir, "judge.jsonl");
    const cache = fileJudgeCache(path);
    expect(existsSync(path)).toBe(false);
    fileJudgeCache(path).set("late", RESULTS);
    expect(cache.get("late")).toEqual(RESULTS);
  });

  it("keeps what the file already held when a set comes before any get", () => {
    const path = join(dir, "judge.jsonl");
    fileJudgeCache(path).set("old", RESULTS);
    const cache = fileJudgeCache(path);
    cache.set("new", []);
    expect(cache.get("old")).toEqual(RESULTS);
    expect(cache.get("new")).toEqual([]);
  });
});

describe("secondJudgeSamples", () => {
  const sample = (contestant: string, fixture: string, epoch: number) => ({ contestant, fixture, epoch });

  it("picks every fifth sample of each contestant, the first included", () => {
    const samples = ["baseline", "sonnet"].flatMap((contestant) => ["sde-1", "sde-2", "sde-3"].flatMap((fixture) => [1, 2, 3].map((epoch) => sample(contestant, fixture, epoch))));
    // Reversed, so the pick cannot lean on the input order.
    const picked = secondJudgeSamples([...samples].reverse());
    expect(picked.size).toBe(4);
    for (const contestant of ["baseline", "sonnet"]) {
      const own = [...picked].filter((s) => s.contestant === contestant).map((s) => `${s.fixture}-${s.epoch}`);
      // The 1st and 6th in (fixture, epoch) order.
      expect(own.sort()).toEqual(["sde-1-1", "sde-2-3"]);
    }
  });

  it("returns the input sample objects themselves", () => {
    const samples = [sample("a", "f1", 1), sample("a", "f1", 2)];
    const [picked] = [...secondJudgeSamples(samples)];
    expect(picked).toBe(samples[0]);
  });

  it("picks nothing from no samples", () => {
    expect(secondJudgeSamples([]).size).toBe(0);
  });
});
