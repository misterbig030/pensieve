/**
 * Calibration: the owner grades a sample of judged outputs by hand. A judge criterion counts as checked once the owner's
 * grades agree with the judge often enough; until then every number it feeds is labelled unchecked.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubSecrets } from "@/evals/draft/record";
import { stamp } from "@/evals/draft/run";
import type { AiModelId } from "@/lib/ai/models";
import type { JudgeCriterion, Sample } from "./types";

/** Where calibration files are written. */
export const CALIBRATION_DIR = "benchmarks/calibration";

/** A criterion is checked with at least this many owner grades, this many of them agreeing with the judge. */
const MIN_GRADED = 10;
const MIN_AGREED = 8;

/** A set of judged outputs for the owner to grade; `owner` stays null until they do. */
export interface CalibrationFile {
  task: string;
  judge: AiModelId;
  createdAt: string;
  criteria: { id: string; text: string }[];
  items: { sample: string; rendered: string; grades: { id: string; judge: boolean; owner: boolean | null }[] }[];
}

/** The name a sample's file has in a run, `<contestant>-<fixture>-<epoch>`. */
const sampleName = (s: Sample) => `${s.contestant}-${s.fixture}-${s.epoch}`;

/**
 * Picks `n` completed, judged samples, round-robin across contestants in the order first seen so none is left out, and
 * within a contestant across its fixtures, taking a fixture's epochs in turn.
 */
export function pickCalibration(samples: Sample[], n = 10): Sample[] {
  const byContestant = new Map<string, Map<string, Sample[]>>();
  for (const s of samples) {
    if (s.gate.status !== "completed" || !s.judged) continue;
    const fixtures = byContestant.get(s.contestant) ?? new Map<string, Sample[]>();
    fixtures.set(s.fixture, [...(fixtures.get(s.fixture) ?? []), s]);
    byContestant.set(s.contestant, fixtures);
  }
  const queues = [...byContestant.values()].map((fixtures) =>
    roundRobin([...fixtures.values()].map((own) => own.toSorted((a, b) => a.epoch - b.epoch))),
  );
  return roundRobin(queues).slice(0, n);
}

/** Takes the first of each list, then the second of each, and so on until all are empty. */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

/**
 * Writes the calibration file for `samples` to `<dir>/<task>-<stamp>.json` and returns its path. Each item holds the
 * rendered output and the judge's verdict on every given criterion it judged, with the owner's grade left null.
 */
export function writeCalibration(
  task: string,
  samples: Sample[],
  render: (s: Sample) => string,
  criteria: JudgeCriterion[],
  dir: string = CALIBRATION_DIR,
): string {
  const judge = samples.flatMap((s) => s.results).find((r) => r.grader === "judge" && r.judge)?.judge;
  if (!judge) throw new Error("no judge result in the samples to calibrate");
  const file: CalibrationFile = {
    task,
    judge,
    createdAt: new Date().toISOString(),
    criteria: criteria.map(({ id, text }) => ({ id, text })),
    items: samples.map((s) => ({
      sample: sampleName(s),
      rendered: render(s),
      grades: criteria.flatMap(({ id }) => {
        const result = s.results.find((r) => r.id === id && r.grader === "judge");
        return result ? [{ id, judge: result.met, owner: null }] : [];
      }),
    })),
  };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${task}-${stamp()}.json`);
  writeFileSync(path, scrubSecrets(JSON.stringify(file, null, 2) + "\n"));
  return path;
}

/**
 * For each criterion, how many owner grades there are, how many agree with the judge and whether that is enough to call
 * it checked. Only files by `judge` count, and only grades made against the criterion's current text.
 */
export function checkedCriteria(
  files: CalibrationFile[],
  judge: AiModelId,
  criteria: JudgeCriterion[],
): Map<string, { graded: number; agreed: number; checked: boolean }> {
  const counts = new Map(criteria.map((c) => [c.id, { graded: 0, agreed: 0, checked: false }]));
  const text = new Map(criteria.map((c) => [c.id, c.text]));
  for (const file of files) {
    if (file.judge !== judge) continue;
    const gradedText = new Map(file.criteria.map((c) => [c.id, c.text]));
    for (const item of file.items) {
      for (const grade of item.grades) {
        const count = counts.get(grade.id);
        if (!count || grade.owner === null || gradedText.get(grade.id) !== text.get(grade.id)) continue;
        count.graded++;
        if (grade.owner === grade.judge) count.agreed++;
      }
    }
  }
  for (const count of counts.values()) count.checked = count.graded >= MIN_GRADED && count.agreed >= MIN_AGREED;
  return counts;
}
