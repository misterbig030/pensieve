import type { GenerationLogRow, ModelCall } from "@/lib/ai/logged";
import type { WorkerSummary } from "@/lib/ai/research/agent";
import type { ResearchOutcome } from "@/lib/ai/research/pipeline";
import { titleMatches, titleTokens } from "@/lib/ai/research/verify";
import { recencyShare } from "@/lib/materials";
import type { PracticeFormat, PracticePick } from "@/lib/practice";
import type { Material } from "@/lib/schemas/material";
import { totalHours, type PlanSplit } from "@/lib/studyTime";
import { draftRequestOf } from "../golden/plan.v1";
import type { ResearchGoldenRecord } from "./golden.v3";

export type ArmName = "A" | "C" | "W";

/** One record through one arm, once. Rubric scores (accuracy, coverage, source fidelity, materials fit) come from the judges. */
export interface RunMetrics {
  recordId: string;
  arm: ArmName;
  run: number;
  /** Survivors ÷ candidates proposed; null when nothing was proposed. */
  verifiedRate: number | null;
  proposed: number;
  verified: number;
  /** Null when the record has no `expectedBackbone` label. */
  backboneHit: boolean | null;
  /** Null when the record has no `mustInclude` label. */
  mustIncludeRecall: number | null;
  recency: number;
  notice: string | null;
  unknownRefs: number;
  overBudgetLeaves: number;
  chapterRegressions: number;
  unreservedChapters: number;
  /** Leaves whose must-reading ran well past the plan's own reading share. */
  overShareLeaves: number;
  /** Hours of material on the list (over the materials that have a size) and the plan's study hours in all. */
  sizedHours: number;
  totalHours: number;
  /** Share of sized materials whose size code measured; null when nothing was sized. */
  measuredShare: number | null;
  /** Share of materials with no size at all. */
  unsizedShare: number;
  /** Main areas research named as covered and as left open. */
  coverage: { covered: number; open: number } | null;
  costUsd: number;
  /** The whole run: research, then the plan draft. */
  latencyMs: number;
  /** The research stage alone (arm and gate), which the arms differ on. */
  researchMs: number;
  toolCalls: { searches: number; fetches: number; steps: number };
  stoppedBy: string | null;
  /** Arm W: how each worker ran; null for the other arms. */
  workers: WorkerSummary[] | null;
  /** Arm W: share of distinct search-result URLs more than one worker saw; null for the other arms. */
  duplicateShare: number | null;
  /** Where the backbone's chapter list came from; null without a backbone or a list. */
  chaptersSource: "catalogue" | "page" | null;
  /** The practice formats the split picked, in order; empty when the split has none or there was no split. */
  picks: PracticeFormat[];
  /** Labelled formats the picks missed and excluded ones they took; null when the record has no format labels. */
  formatHit: { missing: PracticeFormat[]; unwanted: PracticeFormat[] } | null;
}

/** Where the backbone's chapter list came from; null without a backbone or a list. */
export function chaptersSource(materials: Material[]): "catalogue" | "page" | null {
  return materials.find((m) => m.backbone)?.toc?.source ?? null;
}

/** The practice formats a brief should (include) and should not (exclude) get. */
export interface FormatLabels {
  include?: PracticeFormat[];
  exclude?: PracticeFormat[];
}

/** Which labelled formats the picks missed, and which excluded formats they took; null without labels. */
export function formatHit(picks: PracticePick[], labels: FormatLabels | undefined): { missing: PracticeFormat[]; unwanted: PracticeFormat[] } | null {
  if (!labels || (!labels.include && !labels.exclude)) return null;
  const picked = new Set(picks.map((p) => p.format));
  return {
    missing: (labels.include ?? []).filter((f) => !picked.has(f)),
    unwanted: (labels.exclude ?? []).filter((f) => picked.has(f)),
  };
}

function authorMatches(expected: string, author: string | null): boolean {
  if (!author) return false;
  const want = new Set(titleTokens(expected));
  return titleTokens(author).some((t) => want.has(t));
}

/** The plan's backbone is the labelled book: title matches and, when an author is known, the author does too. */
export function backboneHit(materials: Material[], expected: { title: string; author: string } | undefined): boolean | null {
  if (!expected) return null;
  const backbone = materials.find((m) => m.backbone);
  if (!backbone) return false;
  const titleOk = titleMatches(expected.title, [backbone.title]).ok || titleMatches(backbone.title, [expected.title]).ok;
  return titleOk && (backbone.author ? authorMatches(expected.author, backbone.author) : true);
}

/** Share of the labelled canonical materials that made the list, by title. */
export function mustIncludeRecall(materials: Material[], mustInclude: { title: string }[] | undefined): number | null {
  if (!mustInclude || mustInclude.length === 0) return null;
  const hits = mustInclude.filter((want) => materials.some((m) => titleMatches(want.title, [m.title, m.fetchedTitle]).ok)).length;
  return hits / mustInclude.length;
}

/** The code checks' facts, counted across every drafting call of the run. */
export function checkCounts(calls: ModelCall[]): Pick<RunMetrics, "unknownRefs" | "overBudgetLeaves" | "chapterRegressions" | "unreservedChapters" | "overShareLeaves"> {
  let unknownRefs = 0;
  let overBudgetLeaves = 0;
  let chapterRegressions = 0;
  let unreservedChapters = 0;
  let overShareLeaves = 0;
  for (const call of calls) {
    for (const fact of call.facts) {
      const unknown = fact.match(/^dropped unknown (.+)$/);
      if (unknown) unknownRefs += unknown[1].split(",").length;
      else if (/ over budget: /.test(fact)) overBudgetLeaves += 1;
      else if (/ must-reading over the plan's share: /.test(fact)) overShareLeaves += 1;
      else if (/^backbone ch\. \d+ after ch\./.test(fact)) chapterRegressions += 1;
      else if (/^backbone ch\. .* not reserved$/.test(fact)) unreservedChapters += 1;
    }
  }
  return { unknownRefs, overBudgetLeaves, chapterRegressions, unreservedChapters, overShareLeaves };
}

/** How much of the list is sized, and how much of that code measured. */
export function sizeMetrics(materials: Pick<Material, "minutes" | "minutesBasis">[]): Pick<RunMetrics, "sizedHours" | "measuredShare" | "unsizedShare"> {
  const sized = materials.filter((m) => m.minutes);
  const minutes = sized.reduce((sum, m) => sum + (m.minutes ?? 0), 0);
  return {
    sizedHours: Math.round((minutes / 60) * 10) / 10,
    measuredShare: sized.length === 0 ? null : sized.filter((m) => m.minutesBasis === "measured").length / sized.length,
    unsizedShare: materials.length === 0 ? 0 : (materials.length - sized.length) / materials.length,
  };
}

export function runMetrics(input: {
  record: ResearchGoldenRecord;
  arm: ArmName;
  run: number;
  outcome: ResearchOutcome;
  calls: ModelCall[];
  rows: GenerationLogRow[];
  latencyMs: number;
  researchMs: number;
  /** Fees billed outside tokens, such as arm C's server-side searches. */
  extraCostUsd?: number;
  /** The split the practice pick chose and the draft kept, when there was one. */
  split?: PlanSplit | null;
}): RunMetrics {
  const { outcome, record } = input;
  const picks = input.split?.formats ?? [];
  return {
    recordId: record.id,
    arm: input.arm,
    run: input.run,
    verifiedRate: outcome.proposed > 0 ? outcome.verified / outcome.proposed : null,
    proposed: outcome.proposed,
    verified: outcome.verified,
    backboneHit: backboneHit(outcome.materials, record.labels?.expectedBackbone),
    mustIncludeRecall: mustIncludeRecall(outcome.materials, record.labels?.mustInclude),
    recency: recencyShare(outcome.materials),
    notice: outcome.notice ?? null,
    ...checkCounts(input.calls),
    ...sizeMetrics(outcome.materials),
    totalHours: totalHours(draftRequestOf(record.input).weeks, record.input.hoursPerWeek),
    coverage: outcome.coverage ? { covered: outcome.coverage.covered.length, open: outcome.coverage.open.length } : null,
    costUsd: input.rows.reduce((sum, r) => sum + r.costUsd, 0) + (input.extraCostUsd ?? 0),
    latencyMs: input.latencyMs,
    researchMs: input.researchMs,
    toolCalls: outcome.arm?.counts ?? { searches: 0, fetches: 0, steps: 0 },
    stoppedBy: outcome.arm?.stoppedBy ?? null,
    chaptersSource: chaptersSource(outcome.materials),
    workers: outcome.arm?.workers ?? null,
    duplicateShare: outcome.arm?.duplicateShare ?? null,
    picks: picks.map((p) => p.format),
    formatHit: formatHit(picks, record.labels?.formats),
  };
}

function mean(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export interface ArmSummary {
  arm: ArmName;
  runs: number;
  verifiedRate: number | null;
  backboneHit: number | null;
  mustIncludeRecall: number | null;
  recency: number | null;
  unknownRefs: number | null;
  overBudgetLeaves: number | null;
  chapterRegressions: number | null;
  /** Sized hours over the plan's hours: 1 means the list would fill every hour with reading. */
  sizedRatio: number | null;
  measuredShare: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  /** Median of the research stage alone, what the arm W rule reads. */
  researchMedianMs: number | null;
  /** Arm W: mean duplicate share across runs; null for the other arms. */
  duplicateShare: number | null;
  searches: number | null;
  fetches: number | null;
  /** Share of runs with a backbone whose chapter list was found; null when no run had a backbone. */
  chaptersFound: number | null;
}

export function summarize(arm: ArmName, runs: RunMetrics[]): ArmSummary {
  const mine = runs.filter((r) => r.arm === arm);
  return {
    arm,
    runs: mine.length,
    verifiedRate: mean(mine.map((r) => r.verifiedRate)),
    backboneHit: mean(mine.map((r) => (r.backboneHit === null ? null : r.backboneHit ? 1 : 0))),
    mustIncludeRecall: mean(mine.map((r) => r.mustIncludeRecall)),
    recency: mean(mine.map((r) => r.recency)),
    unknownRefs: mean(mine.map((r) => r.unknownRefs)),
    overBudgetLeaves: mean(mine.map((r) => r.overBudgetLeaves)),
    chapterRegressions: mean(mine.map((r) => r.chapterRegressions)),
    sizedRatio: mean(mine.map((r) => (r.totalHours > 0 ? r.sizedHours / r.totalHours : null))),
    measuredShare: mean(mine.map((r) => r.measuredShare)),
    costUsd: mean(mine.map((r) => r.costUsd)),
    latencyMs: mean(mine.map((r) => r.latencyMs)),
    researchMedianMs: median(mine.map((r) => r.researchMs)),
    duplicateShare: mean(mine.map((r) => r.duplicateShare)),
    searches: mean(mine.map((r) => r.toolCalls.searches)),
    fetches: mean(mine.map((r) => r.toolCalls.fetches)),
    chaptersFound: mean(mine.filter((r) => r.backboneHit !== false).map((r) => (r.chaptersSource === null ? 0 : 1))),
  };
}

/**
 * The pre-registered rule, on the code metrics this runner can compute: arm A stays the default if it is no worse
 * than arm C on backbone hit and within 10 points on verified rate. The three research-sensitive rubric dimensions
 * are the judges' half of the rule and are read off their scores.
 */
export function decide(a: ArmSummary, c: ArmSummary): { keepA: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let keepA = true;
  if (a.backboneHit !== null && c.backboneHit !== null && a.backboneHit < c.backboneHit) {
    keepA = false;
    reasons.push(`backbone hit ${pct(a.backboneHit)} < ${pct(c.backboneHit)}`);
  }
  if (a.verifiedRate !== null && c.verifiedRate !== null && c.verifiedRate - a.verifiedRate > 0.1) {
    keepA = false;
    reasons.push(`verified rate ${pct(a.verifiedRate)} is more than 10 points below ${pct(c.verifiedRate)}`);
  }
  if (keepA) reasons.push("no worse on backbone hit, within 10 points on verified rate");
  return { keepA, reasons };
}

/**
 * The pre-registered rule for arm W against arm A: adopt W if its median research latency is at most 0.7 × A's, its
 * backbone hit and mustInclude recall are each within five points of A's, and its cost per run is at most 1.8 × A's.
 * A check that cannot be made (no runs, or no labelled runs on one side) blocks adoption and says so. When the answer
 * is no, `reasons` lists what blocked it; when yes, every check that passed.
 */
export function decideWorkers(a: ArmSummary, w: ArmSummary): { adoptW: boolean; reasons: string[] } {
  if (a.runs === 0 || w.runs === 0) return { adoptW: false, reasons: [`no runs to compare (A ${a.runs}, W ${w.runs})`] };
  const passed: string[] = [];
  const blockers: string[] = [];
  const secs = (ms: number) => `${(ms / 1000).toFixed(0)} s`;
  if (a.researchMedianMs === null || w.researchMedianMs === null) blockers.push("research latency not comparable");
  else if (w.researchMedianMs <= 0.7 * a.researchMedianMs) passed.push(`median research latency ${secs(w.researchMedianMs)} is at most 0.7 × ${secs(a.researchMedianMs)}`);
  else blockers.push(`median research latency ${secs(w.researchMedianMs)} is more than 0.7 × ${secs(a.researchMedianMs)}`);
  const quality: [string, number | null, number | null][] = [["backbone hit", a.backboneHit, w.backboneHit], ["mustInclude recall", a.mustIncludeRecall, w.mustIncludeRecall]];
  let within = 0;
  for (const [name, av, wv] of quality) {
    if (av === null || wv === null) blockers.push(`${name} not comparable: no labelled runs on both sides`);
    else if (av - wv > 0.05 + 1e-9) blockers.push(`${name} ${pct(wv)} is more than five points below ${pct(av)}`);
    else within += 1;
  }
  if (within === quality.length) passed.push("backbone hit and mustInclude recall within five points");
  if (a.costUsd === null || w.costUsd === null) blockers.push("cost not comparable");
  else if (w.costUsd <= 1.8 * a.costUsd) passed.push(`cost $${w.costUsd.toFixed(3)} is at most 1.8 × $${a.costUsd.toFixed(3)}`);
  else blockers.push(`cost $${w.costUsd.toFixed(3)} is more than 1.8 × $${a.costUsd.toFixed(3)}`);
  return blockers.length > 0 ? { adoptW: false, reasons: blockers } : { adoptW: true, reasons: passed };
}

export function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}
