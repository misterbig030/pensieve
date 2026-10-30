import { describe, expect, it } from "vitest";
import { renderChart, renderReport, summarize, type ContestantSummary } from "./report";
import type { Contestant, Criterion, CriterionResult, Gate, Sample } from "./types";

const criteria: Criterion<unknown, unknown>[] = [
  { id: "has-plan", group: "structure", weight: 5, text: "has a plan", grader: "code", check: () => ({ met: true, evidence: "" }) },
  { id: "no-dup", group: "materials", weight: -5, text: "no duplicates", grader: "code", check: () => ({ met: false, evidence: "" }) },
  { id: "clear", group: "quality", weight: 5, text: "is clear", grader: "judge", dimension: "clarity" },
  { id: "deep", group: "quality", weight: 5, text: "is deep", grader: "judge", dimension: "depth" },
];

const baseline: Contestant = { name: "baseline", roles: {} };
const cheap: Contestant = { name: "cheap", roles: { allocate: { model: "openai/gpt-5.4-mini", effort: "low" } } };
const contestants = [baseline, cheap];

const result = (id: string, met: boolean, grader: "code" | "judge"): CriterionResult => ({ id, met, evidence: "because", grader });

/** A judged, completed sample where the given criteria are met and the rest are not. */
function sample(contestant: string, fixture: string, epoch: number, metIds: string[], over: Partial<Sample> = {}): Sample {
  const gate: Gate = { status: "completed" };
  return {
    task: "allocate",
    fixture,
    contestant,
    epoch,
    gate,
    output: null,
    calls: [],
    costUsd: 0.01,
    ms: 1000,
    results: criteria.map((c) => result(c.id, metIds.includes(c.id), c.grader)),
    judged: true,
    ...over,
  };
}

const ALL = ["has-plan", "clear", "deep"];
const noNaN = (value: unknown) => expect(JSON.stringify(value)).not.toContain("NaN");

describe("summarize", () => {
  it("gives the baseline the verdict baseline and no delta", () => {
    const out = summarize([sample("baseline", "f1", 1, ALL), sample("cheap", "f1", 1, ALL)], criteria, contestants, 0.05);
    expect(out[0].verdict).toBe("baseline");
    expect(out[0].delta).toBeNull();
    expect(out[0].quality?.mean).toBe(1);
  });

  it("scores a contestant whose samples all failed completion 0 and worse", () => {
    const failed: Gate = { status: "failed", reason: "no plan" };
    const samples = [
      ...[1, 2, 3].map((e) => sample("baseline", "f1", e, ALL)),
      ...[1, 2, 3].map((e) => sample("cheap", "f1", e, [], { gate: failed, results: [] })),
    ];
    const cheapSummary = summarize(samples, criteria, contestants, 0.05)[1];
    expect(cheapSummary.completion).toBe(0);
    expect(cheapSummary.verdict).toBe("worse");
    expect(cheapSummary.quality?.mean).toBe(0);
    noNaN(cheapSummary);
  });

  it("leaves a contestant whose samples are all void with null completion, inconclusive, and no NaN", () => {
    const voided: Gate = { status: "void", reason: "timeout" };
    const samples = [
      sample("baseline", "f1", 1, ALL),
      ...[1, 2].map((e) => sample("cheap", "f1", e, [], { gate: voided, results: [], costUsd: 0 })),
    ];
    const out = summarize(samples, criteria, contestants, 0.05);
    expect(out[1]).toMatchObject({ completion: null, verdict: "inconclusive", voids: 2, quality: null, delta: null, costUsd: 0, p50Ms: 0, p90Ms: 0 });
    noNaN(out);
  });

  it("counts unjudged samples in code-only scores and completion but not in quality", () => {
    const unjudged = (e: number) => sample("cheap", "f1", e, ["has-plan"], { judged: false, results: [result("has-plan", true, "code"), result("no-dup", false, "code")] });
    const samples = [sample("baseline", "f1", 1, ALL), unjudged(1), unjudged(2)];
    const cheapSummary = summarize(samples, criteria, contestants, 0.05)[1];
    expect(cheapSummary.quality).toBeNull();
    expect(cheapSummary.codeOnly?.mean).toBe(1);
    expect(cheapSummary.completion).toBe(1);
    expect(cheapSummary.unjudged).toBe(2);
    expect(cheapSummary.groups.structure).toBe(1);
    expect(cheapSummary.groups["quality.clarity"]).toBeNull();
    noNaN(cheapSummary);
  });

  it("computes completion, cost, latency percentiles, criteria counts and groups", () => {
    const samples = [
      sample("baseline", "f1", 1, ALL, { costUsd: 0.1 }),
      sample("cheap", "f1", 1, ["has-plan", "clear"], { costUsd: 0.02, ms: 1000 }),
      sample("cheap", "f1", 2, ["has-plan"], { costUsd: 0.04, ms: 3000 }),
      sample("cheap", "f1", 3, ["has-plan", "clear", "deep"], { costUsd: 0.03, ms: 2000 }),
      sample("cheap", "f1", 4, [], { gate: { status: "failed", reason: "x" }, costUsd: 0.03, ms: 4000 }),
    ];
    const s = summarize(samples, criteria, contestants, 0.05)[1];
    expect(s.completion).toBe(0.75);
    expect(s.costUsd).toBeCloseTo(0.03);
    expect(s.p50Ms).toBe(2000);
    expect(s.p90Ms).toBe(4000);
    expect(s.criteria["has-plan"]).toEqual({ met: 3, of: 4 });
    expect(s.criteria.clear).toEqual({ met: 2, of: 4 });
    // The failed sample scores 0, so structure is (1 + 1 + 1 + 0) / 4.
    expect(s.groups.structure).toBeCloseTo(0.75);
    expect(s.models).toEqual(cheap.roles);
  });

  it("computes pass^3 per fixture from completed samples scoring at least 0.7", () => {
    // Positive weight 15; ALL meets 15 (1.0), [has-plan, clear] 10 (0.67), so 2 of the 3 pass.
    const samples = [
      sample("baseline", "f1", 1, ALL),
      sample("cheap", "f1", 1, ALL),
      sample("cheap", "f1", 2, ALL),
      sample("cheap", "f1", 3, ["has-plan", "clear"]),
    ];
    // C(2,3) / C(3,3) = 0
    expect(summarize(samples, criteria, contestants, 0.05)[1].passHat3).toBe(0);
    const allPass = [sample("baseline", "f1", 1, ALL), ...[1, 2, 3].map((e) => sample("cheap", "f1", e, ALL))];
    expect(summarize(allPass, criteria, contestants, 0.05)[1].passHat3).toBe(1);
    // Fewer than 3 samples on every fixture: no pass^3.
    expect(summarize([sample("baseline", "f1", 1, ALL)], criteria, contestants, 0.05)[0].passHat3).toBeNull();
  });

  it("qualifies a cheaper contestant that matches the baseline across fixtures", () => {
    const samples = ["f1", "f2", "f3"].flatMap((f) => [
      sample("baseline", f, 1, ALL, { costUsd: 0.1 }),
      sample("cheap", f, 1, ALL, { costUsd: 0.01 }),
    ]);
    const s = summarize(samples, criteria, contestants, 0.05)[1];
    expect(s.delta).toMatchObject({ mean: 0, oneFixture: false });
    expect(s.verdict).toBe("qualifies");
  });

  describe("second judge", () => {
    // Judge A prefers `cheap`, judge B prefers the baseline.
    const second = (metIds: string[]) => ["clear", "deep"].map((id) => result(id, metIds.includes(id), "judge"));
    const doubled = (contestant: string, a: string[], b: string[]) =>
      sample(contestant, "f1", 1, a, { secondJudge: second(b) });

    it("marks a contestant judge-dependent when the two judges' deltas point opposite ways and differ by more than the margin", () => {
      const samples = [doubled("baseline", ["clear"], ["clear", "deep"]), doubled("cheap", ["clear", "deep"], ["clear"])];
      const s = summarize(samples, criteria, contestants, 0.05)[1];
      // A: 1.0 - 0.5 = +0.5; B: 0.5 - 1.0 = -0.5
      expect(s.judgeDependent).toBe(true);
      expect(s.verdict).not.toBe("qualifies");
    });

    it("is not judge-dependent when the judges agree on the direction", () => {
      const samples = [doubled("baseline", ["clear"], ["clear"]), doubled("cheap", ["clear", "deep"], ["clear", "deep"])];
      expect(summarize(samples, criteria, contestants, 0.05)[1].judgeDependent).toBe(false);
    });

    it("is not judge-dependent without double-judged samples, and never for the baseline", () => {
      const out = summarize([sample("baseline", "f1", 1, ALL), sample("cheap", "f1", 1, ALL)], criteria, contestants, 0.05);
      expect(out.map((s) => s.judgeDependent)).toEqual([false, false]);
    });
  });
});

describe("renderReport", () => {
  const run: Parameters<typeof renderReport>[0]["run"] = {
    commit: "abc1234",
    fixtures: ["f1", "f2"],
    epochs: 3,
    capUsd: 10,
    spentUsd: 1.5,
    judge: { model: "anthropic/claude-opus-5.5", effort: "high" },
    secondJudge: { model: "openai/gpt-5.4", effort: "high" },
  };
  const checkedAll = new Map(["clear", "deep"].map((id) => [id, { graded: 12, agreed: 11, checked: true }]));
  const render = (samples: Sample[], checked: Map<string, { graded: number; agreed: number; checked: boolean }>, extra = {}) => {
    const summaries = summarize(samples, criteria, contestants, 0.05);
    return renderReport({ task: "allocate", summaries, samples, criteria, checked, run: { ...run, ...extra } });
  };
  const samples = [
    sample("baseline", "f1", 1, ALL),
    sample("baseline", "f2", 1, ALL),
    sample("cheap", "f1", 1, ["has-plan", "clear"]),
    sample("cheap", "f2", 1, ALL),
  ];

  it("labels judged numbers unchecked without calibration, and not when every judge criterion is checked", () => {
    expect(render(samples, new Map())).toContain("(unchecked)");
    expect(render(samples, checkedAll)).not.toContain("(unchecked)");
  });

  it("labels only the dimension whose criterion is unchecked", () => {
    const partly = new Map([...checkedAll, ["deep", { graded: 2, agreed: 2, checked: false }]]);
    const report = render(samples, partly);
    const line = (key: string) => report.split("\n").find((l) => l.startsWith(`| ${key} |`))!;
    expect(line("quality.clarity")).not.toContain("(unchecked)");
    expect(line("quality.depth")).toContain("(unchecked)");
    expect(line("structure")).not.toContain("(unchecked)");
  });

  it("has the five sections in order and embeds the chart", () => {
    const report = render(samples, checkedAll);
    const at = ["## 1. Comparison", "## 2. Score by group", "## 3. Criteria", "## 4. Samples", "## 5. Score vs cost"].map((h) => report.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(report).toContain("![Score vs cost](chart.svg)");
  });

  it("names the Pareto frontier in section 5, cheapest first", () => {
    const trade = [
      sample("baseline", "f1", 1, ALL, { costUsd: 0.1 }),
      sample("cheap", "f1", 1, ["has-plan", "clear"], { costUsd: 0.01 }),
    ];
    const report = render(trade, checkedAll);
    expect(report.slice(report.indexOf("## 5. Score vs cost"))).toContain("Pareto frontier: cheap, baseline");
    // A contestant that is no worse and cheaper leaves the baseline off it.
    const dominated = [sample("baseline", "f1", 1, ["has-plan"], { costUsd: 0.1 }), sample("cheap", "f1", 1, ALL, { costUsd: 0.01 })];
    expect(render(dominated, checkedAll)).toContain("Pareto frontier: cheap\n");
    // With no scored contestant there is none to name.
    expect(render([], checkedAll)).toContain("Pareto frontier: none");
  });

  it("lists negative-weight criteria that were met before the others in section 3", () => {
    const harmed = [
      sample("baseline", "f1", 1, ALL),
      sample("cheap", "f1", 1, ["has-plan", "no-dup"]),
    ];
    const report = render(harmed, checkedAll);
    const section = report.slice(report.indexOf("## 3. Criteria"), report.indexOf("## 4. Samples"));
    expect(section.indexOf("no-dup")).toBeLessThan(section.indexOf("has-plan"));
    expect(section).toContain("1/1");
    // When nobody met it, it keeps its place in the list.
    const calm = render(samples, checkedAll);
    const calmSection = calm.slice(calm.indexOf("## 3. Criteria"), calm.indexOf("## 4. Samples"));
    expect(calmSection.indexOf("has-plan")).toBeLessThan(calmSection.indexOf("no-dup"));
  });

  it("links each sample file and lists voids with their reasons", () => {
    const withVoid = [...samples, sample("cheap", "f2", 2, [], { gate: { status: "void", reason: "gateway timeout" }, results: [] })];
    const report = render(withVoid, checkedAll);
    expect(report).toContain("(samples/cheap-f1-1.json)");
    expect(report).toContain("(samples/cheap-f2-2.json)");
    expect(report).toContain("cheap / f2 / 2: gateway timeout");
  });

  it("lists judge disagreements", () => {
    const disagree = [
      sample("baseline", "f1", 1, ALL, { secondJudge: [result("clear", false, "judge"), result("deep", true, "judge")] }),
    ];
    const report = render(disagree, checkedAll);
    expect(report).toContain("baseline / f1 / 1, clear: anthropic/claude-opus-5.5 said met, openai/gpt-5.4 said not met");
    expect(report).not.toContain("deep: anthropic");
  });

  it("notes when the interval measures run-to-run spread only", () => {
    const oneFixture = ["baseline", "cheap"].flatMap((c) => [1, 2, 3].map((e) => sample(c, "f1", e, ALL)));
    expect(render(oneFixture, checkedAll)).toContain("one fixture: the interval measures run-to-run spread only");
    expect(render(samples, checkedAll)).not.toContain("one fixture: the interval measures run-to-run spread only");
  });

  it("advises how many more epochs would settle an inconclusive contestant on one fixture", () => {
    // One fixture: the baseline always scores 1; cheap scores 2/3, 1 and 1/3. Delta -1/3, half-width t(2) · sqrt(1/27) = 0.828.
    // With margin 0.6 the advice is ceil(3 · (0.828 / (0.6 - 1/3))² - 3) = 26 epochs.
    const one = [
      ...[1, 2, 3].map((e) => sample("baseline", "f1", e, ALL, { costUsd: 0.1 })),
      sample("cheap", "f1", 1, ["has-plan", "clear", "deep", "no-dup"], { costUsd: 0.01 }),
      sample("cheap", "f1", 2, ALL, { costUsd: 0.01 }),
      sample("cheap", "f1", 3, ["has-plan"], { costUsd: 0.01 }),
    ];
    const summaries = summarize(one, criteria, contestants, 0.6);
    expect(summaries[1].verdict).toBe("inconclusive");
    const report = renderReport({ task: "allocate", summaries, samples: one, criteria, checked: checkedAll, run: { ...run, margin: 0.6 } });
    expect(report).toContain("- cheap: about 26 more epochs would settle it");
  });

  it("advises how many more fixtures would settle an inconclusive contestant on several", () => {
    // Three fixtures, cheap a little below the baseline on two of them and level on one: delta -0.05, wide interval.
    const mixed = ["f1", "f2", "f3"].flatMap((f, i) => [
      sample("baseline", f, 1, ALL, { costUsd: 0.1 }),
      sample("cheap", f, 1, i === 0 ? ALL : ["has-plan", "clear", "deep", "no-dup"], { costUsd: 0.01 }),
    ]);
    const summaries = summarize(mixed, criteria, contestants, 0.5);
    expect(summaries[1].verdict).toBe("inconclusive");
    const report = renderReport({ task: "allocate", summaries, samples: mixed, criteria, checked: checkedAll, run: { ...run, margin: 0.5 } });
    // Deltas 0, -1/3, -1/3: mean -2/9, half-width 0.478; with margin 0.5, ceil(3 · (0.478 / (0.5 - 2/9))² - 3) = 6, counted in fixtures.
    expect(report).toContain("- cheap: about 6 more fixtures would settle it");
    expect(report).not.toContain("more epochs");
  });

  it("shows completion 0 and n/a for an all-void contestant, with no NaN", () => {
    const voided: Gate = { status: "void", reason: "timeout" };
    const mixed = [sample("baseline", "f1", 1, ALL), sample("cheap", "f1", 1, [], { gate: voided, results: [] })];
    const report = render(mixed, new Map());
    expect(report).toContain("| cheap | inconclusive | n/a | n/a | n/a | n/a | n/a |");
    expect(report).not.toMatch(/NaN|Infinity/);
  });

  it("renders without samples or contestants without NaN", () => {
    const empty = renderReport({ task: "allocate", summaries: [], samples: [], criteria, checked: new Map(), run });
    expect(empty).not.toMatch(/NaN|Infinity/);
  });
});

describe("renderChart", () => {
  const summary = (name: string, quality: number | null, costUsd: number): ContestantSummary => ({
    name,
    models: {},
    verdict: "inconclusive",
    quality: quality === null ? null : { mean: quality, low: quality - 0.1, high: quality + 0.1, n: 3, oneFixture: false },
    codeOnly: null,
    delta: null,
    completion: 1,
    passHat3: null,
    costUsd,
    p50Ms: 0,
    p90Ms: 0,
    groups: {},
    criteria: {},
    voids: 0,
    unjudged: 0,
    judgeDependent: false,
  });

  it("draws a labelled dot per contestant with a quality score, axes labelled, and the frontier joined", () => {
    const svg = renderChart([summary("a", 0.9, 0.05), summary("b", 0.6, 0.01), summary("c", 0.5, 0.04), summary("d", null, 0.02)]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("cost per sample (USD)");
    expect(svg).toContain(">quality<");
    expect(svg.match(/<circle/g)).toHaveLength(3);
    expect(svg).toContain(">a<");
    expect(svg).not.toContain(">d<");
    // a and b are on the frontier, c is beaten by b.
    expect(svg.match(/<polyline points="([^"]+)"/)![1].split(" ")).toHaveLength(2);
  });

  it("escapes names", () => {
    expect(renderChart([summary("a<b&c", 0.5, 0.1)])).toContain("a&lt;b&amp;c");
  });

  it("does not throw on zero or one contestant, or equal or zero costs", () => {
    for (const input of [[], [summary("a", 0.5, 0.1)], [summary("a", 0.5, 0.1), summary("b", 0.7, 0.1)], [summary("a", 0.5, 0), summary("b", 0.7, 0)]]) {
      const svg = renderChart(input);
      expect(svg).toContain("</svg>");
      expect(svg).not.toMatch(/NaN|Infinity/);
    }
  });
});
