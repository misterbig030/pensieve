import { codeOnlyScore, groupScores, sampleScore, type ScoredCriterion } from "./score";
import { pairedDelta, passHatK, paretoFrontier, qualityInterval, verdictOf, type Interval } from "./stats";
import type { Contestant, Role, RoleModel, Sample } from "./types";

/** Everything the report says about one contestant. Intervals can be unbounded when a mean rests on one value. */
export interface ContestantSummary {
  name: string;
  models: Partial<Record<Role, RoleModel>>;
  verdict: "baseline" | "qualifies" | "worse" | "inconclusive";
  quality: (Interval & { oneFixture: boolean }) | null;
  codeOnly: Interval | null;
  delta: (Interval & { oneFixture: boolean }) | null;
  completion: number | null;
  passHat3: number | null;
  costUsd: number;
  p50Ms: number;
  p90Ms: number;
  groups: Record<string, number | null>;
  criteria: Record<string, { met: number; of: number }>;
  voids: number;
  unjudged: number;
  judgeDependent: boolean;
}

/** A judged sample counts as passing for pass^k at this score or above, as long as its gate completed. */
const PASS_SCORE = 0.7;
const PASS_K = 3;
/** The margin used in the "more epochs" advice when the run does not say which one it used. */
const DEFAULT_MARGIN = 0.05;

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const meanOrNull = (values: number[]) => (values.length > 0 ? mean(values) : null);
const present = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);

/** The value at percentile `p` (0 to 1) by nearest rank; 0 for no values. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(Math.ceil(p * sorted.length) - 1, 0)];
}

/** The mean cost of the samples, 0 for none. */
function costOf(samples: Sample[]): number {
  return samples.length > 0 ? mean(samples.map((s) => s.costUsd)) : 0;
}

/** Scores by fixture, for the samples a score exists for. */
function byFixture(samples: Sample[], score: (sample: Sample) => number | null): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const sample of samples) {
    const value = score(sample);
    if (value === null) continue;
    map.set(sample.fixture, [...(map.get(sample.fixture) ?? []), value]);
  }
  return map;
}

/** The sample as the second judge saw it: its judge results replaced by the second judge's. */
function withSecondJudge(sample: Sample): Sample {
  return { ...sample, results: [...sample.results.filter((r) => r.grader !== "judge"), ...(sample.secondJudge ?? [])] };
}

const isJudge = (criterion: ScoredCriterion) => criterion.grader === "judge";

/**
 * The quality difference from the baseline on the double-judged samples under each judge. The result is judge-dependent
 * when the two differences point opposite ways and are more than `margin` apart.
 */
function judgeDependence(own: Sample[], baseline: Sample[], criteria: ScoredCriterion[], margin: number): boolean {
  const doubled = (list: Sample[]) => list.filter((s) => s.judged && s.secondJudge);
  const mine = doubled(own);
  const theirs = doubled(baseline);
  const difference = (score: (s: Sample) => number | null) => {
    const a = meanOrNull(present(mine.map(score)));
    const b = meanOrNull(present(theirs.map(score)));
    return a === null || b === null ? null : a - b;
  };
  const dA = difference((s) => sampleScore(s, criteria, isJudge));
  const dB = difference((s) => sampleScore(withSecondJudge(s), criteria, isJudge));
  return dA !== null && dB !== null && Math.sign(dA) !== Math.sign(dB) && Math.abs(dA - dB) > margin;
}

/**
 * One summary per contestant. Void samples count only in `voids`. Quality uses the judged samples, code-only and
 * completion all the others. The baseline is the contestant named `baseline`, else the first.
 */
export function summarize(
  samples: Sample[],
  criteria: ScoredCriterion[],
  contestants: Contestant[],
  margin: number,
): ContestantSummary[] {
  if (contestants.length === 0) return [];
  const baselineName = (contestants.find((c) => c.name === "baseline") ?? contestants[0]).name;
  const live = (name: string) => samples.filter((s) => s.contestant === name && s.gate.status !== "void");
  const qualityOf = (list: Sample[]) =>
    byFixture(
      list.filter((s) => s.judged),
      (s) => sampleScore(s, criteria),
    );
  const baselineSamples = live(baselineName);
  const baselineQuality = qualityOf(baselineSamples);
  const baselineCost = costOf(baselineSamples);
  const groupKeys = Object.keys(groupScores({ gate: { status: "completed" }, results: [] }, criteria));
  /** A group scored in part by a judge counts only the judged samples. */
  const judgedKey = (key: string) =>
    key.startsWith("quality.") || criteria.some((c) => c.group === key && c.grader === "judge");

  return contestants.map((contestant): ContestantSummary => {
    const own = live(contestant.name);
    const quality = qualityInterval(qualityOf(own));
    const codeOnly = qualityInterval(byFixture(own, (s) => codeOnlyScore(s, criteria)));
    const completion = own.length > 0 ? own.filter((s) => s.gate.status === "completed").length / own.length : null;
    const costUsd = costOf(own);

    const passes = new Map<string, { n: number; c: number }>();
    // Only judged samples are trials: an unjudged one has a code-only score, which is not the score pass^3 is about.
    for (const s of own.filter((s) => s.judged)) {
      const entry = passes.get(s.fixture) ?? { n: 0, c: 0 };
      const score = sampleScore(s, criteria);
      entry.n++;
      if (s.gate.status === "completed" && score !== null && score >= PASS_SCORE) entry.c++;
      passes.set(s.fixture, entry);
    }

    const perSample = own.map((s) => ({ judged: s.judged, scores: groupScores(s, criteria) }));
    const groups: Record<string, number | null> = {};
    for (const key of groupKeys) {
      const values = perSample.filter((s) => s.judged || !judgedKey(key)).map((s) => s.scores[key]);
      groups[key] = meanOrNull(present(values));
    }

    const counts: Record<string, { met: number; of: number }> = {};
    for (const c of criteria) counts[c.id] = { met: 0, of: 0 };
    for (const s of own) {
      for (const r of s.results) {
        const count = counts[r.id];
        if (!count) continue;
        count.of++;
        if (r.met) count.met++;
      }
    }

    const isBaseline = contestant.name === baselineName;
    const delta = isBaseline ? null : pairedDelta(qualityOf(own), baselineQuality);
    const judgeDependent = isBaseline ? false : judgeDependence(own, baselineSamples, criteria, margin);
    const verdict = isBaseline
      ? "baseline"
      : verdictOf({ delta, completion, costUsd, baselineCostUsd: baselineCost, margin, judgeDependent });

    return {
      name: contestant.name,
      models: contestant.roles,
      verdict,
      quality,
      codeOnly: codeOnly && { mean: codeOnly.mean, low: codeOnly.low, high: codeOnly.high, n: codeOnly.n },
      delta,
      completion,
      passHat3: passHatK(passes, PASS_K),
      costUsd,
      p50Ms: percentile(
        own.map((s) => s.ms),
        0.5,
      ),
      p90Ms: percentile(
        own.map((s) => s.ms),
        0.9,
      ),
      groups,
      criteria: counts,
      voids: samples.filter((s) => s.contestant === contestant.name).length - own.length,
      unjudged: own.filter((s) => !s.judged).length,
      judgeDependent,
    };
  });
}

// --- Rendering ---------------------------------------------------------------------------------------------------

type Checked = Map<string, { graded: number; agreed: number; checked: boolean }>;

/** A number with two decimals; "n/a" for a missing or non-finite one, so no NaN or Infinity reaches the page. */
const num = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(2);
const signed = (value: number) => (Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}` : "n/a");
const usd = (value: number) => (Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a");
const seconds = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "n/a");

/** `mean [low, high]`, or `mean [unbounded]` when either bound is infinite. */
function withInterval(i: Interval | null, format: (v: number) => string = num): string {
  if (!i) return "n/a";
  if (!Number.isFinite(i.low) || !Number.isFinite(i.high)) return `${format(i.mean)} [unbounded]`;
  return `${format(i.mean)} [${format(i.low)}, ${format(i.high)}]`;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
const table = (header: string[], rows: string[][]) =>
  [row(header), row(header.map(() => "---")), ...rows.map(row)].join("\n");
const UNCHECKED = " (unchecked)";

/**
 * How many more samples would settle an inconclusive contestant, or null when that cannot be said. The delta's n counts
 * epochs of the one fixture, or the fixtures themselves when there are several, so the advice names which.
 */
function moreToSettle(summary: ContestantSummary, margin: number): { count: number; unit: "epochs" | "fixtures" } | null {
  const d = summary.delta;
  if (summary.verdict !== "inconclusive" || !d || !(d.mean > -margin)) return null;
  const halfWidth = (d.high - d.low) / 2;
  const count = Math.ceil(d.n * (halfWidth / (d.mean + margin)) ** 2 - d.n);
  return Number.isFinite(count) && count > 0 ? { count, unit: d.oneFixture ? "epochs" : "fixtures" } : null;
}

/** The sample file the report links, relative to the report. */
const sampleFile = (s: Pick<Sample, "contestant" | "fixture" | "epoch">) =>
  `samples/${s.contestant}-${s.fixture}-${s.epoch}.json`;

/** The report: header, then the comparison, score by group, criteria, samples and the chart link, in that order. */
export function renderReport(args: {
  task: string;
  summaries: ContestantSummary[];
  samples: Sample[];
  criteria: ScoredCriterion[];
  checked: Checked;
  run: {
    commit: string;
    fixtures: string[];
    epochs: number;
    capUsd: number;
    spentUsd: number;
    judge: RoleModel;
    secondJudge: RoleModel;
    /** The margin the verdicts used; 0.05 when left out. */
    margin?: number;
  };
}): string {
  const { task, summaries, samples, criteria, checked, run } = args;
  const margin = run.margin ?? DEFAULT_MARGIN;
  const judgeIds = (filter: (c: ScoredCriterion) => boolean = () => true) =>
    criteria.filter((c) => c.grader === "judge" && filter(c)).map((c) => c.id);
  /** The label for a judged number resting on these judge criteria: set when any of them is not checked. */
  const label = (ids: string[]) => (ids.some((id) => !checked.get(id)?.checked) ? UNCHECKED : "");
  const allJudged = label(judgeIds());
  const out: string[] = [];

  out.push(
    `# Model benchmark: ${task}`,
    "",
    `- Commit: ${run.commit}`,
    `- Fixtures: ${run.fixtures.join(", ") || "none"}; ${run.epochs} epochs`,
    `- Judge: ${run.judge.model} (${run.judge.effort}); second judge: ${run.secondJudge.model} (${run.secondJudge.effort})`,
    `- Spend: $${run.spentUsd.toFixed(2)} of the $${run.capUsd.toFixed(2)} cap`,
    `- Margin: ${margin}`,
    "",
  );
  if (allJudged) {
    out.push("A judged number marked (unchecked) rests on a judge criterion the owner has not calibrated yet.", "");
  }

  // 1. Comparison
  out.push("## 1. Comparison", "");
  out.push(
    table(
      ["Contestant", "Verdict", "Score", "Code-only", "Δ vs baseline", "Completion", "pass^3", "Cost/sample", "p50", "p90"],
      summaries.map((s) => [
        s.name,
        s.judgeDependent ? `${s.verdict} (judge-dependent)` : s.verdict,
        s.quality ? withInterval(s.quality) + allJudged : "n/a",
        withInterval(s.codeOnly),
        s.delta ? withInterval(s.delta, signed) + allJudged : "n/a",
        num(s.completion),
        s.passHat3 === null ? "n/a" : num(s.passHat3) + allJudged,
        usd(s.costUsd),
        seconds(s.p50Ms),
        seconds(s.p90Ms),
      ]),
    ),
    "",
  );
  const oneFixture = summaries.filter((s) => s.quality?.oneFixture || s.delta?.oneFixture).map((s) => s.name);
  if (oneFixture.length > 0) {
    out.push(`*one fixture: the interval measures run-to-run spread only* (${oneFixture.join(", ")})`, "");
  }
  const notes = summaries.flatMap((s) => {
    const more = moreToSettle(s, margin);
    return [
      ...(s.voids > 0 ? [`- ${s.name}: ${s.voids} void sample${s.voids === 1 ? "" : "s"} left out`] : []),
      ...(s.unjudged > 0 ? [`- ${s.name}: ${s.unjudged} sample${s.unjudged === 1 ? "" : "s"} not judged yet`] : []),
      ...(more !== null ? [`- ${s.name}: about ${more.count} more ${more.unit} would settle it`] : []),
    ];
  });
  if (notes.length > 0) out.push(...notes, "");

  // 2. Score by group
  out.push("## 2. Score by group", "");
  const keys = [...new Set(summaries.flatMap((s) => Object.keys(s.groups)))];
  const groupLabel = (key: string) =>
    label(
      key.startsWith("quality.")
        ? judgeIds((c) => "dimension" in c && c.dimension === key.slice("quality.".length))
        : judgeIds((c) => c.group === key),
    );
  out.push(
    table(
      ["Group", ...summaries.map((s) => s.name)],
      keys.map((key) => [
        key,
        ...summaries.map((s) => {
          const score = s.groups[key];
          return score === null || score === undefined ? "n/a" : num(score) + groupLabel(key);
        }),
      ]),
    ),
    "",
  );

  // 3. Criteria
  out.push("## 3. Criteria", "", "Negative-weight criteria that were met are listed first: they are the harms.", "");
  const metByAnyone = (id: string) => summaries.some((s) => (s.criteria[id]?.met ?? 0) > 0);
  const harms = criteria.filter((c) => c.weight < 0 && metByAnyone(c.id));
  const ordered = [...harms, ...criteria.filter((c) => !harms.includes(c))];
  out.push(
    table(
      ["Criterion", "Weight", "Grader", ...summaries.map((s) => s.name)],
      ordered.map((c) => [
        `${c.id}: ${c.text}`,
        String(c.weight),
        c.grader === "judge" ? `judge${label([c.id])}` : "code",
        ...summaries.map((s) => {
          const count = s.criteria[c.id];
          return count && count.of > 0 ? `${count.met}/${count.of}` : "n/a";
        }),
      ]),
    ),
    "",
  );

  // 4. Samples
  out.push("## 4. Samples", "");
  const order = new Map(summaries.map((s, i) => [s.name, i]));
  const sorted = [...samples].sort(
    (a, b) =>
      (order.get(a.contestant) ?? 0) - (order.get(b.contestant) ?? 0) ||
      a.fixture.localeCompare(b.fixture) ||
      a.epoch - b.epoch,
  );
  for (const s of sorted) {
    const score = sampleScore(s, criteria);
    const gate = s.gate.status === "completed" ? "completed" : `${s.gate.status}: ${s.gate.reason}`;
    const shown = score === null ? "n/a" : num(score) + (s.judged ? allJudged : "");
    const estimated = s.estimatedCostUsd ? ` (includes ${usd(s.estimatedCostUsd)} estimated: the call ended without usage)` : "";
    out.push(
      `- [${s.contestant} / ${s.fixture} / ${s.epoch}](${sampleFile(s)}): score ${shown}${s.judged ? "" : " (not judged)"}, ${gate}, ${usd(s.costUsd)}${estimated}, ${seconds(s.ms)}`,
    );
  }
  if (sorted.length === 0) out.push("No samples.");
  out.push("");

  out.push("### Voids", "");
  const voids = sorted.flatMap((s) =>
    s.gate.status === "void" ? [`- ${s.contestant} / ${s.fixture} / ${s.epoch}: ${s.gate.reason}`] : [],
  );
  out.push(...(voids.length > 0 ? voids : ["None."]), "");

  out.push("### Judge disagreements", "");
  const disagreements = sorted.flatMap((s) =>
    (s.secondJudge ?? []).flatMap((second) => {
      const first = s.results.find((r) => r.id === second.id && r.grader === "judge");
      return first && first.met !== second.met
        ? [
            `- ${s.contestant} / ${s.fixture} / ${s.epoch}, ${second.id}: ${run.judge.model} said ${first.met ? "met" : "not met"}, ${run.secondJudge.model} said ${second.met ? "met" : "not met"}`,
          ]
        : [];
    }),
  );
  out.push(...(disagreements.length > 0 ? disagreements : ["None."]), "");

  // 5. Chart
  const frontier = frontierPoints(chartPoints(summaries)).map((p) => p.name);
  out.push(
    "## 5. Score vs cost",
    "",
    `Pareto frontier: ${frontier.join(", ") || "none"}`,
    "",
    "![Score vs cost](chart.svg)",
    "",
  );
  return out.join("\n");
}

// --- Chart -------------------------------------------------------------------------------------------------------

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface ChartPoint {
  name: string;
  quality: number;
  costUsd: number;
}

/** The contestants with a quality score and a cost to plot: the chart's dots and the frontier's candidates. */
function chartPoints(summaries: ContestantSummary[]): ChartPoint[] {
  return summaries.flatMap((s) =>
    s.quality && Number.isFinite(s.quality.mean) && Number.isFinite(s.costUsd)
      ? [{ name: s.name, quality: s.quality.mean, costUsd: s.costUsd }]
      : [],
  );
}

/** The points no other point beats, cheapest first. */
function frontierPoints(points: ChartPoint[]): ChartPoint[] {
  const names = new Set(paretoFrontier(points));
  return points.filter((p) => names.has(p.name)).sort((a, b) => a.costUsd - b.costUsd);
}

/** A self-contained SVG: cost per sample across, quality up, one labelled dot per contestant, the Pareto frontier joined. */
export function renderChart(summaries: ContestantSummary[]): string {
  const W = 640;
  const H = 400;
  const left = 64;
  const right = 28;
  const top = 20;
  const bottom = 52;
  const points = chartPoints(summaries);
  const maxCost = Math.max(...points.map((p) => p.costUsd), 0) || 1;
  const yMin = Math.min(0, ...points.map((p) => p.quality));
  const yMax = Math.max(1, ...points.map((p) => p.quality));
  const x = (cost: number) => left + (cost / maxCost) * (W - left - right) * 0.94;
  const y = (quality: number) => top + (1 - (quality - yMin) / (yMax - yMin)) * (H - top - bottom);
  const frontier = new Set(frontierPoints(points).map((p) => p.name));
  const line = frontierPoints(points).map((p) => `${x(p.costUsd).toFixed(1)},${y(p.quality).toFixed(1)}`);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="12">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${H - bottom}" stroke="#444"/>`,
    `<line x1="${left}" y1="${H - bottom}" x2="${W - right}" y2="${H - bottom}" stroke="#444"/>`,
  ];
  for (let i = 0; i <= 4; i++) {
    const cost = (maxCost / 4) * i;
    const quality = yMin + ((yMax - yMin) / 4) * i;
    parts.push(
      `<line x1="${x(cost).toFixed(1)}" y1="${H - bottom}" x2="${x(cost).toFixed(1)}" y2="${H - bottom + 5}" stroke="#444"/>`,
      `<text x="${x(cost).toFixed(1)}" y="${H - bottom + 18}" text-anchor="middle" fill="#444">${cost.toFixed(4)}</text>`,
      `<line x1="${left - 5}" y1="${y(quality).toFixed(1)}" x2="${left}" y2="${y(quality).toFixed(1)}" stroke="#444"/>`,
      `<text x="${left - 8}" y="${(y(quality) + 4).toFixed(1)}" text-anchor="end" fill="#444">${quality.toFixed(2)}</text>`,
    );
  }
  parts.push(
    `<text x="${(left + W - right) / 2}" y="${H - 8}" text-anchor="middle" fill="#222">cost per sample (USD)</text>`,
    `<text transform="translate(16 ${(top + H - bottom) / 2}) rotate(-90)" text-anchor="middle" fill="#222">quality</text>`,
  );
  if (line.length >= 2) parts.push(`<polyline points="${line.join(" ")}" fill="none" stroke="#2a6fdb" stroke-width="2"/>`);
  for (const p of points) {
    parts.push(
      `<circle cx="${x(p.costUsd).toFixed(1)}" cy="${y(p.quality).toFixed(1)}" r="5" fill="${frontier.has(p.name) ? "#2a6fdb" : "#8a8f98"}"/>`,
      `<text x="${(x(p.costUsd) + 8).toFixed(1)}" y="${(y(p.quality) - 8).toFixed(1)}" fill="#222">${escapeXml(p.name)}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}
