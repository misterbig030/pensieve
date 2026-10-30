import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkedCriteria, pickCalibration, writeCalibration, type CalibrationFile } from "./calibration";
import type { CriterionResult, JudgeCriterion, Sample } from "./types";

const JUDGE = "anthropic/claude-opus-5.5" as const;
const OTHER = "openai/gpt-5.4" as const;

const crit = (id: string, text = `text of ${id}`): JudgeCriterion => ({ id, group: "quality", weight: 3, text, grader: "judge", dimension: "voice" });
const judged = (id: string, met: boolean, judge = JUDGE): CriterionResult => ({ id, met, evidence: "", grader: "judge", judge });

function sample(contestant: string, fixture: string, epoch: number, over: Partial<Sample> = {}): Sample {
  return {
    task: "allocate", fixture, contestant, epoch, gate: { status: "completed" }, output: null, calls: [], costUsd: 0, ms: 0,
    results: [judged("a", true), judged("b", false)], judged: true, ...over,
  };
}

/** A calibration file with `n` graded items on criterion `a`, the first `agreed` of them agreeing with the judge. */
function file(n: number, agreed: number, over: Partial<CalibrationFile> = {}): CalibrationFile {
  return {
    task: "allocate", judge: JUDGE, createdAt: "2026-10-29T00:00:00.000Z", criteria: [{ id: "a", text: "text of a" }],
    items: Array.from({ length: n }, (_, i) => ({ sample: `s-${i}`, rendered: "", grades: [{ id: "a", judge: true, owner: i < agreed }] })),
    ...over,
  };
}

describe("checkedCriteria", () => {
  it("checks a criterion once 10 owner grades have 8 agreeing", () => {
    const got = checkedCriteria([file(10, 8)], JUDGE, [crit("a")]).get("a");
    expect(got).toEqual({ graded: 10, agreed: 8, checked: true });
  });

  it("does not check it with 7 agreeing", () => {
    expect(checkedCriteria([file(10, 7)], JUDGE, [crit("a")]).get("a")).toEqual({ graded: 10, agreed: 7, checked: false });
  });

  it("does not check it with fewer than 10 grades", () => {
    expect(checkedCriteria([file(9, 9)], JUDGE, [crit("a")]).get("a")).toEqual({ graded: 9, agreed: 9, checked: false });
  });

  it("does not count grades the owner has not given", () => {
    const f = file(12, 10);
    f.items[0].grades[0].owner = null;
    f.items[1].grades[0].owner = null;
    expect(checkedCriteria([f], JUDGE, [crit("a")]).get("a")).toEqual({ graded: 10, agreed: 8, checked: true });
  });

  it("adds up the grades of several files", () => {
    expect(checkedCriteria([file(5, 4), file(5, 4)], JUDGE, [crit("a")]).get("a")).toEqual({ graded: 10, agreed: 8, checked: true });
  });

  it("starts again from 0 when the criterion text has changed", () => {
    expect(checkedCriteria([file(10, 10)], JUDGE, [crit("a", "reworded")]).get("a")).toEqual({ graded: 0, agreed: 0, checked: false });
  });

  it("counts only the files of the given judge", () => {
    expect(checkedCriteria([file(10, 10, { judge: OTHER })], JUDGE, [crit("a")]).get("a")).toEqual({ graded: 0, agreed: 0, checked: false });
  });

  it("measures agreement against the judge's grade", () => {
    const f = file(10, 0);
    for (const item of f.items) item.grades[0] = { id: "a", judge: false, owner: false };
    expect(checkedCriteria([f], JUDGE, [crit("a")]).get("a")).toEqual({ graded: 10, agreed: 10, checked: true });
  });

  it("has an entry for every criterion, with zero counts when nothing graded", () => {
    const got = checkedCriteria([], JUDGE, [crit("a"), crit("b")]);
    expect([...got.keys()]).toEqual(["a", "b"]);
    expect(got.get("b")).toEqual({ graded: 0, agreed: 0, checked: false });
  });
});

describe("pickCalibration", () => {
  const names = ["opus", "sonnet", "haiku"];
  const all = names.flatMap((c) => ["f1", "f2", "f3"].flatMap((f) => [1, 2, 3].map((e) => sample(c, f, e))));

  it("returns 10 of 3 contestants x 9 samples with every contestant present", () => {
    const picked = pickCalibration(all);
    expect(picked).toHaveLength(10);
    expect(new Set(picked.map((s) => s.contestant))).toEqual(new Set(names));
  });

  it("round-robins across contestants in first-seen order, then across fixtures, then epochs", () => {
    const samples = [
      sample("b", "f1", 1), sample("b", "f1", 2), sample("b", "f2", 1), sample("b", "f2", 2),
      sample("a", "f1", 1), sample("a", "f1", 2),
    ];
    const picked = pickCalibration(samples, 6).map((s) => `${s.contestant}-${s.fixture}-${s.epoch}`);
    expect(picked).toEqual(["b-f1-1", "a-f1-1", "b-f2-1", "a-f1-2", "b-f1-2", "b-f2-2"]);
  });

  it("stops when the samples run out", () => {
    expect(pickCalibration(all.slice(0, 4), 10)).toHaveLength(4);
  });

  it("takes only completed, judged samples", () => {
    const samples = [
      sample("a", "f1", 1, { gate: { status: "failed", reason: "no plan" } }),
      sample("a", "f2", 1, { gate: { status: "void", reason: "timeout" } }),
      sample("a", "f3", 1, { judged: false }),
      sample("a", "f4", 1),
    ];
    expect(pickCalibration(samples).map((s) => s.fixture)).toEqual(["f4"]);
  });

  it("takes the n asked for", () => {
    expect(pickCalibration(all, 4)).toHaveLength(4);
  });
});

describe("writeCalibration", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "calibration-")) + "/nested";

  it("writes one item per sample with the judge's grades and no owner grades", () => {
    const d = dir();
    const path = writeCalibration("allocate", [sample("opus", "f1", 2)], (s) => `plan of ${s.contestant}`, [crit("a"), crit("b")], d);
    expect(path.startsWith(d)).toBe(true);
    expect(basename(path)).toMatch(/^allocate-.+\.json$/);
    const written = JSON.parse(readFileSync(path, "utf8")) as CalibrationFile;
    expect(written.task).toBe("allocate");
    expect(written.judge).toBe(JUDGE);
    expect(Number.isNaN(Date.parse(written.createdAt))).toBe(false);
    expect(written.criteria).toEqual([{ id: "a", text: "text of a" }, { id: "b", text: "text of b" }]);
    expect(written.items).toEqual([
      {
        sample: "opus-f1-2", rendered: "plan of opus",
        grades: [{ id: "a", judge: true, owner: null }, { id: "b", judge: false, owner: null }],
      },
    ]);
  });

  it("skips a criterion the sample has no judge result for", () => {
    const s = sample("opus", "f1", 1, { results: [judged("a", true)] });
    const written = JSON.parse(readFileSync(writeCalibration("allocate", [s], () => "", [crit("a"), crit("b")], dir()), "utf8")) as CalibrationFile;
    expect(written.items[0].grades).toEqual([{ id: "a", judge: true, owner: null }]);
  });

  it("writes pretty two-space JSON", () => {
    const text = readFileSync(writeCalibration("allocate", [sample("opus", "f1", 1)], () => "", [crit("a")], dir()), "utf8");
    expect(text).toContain('\n  "task": "allocate"');
  });
});
