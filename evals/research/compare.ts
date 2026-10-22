/**
 * Arm A (our search and fetch, one loop) against arm C (Anthropic's server-side web tools) and arm W (one worker per
 * research direction, concurrently). Same model, same gate, same drafting code; only research differs.
 *
 *   npx tsx evals/research/compare.ts --first                      one record through A and C once, to measure cost
 *   npx tsx evals/research/compare.ts --first --arms A,W           the same for arm W
 *   npx tsx evals/research/compare.ts --full --runs 3 --arms A,W   the whole golden v3 set; only once that cost is approved
 *
 * Options: --records id,id  --arms A,C,W  --runs N  --route gateway|direct  --out path
 * Env (.env.local): AI_GATEWAY_API_KEY; TAVILY_API_KEY for arms A and W; ANTHROPIC_API_KEY with --route direct.
 * Output: a JSON file with every run's metrics, materials, dropped candidates and plan, ready for the rubric judges
 * (accuracy, coverage, source fidelity, materials fit), and a summary with the pre-registered decision rule.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "dotenv";
import type { GenerationLogRow, ModelCall } from "@/lib/ai/logged";
import { DEFAULT_OUTLINE_MODEL } from "@/lib/ai/models";
import { streamPlanDraft } from "@/lib/ai/planDraft";
import { pickPractice } from "@/lib/ai/practicePick";
import { appModel } from "@/lib/ai/resolve";
import { createAgentArm, type ResearchArm } from "@/lib/ai/research/agent";
import { researchMaterials, type ResearchOutcome } from "@/lib/ai/research/pipeline";
import { searchProviderFromEnv } from "@/lib/ai/research/tools";
import { createWorkersArm } from "@/lib/ai/research/workers";
import type { PlanNode } from "@/lib/planTree";
import type { PlanSplit } from "@/lib/studyTime";
import { draftRequestOf } from "../golden/plan.v1";
import { GOLDEN_V3, type ResearchGoldenRecord } from "./golden.v3";
import { decide, decideWorkers, pct, runMetrics, summarize, type ArmName, type RunMetrics } from "./metrics";
import { WEB_SEARCH_USD, createProviderArm } from "./providerArm";

config({ path: ".env.local" });

const { values } = parseArgs({
  options: {
    first: { type: "boolean", default: false },
    full: { type: "boolean", default: false },
    records: { type: "string" },
    arms: { type: "string", default: "A,C" },
    runs: { type: "string", default: "3" },
    route: { type: "string", default: "gateway" },
    out: { type: "string" },
  },
});

function pickRecords(): ResearchGoldenRecord[] {
  if (values.records) {
    const ids = values.records.split(",").map((s) => s.trim());
    const found = GOLDEN_V3.filter((r) => ids.includes(r.id));
    if (found.length !== ids.length) throw new Error(`Unknown record id in --records: ${ids.filter((id) => !found.some((r) => r.id === id)).join(", ")}`);
    return found;
  }
  if (values.first) return [GOLDEN_V3[0]];
  if (values.full) return GOLDEN_V3;
  throw new Error("Pass --first to measure one record, --records to pick some, or --full once the cost is approved.");
}

const ARM_NAMES: ArmName[] = ["A", "C", "W"];

function armFor(name: ArmName): ResearchArm {
  if (name === "A" || name === "W") {
    const provider = searchProviderFromEnv();
    if (!provider) throw new Error(`Arm ${name} needs TAVILY_API_KEY`);
    return name === "A" ? createAgentArm({ provider }) : createWorkersArm({ provider });
  }
  return createProviderArm({ route: values.route === "direct" ? "direct" : "gateway" });
}

interface RunRecord {
  metrics: RunMetrics;
  materials: ResearchOutcome["materials"];
  dropped: ResearchOutcome["dropped"];
  plan: PlanNode | null;
  /** How the drafter divided the learner's time, for the judges (rubric dimension 5). */
  split: PlanSplit | null;
  coverage: ResearchOutcome["coverage"];
  facts: string[];
}

async function runOnce(record: ResearchGoldenRecord, arm: ArmName, run: number): Promise<RunRecord> {
  const calls: ModelCall[] = [];
  const rows: GenerationLogRow[] = [];
  const log = { onLog: (row: GenerationLogRow) => void rows.push(row), onCall: (call: ModelCall) => void calls.push(call) };
  const started = performance.now();

  const input = draftRequestOf(record.input);
  // The practice is picked before research, as in the app, and the draft below keeps that split.
  const picked = await pickPractice({ ...input, model: appModel(DEFAULT_OUTLINE_MODEL), log });
  const research = researchMaterials({ brief: { ...input, split: picked.split }, arm: armFor(arm), log });
  let next = await research.next();
  while (!next.done) next = await research.next();
  const outcome = next.value;
  const researchMs = Math.round(performance.now() - started);

  let plan: PlanNode | null = null;
  const split: PlanSplit = picked.split;
  for await (const event of streamPlanDraft({ ...input, split, materials: outcome.materials, log })) {
    if (event.type === "finish") plan = event.root;
  }

  const metrics = runMetrics({
    record,
    arm,
    run,
    outcome,
    calls,
    rows,
    latencyMs: Math.round(performance.now() - started),
    researchMs,
    extraCostUsd: arm === "C" ? (outcome.arm?.counts.searches ?? 0) * WEB_SEARCH_USD : 0,
  });
  return { metrics, materials: outcome.materials, dropped: outcome.dropped, plan, split, coverage: outcome.coverage, facts: calls.flatMap((c) => c.facts.map((f) => `${c.label}: ${f}`)) };
}

async function main() {
  const records = pickRecords();
  const arms = values.arms!.split(",").map((a) => a.trim().toUpperCase()) as ArmName[];
  const runs = values.first ? 1 : Math.max(1, Number(values.runs));
  const results: RunRecord[] = [];
  // Fail before spending anything when an arm is unknown or its keys are missing.
  for (const arm of arms) if (!ARM_NAMES.includes(arm)) throw new Error(`Unknown arm ${arm}; use ${ARM_NAMES.join(", ")}`);
  for (const arm of arms) armFor(arm);

  for (const record of records) {
    for (const arm of arms) {
      for (let run = 1; run <= runs; run++) {
        process.stdout.write(`${record.id} · arm ${arm} · run ${run} … `);
        try {
          const result = await runOnce(record, arm, run);
          results.push(result);
          const m = result.metrics;
          const time = result.split ? `, split ${result.split.readingShare}% reading / ${result.split.practice}` : "";
          const who = m.workers ? `, workers ${m.workers.map((w) => `${w.direction.slice(0, 3)}:${w.steps}/${w.stoppedBy}`).join(" ")}` : "";
          console.log(`verified ${m.verified}/${m.proposed}, backbone ${m.backboneHit ?? "—"}, sized ${m.sizedHours} of ${m.totalHours} h (${pct(m.measuredShare)} measured)${time}${who}, $${m.costUsd.toFixed(3)}, ${(m.latencyMs / 1000).toFixed(0)} s (research ${(m.researchMs / 1000).toFixed(0)} s)`);
        } catch (error) {
          console.log(`failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const all = results.map((r) => r.metrics);
  const summaries = arms.map((arm) => summarize(arm, all));
  console.log("\narm  runs  verified  backbone  mustInclude  recency  unknownRefs  overBudget  regressions  cost/run  latency  research  dup   searches  reads");
  for (const s of summaries) {
    console.log(
      [s.arm.padEnd(4), String(s.runs).padEnd(5), pct(s.verifiedRate).padEnd(9), pct(s.backboneHit).padEnd(9), pct(s.mustIncludeRecall).padEnd(12), pct(s.recency).padEnd(8),
        (s.unknownRefs ?? 0).toFixed(1).padEnd(12), (s.overBudgetLeaves ?? 0).toFixed(1).padEnd(11), (s.chapterRegressions ?? 0).toFixed(1).padEnd(12),
        `$${(s.costUsd ?? 0).toFixed(3)}`.padEnd(9), `${((s.latencyMs ?? 0) / 1000).toFixed(0)} s`.padEnd(8), `${((s.researchMedianMs ?? 0) / 1000).toFixed(0)} s`.padEnd(9),
        (s.duplicateShare === null ? "—" : pct(s.duplicateShare)).padEnd(5), (s.searches ?? 0).toFixed(1).padEnd(9), (s.fetches ?? 0).toFixed(1)].join(" "),
    );
  }
  const a = summaries.find((s) => s.arm === "A");
  const c = summaries.find((s) => s.arm === "C");
  if (a && c) {
    const d = decide(a, c);
    console.log(`\nDecision (code metrics): ${d.keepA ? "arm A stays the default" : "arm C is ahead"}: ${d.reasons.join("; ")}.`);
    console.log("Complete the rule with the judges' scores for accuracy, coverage, source fidelity and materials fit.");
  }
  const w = summaries.find((s) => s.arm === "W");
  if (a && w) {
    const d = decideWorkers(a, w);
    console.log(`\nDecision (arm W rule): ${d.adoptW ? "adopt arm W as the default" : "arm A stays the default"}: ${d.reasons.join("; ")}.`);
  }
  if (values.first && all.length === arms.length) {
    const total = all.reduce((sum, m) => sum + m.costUsd, 0);
    const perRecord = total / Math.max(1, records.length);
    console.log(`\nMeasured: $${total.toFixed(3)} for one record through ${arms.join(" and ")}. The full run (${GOLDEN_V3.length} records × ${arms.length} arms × 3 runs) would cost about $${(perRecord * GOLDEN_V3.length * 3).toFixed(2)}.`);
  }

  const out = values.out ?? path.join("evals", "results", `research-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), arms, runs, summaries, results }, null, 2));
  console.log(`\nWrote ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
