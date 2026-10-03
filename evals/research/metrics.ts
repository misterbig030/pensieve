import type { GenerationLogRow, ModelCall } from "@/lib/ai/logged";
import type { ResearchOutcome } from "@/lib/ai/research/pipeline";
import { titleMatches, titleTokens } from "@/lib/ai/research/verify";
import { recencyShare } from "@/lib/materials";
import type { Material } from "@/lib/schemas/material";
import type { ResearchGoldenRecord } from "./golden.v3";

export type ArmName = "A" | "C";

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
  costUsd: number;
  latencyMs: number;
  toolCalls: { searches: number; fetches: number; steps: number };
  stoppedBy: string | null;
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
export function checkCounts(calls: ModelCall[]): Pick<RunMetrics, "unknownRefs" | "overBudgetLeaves" | "chapterRegressions" | "unreservedChapters"> {
  let unknownRefs = 0;
  let overBudgetLeaves = 0;
  let chapterRegressions = 0;
  let unreservedChapters = 0;
  for (const call of calls) {
    for (const fact of call.facts) {
      const unknown = fact.match(/^dropped unknown (.+)$/);
      if (unknown) unknownRefs += unknown[1].split(",").length;
      else if (/ over budget: /.test(fact)) overBudgetLeaves += 1;
      else if (/^backbone ch\. \d+ after ch\./.test(fact)) chapterRegressions += 1;
      else if (/^backbone ch\. .* not reserved$/.test(fact)) unreservedChapters += 1;
    }
  }
  return { unknownRefs, overBudgetLeaves, chapterRegressions, unreservedChapters };
}

export function runMetrics(input: {
  record: ResearchGoldenRecord;
  arm: ArmName;
  run: number;
  outcome: ResearchOutcome;
  calls: ModelCall[];
  rows: GenerationLogRow[];
  latencyMs: number;
  /** Fees billed outside tokens, such as arm C's server-side searches. */
  extraCostUsd?: number;
}): RunMetrics {
  const { outcome, record } = input;
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
    costUsd: input.rows.reduce((sum, r) => sum + r.costUsd, 0) + (input.extraCostUsd ?? 0),
    latencyMs: input.latencyMs,
    toolCalls: outcome.arm?.counts ?? { searches: 0, fetches: 0, steps: 0 },
    stoppedBy: outcome.arm?.stoppedBy ?? null,
  };
}

function mean(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
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
  costUsd: number | null;
  latencyMs: number | null;
  searches: number | null;
  fetches: number | null;
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
    costUsd: mean(mine.map((r) => r.costUsd)),
    latencyMs: mean(mine.map((r) => r.latencyMs)),
    searches: mean(mine.map((r) => r.toolCalls.searches)),
    fetches: mean(mine.map((r) => r.toolCalls.fetches)),
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

export function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}
