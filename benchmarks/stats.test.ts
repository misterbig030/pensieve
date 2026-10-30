import { describe, expect, it } from "vitest";
import { interval, paretoFrontier, passHatK, pairedDelta, qualityInterval, tCritical, verdictOf } from "./stats";

const m = (entries: Record<string, number[]>) => new Map(Object.entries(entries));

describe("tCritical", () => {
  it("is the two-sided 95% value from a table for 1 to 30 degrees of freedom", () => {
    const expected: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 15: 2.131, 20: 2.086, 25: 2.06, 30: 2.042 };
    for (const [df, value] of Object.entries(expected)) expect(tCritical(Number(df))).toBe(value);
  });

  it("is 1.96 above 30", () => {
    expect(tCritical(31)).toBe(1.96);
    expect(tCritical(500)).toBe(1.96);
  });

  it("falls with the degrees of freedom", () => {
    for (let df = 2; df <= 31; df++) expect(tCritical(df)).toBeLessThan(tCritical(df - 1));
  });
});

describe("interval", () => {
  it("is the mean plus or minus t times the standard error", () => {
    const i = interval([0.6, 0.7, 0.8])!;
    expect(i.n).toBe(3);
    expect(i.mean).toBeCloseTo(0.7, 10);
    expect(i.low).toBeCloseTo(0.4516, 3); // 4.303 × 0.1 / √3
    expect(i.high).toBeCloseTo(0.9484, 3);
  });

  it("is null for no values", () => {
    expect(interval([])).toBeNull();
  });

  it("is unbounded for one value", () => {
    expect(interval([0.5])).toEqual({ mean: 0.5, low: -Infinity, high: Infinity, n: 1 });
  });

  it("collapses to the mean when the values agree", () => {
    expect(interval([0.4, 0.4])).toEqual({ mean: 0.4, low: 0.4, high: 0.4, n: 2 });
  });
});

describe("qualityInterval", () => {
  it("clusters by fixture: the interval is over the fixture means", () => {
    const q = qualityInterval(m({ a: [0.2, 0.4], b: [0.8, 1] }))!;
    expect(q.oneFixture).toBe(false);
    expect(q.n).toBe(2);
    expect(q.mean).toBeCloseTo(0.6, 10);
    // fixture means 0.3 and 0.9 → sd 0.4243, se 0.3, t(1) = 12.706
    expect(q.low).toBeCloseTo(0.6 - 12.706 * 0.3, 3);
    expect(q.high).toBeCloseTo(0.6 + 12.706 * 0.3, 3);
  });

  it("uses the epochs when there is one fixture", () => {
    const q = qualityInterval(m({ a: [0.6, 0.7, 0.8] }))!;
    expect(q.oneFixture).toBe(true);
    expect(q.n).toBe(3);
    expect(q.low).toBeCloseTo(0.4516, 3);
  });

  it("is null for no values, and ignores fixtures without any", () => {
    expect(qualityInterval(new Map())).toBeNull();
    expect(qualityInterval(m({ a: [] }))).toBeNull();
    expect(qualityInterval(m({ a: [0.5, 0.5], b: [] }))!.oneFixture).toBe(true);
  });
});

describe("pairedDelta", () => {
  it("is the interval over per-fixture differences of means", () => {
    const d = pairedDelta(m({ a: [0.6, 0.6], b: [0.8, 0.8] }), m({ a: [0.7, 0.7], b: [0.7, 0.7] }))!;
    expect(d.oneFixture).toBe(false);
    expect(d.n).toBe(2);
    expect(d.mean).toBeCloseTo(0, 10);
    // differences −0.1 and 0.1 → sd 0.1414, se 0.1, t(1) = 12.706
    expect(d.low).toBeCloseTo(-12.706 * 0.1, 3);
    expect(d.high).toBeCloseTo(12.706 * 0.1, 3);
  });

  it("uses only the fixtures both have", () => {
    const d = pairedDelta(m({ a: [0.5], b: [0.9], x: [0] }), m({ a: [0.4], b: [0.8], y: [1] }))!;
    expect(d.n).toBe(2);
    expect(d.mean).toBeCloseTo(0.1, 10);
    expect(d.low).toBeCloseTo(0.1, 10);
    expect(d.high).toBeCloseTo(0.1, 10);
  });

  it("is null with no fixture in common", () => {
    expect(pairedDelta(m({ a: [1] }), m({ b: [1] }))).toBeNull();
    expect(pairedDelta(new Map(), new Map())).toBeNull();
  });

  it("compares the epochs of the one fixture, with an unpooled standard error", () => {
    const d = pairedDelta(m({ a: [0.6, 0.7, 0.8] }), m({ a: [0.5, 0.5, 0.5, 0.5] }))!;
    expect(d.oneFixture).toBe(true);
    expect(d.mean).toBeCloseTo(0.2, 10);
    // se = √(0.01/3 + 0/4), df = min(3, 4) − 1 = 2
    const half = 4.303 * Math.sqrt(0.01 / 3);
    expect(d.low).toBeCloseTo(0.2 - half, 3);
    expect(d.high).toBeCloseTo(0.2 + half, 3);
  });

  it("is unbounded when the one fixture has a single epoch on a side", () => {
    const d = pairedDelta(m({ a: [0.9] }), m({ a: [0.5, 0.6, 0.7] }))!;
    expect(d.oneFixture).toBe(true);
    expect(d.mean).toBeCloseTo(0.3, 10);
    expect(d.low).toBe(-Infinity);
    expect(d.high).toBe(Infinity);
  });
});

describe("passHatK", () => {
  it("is the chance that k samples drawn without replacement all pass", () => {
    expect(passHatK(new Map([["f1", { n: 5, c: 4 }]]))).toBeCloseTo(0.4); // C(4,3) / C(5,3)
    expect(passHatK(new Map([["f1", { n: 3, c: 3 }]]))).toBe(1);
    expect(passHatK(new Map([["f1", { n: 4, c: 2 }]]), 2)).toBeCloseTo(1 / 6);
  });

  it("is 0 when fewer than k pass", () => {
    expect(passHatK(new Map([["f1", { n: 3, c: 2 }]]))).toBe(0);
  });

  it("is null when no fixture has k samples", () => {
    expect(passHatK(new Map([["f1", { n: 2, c: 2 }]]))).toBeNull();
    expect(passHatK(new Map())).toBeNull();
  });

  it("averages over the fixtures with k or more samples", () => {
    const byFixture = new Map([["f1", { n: 3, c: 3 }], ["f2", { n: 3, c: 0 }], ["f3", { n: 2, c: 2 }]]);
    expect(passHatK(byFixture)).toBe(0.5);
  });
});

describe("verdictOf", () => {
  const base = { delta: { mean: 0, low: -0.03, high: 0.03, n: 3 }, completion: 1, costUsd: 0.1, baselineCostUsd: 0.5, margin: 0.05, judgeDependent: false };

  it("qualifies when the delta clears the margin, it completes, is cheaper and is not judge-dependent", () => {
    expect(verdictOf(base)).toBe("qualifies");
  });

  it("is worse when the whole interval is below the margin", () => {
    expect(verdictOf({ ...base, delta: { mean: -0.2, low: -0.3, high: -0.1, n: 3 } })).toBe("worse");
  });

  it("is worse below 90% completion even with a null or good delta", () => {
    expect(verdictOf({ ...base, completion: 0.8 })).toBe("worse");
    expect(verdictOf({ ...base, delta: null, completion: 0, costUsd: 0 })).toBe("worse");
    expect(verdictOf({ ...base, completion: 0.899 })).toBe("worse");
  });

  it("is inconclusive when the interval spans the margin", () => {
    expect(verdictOf({ ...base, delta: { mean: 0, low: -0.2, high: 0.2, n: 3 } })).toBe("inconclusive");
  });

  it("is inconclusive when the contestant is judge-dependent", () => {
    expect(verdictOf({ ...base, judgeDependent: true })).toBe("inconclusive");
  });

  it("is inconclusive between 90% and 95% completion", () => {
    expect(verdictOf({ ...base, completion: 0.9 })).toBe("inconclusive");
    expect(verdictOf({ ...base, completion: 0.949 })).toBe("inconclusive");
    expect(verdictOf({ ...base, completion: 0.95 })).toBe("qualifies");
  });

  it("is inconclusive when it is not cheaper than the baseline", () => {
    expect(verdictOf({ ...base, costUsd: 0.5 })).toBe("inconclusive");
    expect(verdictOf({ ...base, costUsd: 0.9 })).toBe("inconclusive");
  });

  it("needs the margin to be strictly cleared, and worse to be strictly beyond it", () => {
    expect(verdictOf({ ...base, delta: { mean: 0, low: -0.05, high: 0.1, n: 3 } })).toBe("inconclusive");
    expect(verdictOf({ ...base, delta: { mean: -0.1, low: -0.2, high: -0.05, n: 3 } })).toBe("inconclusive");
  });

  it("is inconclusive when the delta or completion is unknown", () => {
    expect(verdictOf({ ...base, delta: null })).toBe("inconclusive");
    expect(verdictOf({ ...base, completion: null })).toBe("inconclusive");
  });

  it("is inconclusive for an unbounded interval", () => {
    expect(verdictOf({ ...base, delta: { mean: 0, low: -Infinity, high: Infinity, n: 1 } })).toBe("inconclusive");
  });
});

describe("paretoFrontier", () => {
  it("keeps the points no other point beats on both quality and cost", () => {
    expect(paretoFrontier([{ name: "a", quality: 0.9, costUsd: 1 }, { name: "b", quality: 0.8, costUsd: 0.2 }, { name: "c", quality: 0.7, costUsd: 0.5 }])).toEqual(["a", "b"]);
  });

  it("drops a point that matches another on one axis and loses on the other", () => {
    expect(paretoFrontier([{ name: "a", quality: 0.8, costUsd: 1 }, { name: "b", quality: 0.8, costUsd: 0.5 }])).toEqual(["b"]);
    expect(paretoFrontier([{ name: "a", quality: 0.9, costUsd: 1 }, { name: "b", quality: 0.8, costUsd: 1 }])).toEqual(["a"]);
  });

  it("keeps identical points and handles none", () => {
    expect(paretoFrontier([{ name: "a", quality: 0.8, costUsd: 1 }, { name: "b", quality: 0.8, costUsd: 1 }])).toEqual(["a", "b"]);
    expect(paretoFrontier([])).toEqual([]);
  });
});
