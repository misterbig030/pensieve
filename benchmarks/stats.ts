/** A mean with its 95% confidence bounds and the number of values it rests on. */
export interface Interval {
  mean: number;
  low: number;
  high: number;
  n: number;
}

/** Two-sided 95% critical values of Student's t for 1 to 30 degrees of freedom. */
const T_95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101,
  2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** The two-sided 95% critical value of Student's t: tabled up to 30 degrees of freedom, 1.96 above. */
export function tCritical(df: number): number {
  if (!(df >= 1)) throw new RangeError(`degrees of freedom must be at least 1, got ${df}`);
  return T_95[Math.floor(df) - 1] ?? 1.96;
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** The sample variance, for two or more values. */
function variance(values: number[]): number {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}

const UNBOUNDED = { low: -Infinity, high: Infinity };

/** The mean plus or minus t(n − 1) · sd / √n. Null for no values; one value has no spread, so its bounds are infinite. */
export function interval(values: number[]): Interval | null {
  if (values.length === 0) return null;
  const m = mean(values);
  if (values.length === 1) return { mean: m, ...UNBOUNDED, n: 1 };
  const half = (tCritical(values.length - 1) * Math.sqrt(variance(values))) / Math.sqrt(values.length);
  return { mean: m, low: m - half, high: m + half, n: values.length };
}

/** The fixtures that have at least one value. */
const withValues = (byFixture: Map<string, number[]>) => [...byFixture].filter(([, values]) => values.length > 0);

/**
 * The interval on quality. With two or more fixtures it is over the fixture means, so epochs of one fixture are not
 * counted as independent evidence; with one fixture it is over that fixture's epochs.
 */
export function qualityInterval(byFixture: Map<string, number[]>): (Interval & { oneFixture: boolean }) | null {
  const fixtures = withValues(byFixture);
  if (fixtures.length === 0) return null;
  if (fixtures.length === 1) return { ...interval(fixtures[0][1])!, oneFixture: true };
  return { ...interval(fixtures.map(([, values]) => mean(values)))!, oneFixture: false };
}

/**
 * The quality difference of a contestant from the baseline, on the fixtures both have (null with none). With two or more
 * it is the interval over the per-fixture differences of means. With one it is the difference of the epoch means, with
 * se = √(s₁²/n₁ + s₂²/n₂) and df = min(n₁, n₂) − 1; its n is min(n₁, n₂), and a side with a single epoch makes it unbounded.
 */
export function pairedDelta(
  contestant: Map<string, number[]>,
  baseline: Map<string, number[]>,
): (Interval & { oneFixture: boolean }) | null {
  const shared = withValues(contestant).filter(([id]) => (baseline.get(id)?.length ?? 0) > 0);
  if (shared.length === 0) return null;
  if (shared.length >= 2) {
    const differences = shared.map(([id, values]) => mean(values) - mean(baseline.get(id)!));
    return { ...interval(differences)!, oneFixture: false };
  }
  const [[id, a]] = shared;
  const b = baseline.get(id)!;
  const difference = mean(a) - mean(b);
  const n = Math.min(a.length, b.length);
  if (n < 2) return { mean: difference, ...UNBOUNDED, n, oneFixture: true };
  const half = tCritical(n - 1) * Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  return { mean: difference, low: difference - half, high: difference + half, n, oneFixture: true };
}

/**
 * pass^k: the mean, over the fixtures with at least k samples, of the chance that k samples drawn from a fixture's n all
 * passed, C(c, k) ÷ C(n, k) for c passes. Null when no fixture has k samples.
 */
export function passHatK(byFixture: Map<string, { n: number; c: number }>, k = 3): number | null {
  const chances: number[] = [];
  for (const { n, c } of byFixture.values()) {
    if (n < k) continue;
    let chance = 1;
    for (let i = 0; i < k; i++) chance *= Math.max(c - i, 0) / (n - i);
    chances.push(chance);
  }
  return chances.length > 0 ? mean(chances) : null;
}

/**
 * Worse when the whole interval of the quality delta is below −margin or completion is under 0.90 (whatever the delta).
 * Qualifies when the delta's low end is above −margin, completion is at least 0.95, the cost per sample is under the
 * baseline's and the contestant is not judge-dependent. Anything else, including an unknown delta or completion, is
 * inconclusive.
 */
export function verdictOf(x: {
  delta: Interval | null;
  completion: number | null;
  costUsd: number;
  baselineCostUsd: number;
  margin: number;
  judgeDependent: boolean;
}): "qualifies" | "worse" | "inconclusive" {
  if ((x.delta && x.delta.high < -x.margin) || (x.completion !== null && x.completion < 0.9)) return "worse";
  const qualifies =
    x.delta !== null &&
    x.delta.low > -x.margin &&
    x.completion !== null &&
    x.completion >= 0.95 &&
    x.costUsd < x.baselineCostUsd &&
    !x.judgeDependent;
  return qualifies ? "qualifies" : "inconclusive";
}

/** The names of the points no other point beats: at least as good on quality and as cheap, and better on one. */
export function paretoFrontier(points: { name: string; quality: number; costUsd: number }[]): string[] {
  const dominates = (a: (typeof points)[number], b: (typeof points)[number]) =>
    a.quality >= b.quality && a.costUsd <= b.costUsd && (a.quality > b.quality || a.costUsd < b.costUsd);
  return points.filter((p) => !points.some((other) => dominates(other, p))).map((p) => p.name);
}
