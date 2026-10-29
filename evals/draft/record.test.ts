import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelCall } from "@/lib/ai/logged";
import type { Material } from "@/lib/schemas/material";
import type { PlanDraftEvent } from "@/lib/planChat";
import { makeNode, makeRoot } from "@/lib/planTree";
import type { PlanSplit } from "@/lib/studyTime";
import { DRAFT_TOPICS } from "./topics";
import { captureRun, readRun, scrubSecrets, writeRun } from "./record";

const META = { topic: "sde", run: 1, startedAt: "2026-10-29T10:00:00.000Z", commit: "abc1234", key: "app" as const, models: { outline: "anthropic/claude-sonnet-5.5" } };

function call(label: string, costUsd: number, prompt = "p"): ModelCall {
  return { caller: "outline", model: "anthropic/claude-sonnet-5.5", effort: null, keyOwner: "app", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, reasoningTokens: null, costUsd, latencyMs: 5, trackId: null, userId: null, label, system: null, prompt, response: "r", finishReason: "stop", facts: [] };
}

function material(id: string, title: string): Material {
  return { id, origin: "research", type: "link", kind: "docs", url: "https://x", title, author: null, year: null, why: null, backbone: false, verifiedAt: null, fetchedTitle: null, recommendedBy: [], sig: null } as Material;
}

async function* from(events: unknown[], thenThrow?: Error): AsyncGenerator<PlanDraftEvent> {
  for (const event of events) yield event as PlanDraftEvent;
  if (thenThrow) throw thenThrow;
}

const week = makeNode({ id: "w1", level: "week", title: "Week 1", summary: "", len: 1 });
const finished = makeRoot([week]);
const root = finished;
const split = { reading: 50, practice: 50 } as unknown as PlanSplit;
const verified = { type: "research.verified", id: "M1", title: "DDIA", kind: "book", backbone: true };
const allocated = [material("M1", "DDIA")];
const dropped = [{ title: "Old", reason: "stale", stage: "plan" as const }];
const coverage = { covered: ["design"], open: [] };

function fullStream(): unknown[] {
  return [
    { type: "research.start", caps: { searches: 1, fetches: 1, steps: 1 } },
    verified,
    { type: "call", call: call("Research · structure · DDIA", 0.5) },
    { type: "service", name: "search", ok: false, final: true, ms: 3 },
    { type: "call", call: call("Research", 0.25) },
    { type: "allocated", materials: allocated, dropped, coverage },
    { type: "split", split },
    { type: "call", call: call("Top level · 8 weeks", 0.125) },
    { type: "node", parentId: root.id, node: week },
    { type: "call", call: call("Week 1", 0.0625) },
    { type: "finish", root: finished, costUsd: 99 },
  ];
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-record-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("topics", () => {
  it("states the SDE inputs", () => {
    expect(DRAFT_TOPICS.sde.request).toEqual({ topic: "Senior software engineer interview preparation", weeks: 8, daysPerWeek: 5, hoursPerWeek: 6, granularity: "day", materials: [] });
  });
});

describe("captureRun", () => {
  it("captures a stream into a record, materials and plan included", async () => {
    const record = await captureRun(from(fullStream()), META);
    expect(record.meta).toMatchObject({ ...META, costUsd: 0.9375 });
    expect(record.meta.ms).toBeGreaterThanOrEqual(0);
    expect(record.meta.costByStage).toEqual({ structure: 0.5, research: 0.25, "Top level": 0.125, "Week 1": 0.0625 });
    expect(record.events).toHaveLength(11);
    expect(record.events.map((e) => e.type).slice(0, 3)).toEqual(["research.start", "research.verified", "call"]);
    expect(record.events.every((e) => typeof e.t === "number" && e.t >= 0)).toBe(true);
    expect(record.calls.map((c) => c.label)).toEqual(["Research · structure · DDIA", "Research", "Top level · 8 weeks", "Week 1"]);
    expect(record.materials).toEqual({ verified: [verified], allocated, dropped, coverage });
    expect(record.split).toEqual(split);
    expect(record.plan).toEqual(finished);
  });

  it("takes the cost from the finish event when no call was captured", async () => {
    const record = await captureRun(from([{ type: "finish", root: finished, costUsd: 1.5 }]), META);
    expect(record.meta.costUsd).toBe(1.5);
    expect(record.meta.costByStage).toEqual({});
  });

  it("records a stream that throws as an error event and returns", async () => {
    const record = await captureRun(from([{ type: "research.start", caps: { searches: 1, fetches: 1, steps: 1 } }], new Error("boom")), META);
    expect(record.events.map((e) => e.type)).toEqual(["research.start", "error"]);
    expect(record.events[1]).toMatchObject({ type: "error", message: "boom" });
    expect(record.plan).toBeNull();
    expect(record.split).toBeNull();
    expect(record.materials).toEqual({ verified: [], allocated: null, dropped: [], coverage: null });
  });
});

describe("writeRun and readRun", () => {
  it("writes and reads a run folder back unchanged", async () => {
    const record = await captureRun(from(fullStream()), META);
    writeRun(dir, record);
    expect(readdirSync(dir).sort()).toEqual(["calls.json", "events.ndjson", "materials.json", "plan.json", "run.json"]);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toEqual({ meta: record.meta });
    expect(readRun(dir)).toEqual(record);
  });

  it("round-trips a record that never finished", async () => {
    const record = await captureRun(from([], new Error("early")), META);
    writeRun(dir, record);
    expect(readRun(dir)).toEqual(record);
  });

  it("never writes a key or the contact", async () => {
    const env = { AI_GATEWAY_API_KEY: "gw-secret-key-123", ANTHROPIC_API_KEY: "sk-ant-secret-456", TAVILY_API_KEY: "tvly-secret-789", OPEN_LIBRARY_CONTACT: "me+ol@example.com" };
    const events = [{ type: "call", call: call("Research", 0.1, `contact ${env.OPEN_LIBRARY_CONTACT} key ${env.ANTHROPIC_API_KEY}`) }];
    const record = await captureRun(from(events, new Error(`401 for ${env.AI_GATEWAY_API_KEY} and "${env.TAVILY_API_KEY}"`)), META);
    writeRun(dir, record, env);
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const value of Object.values(env)) expect(text, file).not.toContain(value);
    }
    expect(readFileSync(join(dir, "events.ndjson"), "utf8")).toContain("[redacted]");
  });

  it("names the missing file when a folder is incomplete", async () => {
    const record = await captureRun(from(fullStream()), META);
    writeRun(dir, record);
    rmSync(join(dir, "materials.json"));
    expect(() => readRun(dir)).toThrow(/materials\.json/);
  });
});

describe("scrubSecrets", () => {
  it("scrubs extra values such as a user's key, and still skips short ones", () => {
    expect(scrubSecrets("k=sk-user-abcdef12 s=short", {}, ["sk-user-abcdef12", "short"])).toBe("k=[redacted] s=short");
  });

  it("replaces every occurrence of a value", () => {
    expect(scrubSecrets("a K-1234567890 b K-1234567890", { TAVILY_API_KEY: "K-1234567890" })).toBe("a [redacted] b [redacted]");
  });
  it("leaves empty, short and unset values alone", () => {
    expect(scrubSecrets("abc 1234567 abc", { AI_GATEWAY_API_KEY: "", ANTHROPIC_API_KEY: "1234567", TAVILY_API_KEY: undefined })).toBe("abc 1234567 abc");
  });
  it("catches a value in its JSON-escaped form", () => {
    const value = 'we"ird\\key-12345';
    expect(scrubSecrets(JSON.stringify({ m: value }), { OPEN_LIBRARY_CONTACT: value })).toBe('{"m":"[redacted]"}');
  });
});
