/**
 * What a benchmark run will cost, worked out before it calls anything, and the spend cap that stops it if the real
 * cost runs past that. The estimate is a planning figure: contestants are priced at the saved allocation call's tokens
 * and judging at a typical rendered length.
 */
import { estimateCostUsd } from "@/lib/ai/models";
import { BASELINE } from "./contestants";
import type { AllocateFixture } from "./fixtures";
import { JUDGE, SECOND_JUDGE } from "./judge";
import type { Contestant } from "./types";

export interface Estimate {
  contestantsUsd: number;
  judgingUsd: number;
  totalUsd: number;
}

/** The judge sees the rendered output plus its instructions, about this many tokens, and answers in about this many. */
const JUDGE_PROMPT_TOKENS = 500;
const JUDGE_OUTPUT_TOKENS = 1_500;
/** A characters-to-tokens rule of thumb. */
const CHARS_PER_TOKEN = 4;
/** One sample in this many is judged again by the second judge. */
const SECOND_JUDGE_EVERY = 5;

/** The tokens each fixture's allocation call would use: its own baseline, or the mean of the others' when it has none. */
function fixtureTokens(fixtures: AllocateFixture[]): { inputTokens: number; outputTokens: number }[] {
  const known = fixtures.flatMap((fixture) => (fixture.baseline ? [fixture.baseline] : []));
  const mean = (pick: (b: { inputTokens: number; outputTokens: number }) => number) =>
    known.length === 0 ? 0 : known.reduce((sum, b) => sum + pick(b), 0) / known.length;
  const fallback = { inputTokens: mean((b) => b.inputTokens), outputTokens: mean((b) => b.outputTokens) };
  return fixtures.map((fixture) => fixture.baseline ?? fallback);
}

/** The estimated cost of running every contestant over every fixture for `epochs` epochs, and of judging the results. */
export function estimateAllocateRun(args: {
  fixtures: AllocateFixture[];
  contestants: Contestant[];
  epochs: number;
  /** The judge calls per sample: 3 for allocate. */
  judgeDimensions: number;
  /** The mean rendered length of an output, in characters. */
  renderedChars: number;
}): Estimate {
  const { fixtures, contestants, epochs, judgeDimensions, renderedChars } = args;

  const perFixture = fixtureTokens(fixtures);
  let contestantsUsd = 0;
  for (const contestant of contestants) {
    const model = (contestant.roles.allocate ?? BASELINE.roles.allocate)!.model;
    for (const usage of perFixture) contestantsUsd += epochs * estimateCostUsd(model, usage);
  }

  const judgeCall = { inputTokens: renderedChars / CHARS_PER_TOKEN + JUDGE_PROMPT_TOKENS, outputTokens: JUDGE_OUTPUT_TOKENS };
  const samplesPerContestant = fixtures.length * epochs;
  const secondOpinions = contestants.length * Math.ceil(samplesPerContestant / SECOND_JUDGE_EVERY);
  const judgingUsd =
    judgeDimensions * (contestants.length * samplesPerContestant * estimateCostUsd(JUDGE.model, judgeCall) + secondOpinions * estimateCostUsd(SECOND_JUDGE.model, judgeCall));

  return { contestantsUsd, judgingUsd, totalUsd: contestantsUsd + judgingUsd };
}

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/**
 * Empty when the estimate fits the cap. Otherwise the smallest single change that does, tried in order: fewer epochs,
 * then fewer fixtures, then fewer contestants (never below the baseline and one more). Cost scales linearly in each, so
 * the new figure is the old one in proportion. When nothing fits, says what the smallest run would cost.
 */
export function cutAdvice(estimate: Estimate, capUsd: number, run: { epochs: number; fixtures: number; contestants: number }): string {
  if (estimate.totalUsd <= capUsd) return "";
  const head = `Estimated ${usd(estimate.totalUsd)} over the ${usd(capUsd)} cap.`;
  const scaled = (factor: number) => estimate.totalUsd * factor;

  for (let epochs = run.epochs - 1; epochs >= 1; epochs--) {
    const cost = scaled(epochs / run.epochs);
    if (cost <= capUsd) return `${head} Fits with --epochs ${epochs} (${usd(cost)}).`;
  }
  for (let fixtures = run.fixtures - 1; fixtures >= 1; fixtures--) {
    const cost = scaled(fixtures / run.fixtures);
    if (cost <= capUsd) return `${head} Fits with --fixtures, using ${fixtures} ${fixtures === 1 ? "fixture" : "fixtures"} (${usd(cost)}).`;
  }
  for (let contestants = run.contestants - 1; contestants >= 2; contestants--) {
    const cost = scaled(contestants / run.contestants);
    if (cost <= capUsd) return `${head} Fits with --contestants, using ${contestants} contestants (${usd(cost)}).`;
  }

  const smallest = scaled((1 / run.epochs) * (1 / run.fixtures) * (Math.min(run.contestants, 2) / run.contestants));
  return `${head} The cap is too low for even the smallest run (${usd(smallest)}).`;
}

/** The real spend of a run so far; once it passes the cap the run starts no more work. */
export class SpendCap {
  spentUsd = 0;

  constructor(private readonly capUsd: number) {}

  add(usd: number): void {
    this.spentUsd += usd;
  }

  /** True once spend is over the cap; spend exactly at the cap has not reached it. */
  get reached(): boolean {
    return this.spentUsd > this.capUsd;
  }
}
