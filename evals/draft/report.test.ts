import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeNode, makeRoot } from "@/lib/planTree";
import type { checkRun } from "./checks";
import { renderRunReport, renderSummary } from "./report";
import { mapLimit, rescore, runLine } from "./run";
import { writeRun, type RunRecord } from "./record";

type Result = ReturnType<typeof checkRun>;

const NAMES = ["Backbone", "Named list", "Reservations", "Services", "Practice time", "Week one"];

function result(statuses: ("pass" | "fail" | "n/a")[], warnings: Result["warnings"] = []): Result {
  const verdicts = statuses.map((status, i) => ({
    id: (i + 1) as 1,
    name: NAMES[i],
    status,
    evidence: status === "fail" ? [`evidence for ${NAMES[i]}`, "Week 3"] : [],
  }));
  return { verdicts, warnings, passed: verdicts.every((v) => v.status !== "fail") };
}

function record(run = 1, overrides: Partial<RunRecord["meta"]> = {}): RunRecord {
  return {
    meta: {
      topic: "sde",
      run,
      startedAt: "2026-10-29T10:00:00.000Z",
      commit: "abc1234",
      key: "app",
      models: { research: "anthropic/claude-sonnet-5.5" },
      ms: 212_000,
      costUsd: 1.31,
      costByStage: { Research: 0.8, "Top level": 0.51 },
      ...overrides,
    },
    events: [],
    calls: [],
    materials: { verified: [], allocated: null, dropped: [], coverage: null },
    split: null,
    plan: makeRoot([makeNode({ id: "w1", level: "week", title: "Week 1", summary: "", len: 1 })]),
  };
}

describe("renderRunReport", () => {
  it("renders a run report with every verdict and its evidence", () => {
    const report = renderRunReport(
      record(2),
      result(["pass", "fail", "n/a", "pass", "pass", "fail"], [{ kind: "retries", text: "outline: 2 failed attempts, 0 calls gave up" }]),
    );
    expect(report).toContain("sde");
    expect(report).toContain("run 2");
    expect(report).toContain("abc1234");
    expect(report).toContain("212 s");
    expect(report).toContain("$1.31");
    expect(report).toContain("Research");
    expect(report).toContain("$0.80");
    for (const name of NAMES) expect(report).toContain(name);
    expect(report).toContain("evidence for Named list");
    expect(report).toContain("evidence for Week one");
    expect(report).toMatch(/Named list[^\n]*fail/i);
    expect(report).toMatch(/Reservations[^\n]*n\/a/i);
    expect(report).toContain("outline: 2 failed attempts");
  });

  it("says plainly when there are no warnings", () => {
    expect(renderRunReport(record(), result(["pass", "pass", "pass", "pass", "pass", "pass"]))).toMatch(/no warnings/i);
  });
});

describe("renderSummary", () => {
  it("summarises pass counts per criterion and lists an unscorable run", () => {
    const summary = renderSummary([
      { dir: "evals/results/draft-1-sde-1", result: result(["pass", "fail", "pass", "pass", "n/a", "pass"], [{ kind: "sizes", text: "x" }]), meta: record(1).meta },
      { dir: "evals/results/draft-1-sde-2", result: result(["pass", "pass", "fail", "pass", "n/a", "pass"]), meta: record(2, { ms: 100_000, costUsd: 0.5 }).meta },
      { dir: "evals/results/draft-1-sde-3", result: null, error: "Run folder x is missing plan.json" },
    ]);
    expect(summary).toMatch(/Backbone[^\n]*2\/2/);
    expect(summary).toMatch(/Named list[^\n]*1\/2/);
    expect(summary).toMatch(/Reservations[^\n]*1\/2/);
    expect(summary).toMatch(/Practice time[^\n]*n\/a/);
    expect(summary).toContain("draft-1-sde-3");
    expect(summary).toContain("missing plan.json");
    expect(summary).toMatch(/unscorable/i);
    expect(summary).toContain("sizes: 1 warning");
    // median of 212 s and 100 s, and of $1.31 and $0.50
    expect(summary).toContain("156 s");
    expect(summary).toContain("$0.91");
  });
});

describe("runLine", () => {
  it("counts passes among applicable verdicts and says fail when any fails", () => {
    expect(runLine(1, result(["pass", "pass", "n/a", "pass", "pass", "pass"]), record().meta)).toBe("run 1: pass 5/5 · 212 s · $1.31");
    expect(runLine(2, result(["pass", "fail", "pass", "pass", "pass", "pass"]), record().meta)).toBe("run 2: fail 5/6 · 212 s · $1.31");
  });
});

describe("mapLimit", () => {
  it("never runs more than the limit at once and keeps results in order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5 * (6 - n)));
      active -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});

describe("rescore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "draft-report-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-scores saved folders without calls", async () => {
    const good = join(dir, "draft-1-sde-1");
    const broken = join(dir, "draft-1-sde-2");
    writeRun(good, record(1));
    writeRun(broken, record(2));
    rmSync(join(broken, "plan.json"));
    const lines: string[] = [];

    const { summaryPath, rows } = await rescore([good, broken], { now: "2026-10-29T12-00-00-000Z", print: (l) => lines.push(l) });

    expect(summaryPath).toBe(join(dir, "draft-2026-10-29T12-00-00-000Z-rescore-summary.md"));
    expect(existsSync(summaryPath)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0].result).not.toBeNull();
    expect(rows[1].result).toBeNull();
    expect(rows[1].error).toContain("plan.json");
    // the scored folder got its report, and its run.json kept meta and gained the result
    expect(readFileSync(join(good, "report.md"), "utf8")).toContain("Week 1 days");
    const saved = JSON.parse(readFileSync(join(good, "run.json"), "utf8"));
    expect(saved.meta.topic).toBe("sde");
    expect(saved.result.verdicts).toHaveLength(6);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("draft-1-sde-2");
    expect(summary).toContain("plan.json");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^run 1: (pass|fail) \d\/\d · 212 s · \$1\.31$/);
    expect(lines[1]).toMatch(/plan\.json/);
  });

  it("lists a folder whose topic is unknown as unscorable", async () => {
    const odd = join(dir, "draft-1-nope-1");
    writeRun(odd, record(1, { topic: "nope" }));
    writeFileSync(join(dir, "stray.txt"), "");
    const { rows } = await rescore([odd], { now: "t", print: () => {} });
    expect(rows[0].result).toBeNull();
    expect(rows[0].error).toContain("nope");
  });
});
