/**
 * Arm A (our search and fetch) against arm C (Anthropic's server-side web tools): the W7 source-fidelity delta.
 * Same model, same gate, same drafting code; only research differs.
 *
 *   npx tsx evals/research/compare.ts --first                  one record through both arms once, to measure cost
 *   npx tsx evals/research/compare.ts --full --runs 3          the whole golden v3 set; only once that cost is approved
 *
 * Options: --records id,id  --arms A,C  --runs N  --route gateway|direct  --out path
 * Env (.env.local): AI_GATEWAY_API_KEY; TAVILY_API_KEY for arm A; ANTHROPIC_API_KEY with --route direct.
 * Output: a JSON file with every run's metrics, materials, dropped candidates and plan, ready for the rubric judges
 * (accuracy, coverage, source fidelity, materials fit), and a summary with the pre-registered decision rule.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "dotenv";
import type { GenerationLogRow, ModelCall } from "@/lib/ai/logged";
import { streamPlanDraft } from "@/lib/ai/planDraft";
import { createAgentArm, type ResearchArm } from "@/lib/ai/research/agent";
import { researchMaterials, type ResearchOutcome } from "@/lib/ai/research/pipeline";
import { searchProviderFromEnv } from "@/lib/ai/research/tools";
import type { PlanNode } from "@/lib/planTree";
import { GOLDEN_V3, type ResearchGoldenRecord } from "./golden.v3";
import { decide, pct, runMetrics, summarize, type ArmName, type RunMetrics } from "./metrics";
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

function armFor(name: ArmName): ResearchArm {
  if (name === "A") {
    const provider = searchProviderFromEnv();
    if (!provider) throw new Error("Arm A needs TAVILY_API_KEY");
    return createAgentArm({ provider });
  }
  return createProviderArm({ route: values.route === "direct" ? "direct" : "gateway" });
}

interface RunRecord {
  metrics: RunMetrics;
  materials: ResearchOutcome["materials"];
  dropped: ResearchOutcome["dropped"];
  plan: PlanNode | null;
  facts: string[];
}

async function runOnce(record: ResearchGoldenRecord, arm: ArmName, run: number): Promise<RunRecord> {
  const calls: ModelCall[] = [];
  const rows: GenerationLogRow[] = [];
  const log = { onLog: (row: GenerationLogRow) => void rows.push(row), onCall: (call: ModelCall) => void calls.push(call) };
  const started = performance.now();

  const research = researchMaterials({ brief: { ...record.input }, arm: armFor(arm), log });
  let next = await research.next();
  while (!next.done) next = await research.next();
  const outcome = next.value;

  let plan: PlanNode | null = null;
  for await (const event of streamPlanDraft({ ...record.input, materials: outcome.materials, log })) {
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
    extraCostUsd: arm === "C" ? (outcome.arm?.counts.searches ?? 0) * WEB_SEARCH_USD : 0,
  });
  return { metrics, materials: outcome.materials, dropped: outcome.dropped, plan, facts: calls.flatMap((c) => c.facts.map((f) => `${c.label}: ${f}`)) };
}

async function main() {
  const records = pickRecords();
  const arms = values.arms!.split(",").map((a) => a.trim().toUpperCase()) as ArmName[];
  const runs = values.first ? 1 : Math.max(1, Number(values.runs));
  const results: RunRecord[] = [];
  // Fail before spending anything when an arm's keys are missing.
  for (const arm of arms) armFor(arm);

  for (const record of records) {
    for (const arm of arms) {
      for (let run = 1; run <= runs; run++) {
        process.stdout.write(`${record.id} · arm ${arm} · run ${run} … `);
        try {
          const result = await runOnce(record, arm, run);
          results.push(result);
          const m = result.metrics;
          console.log(`verified ${m.verified}/${m.proposed}, backbone ${m.backboneHit ?? "—"}, $${m.costUsd.toFixed(3)}, ${(m.latencyMs / 1000).toFixed(0)} s`);
        } catch (error) {
          console.log(`failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const all = results.map((r) => r.metrics);
  const summaries = arms.map((arm) => summarize(arm, all));
  console.log("\narm  runs  verified  backbone  mustInclude  recency  unknownRefs  overBudget  regressions  cost/run  latency  searches  reads");
  for (const s of summaries) {
    console.log(
      [s.arm.padEnd(4), String(s.runs).padEnd(5), pct(s.verifiedRate).padEnd(9), pct(s.backboneHit).padEnd(9), pct(s.mustIncludeRecall).padEnd(12), pct(s.recency).padEnd(8),
        (s.unknownRefs ?? 0).toFixed(1).padEnd(12), (s.overBudgetLeaves ?? 0).toFixed(1).padEnd(11), (s.chapterRegressions ?? 0).toFixed(1).padEnd(12),
        `$${(s.costUsd ?? 0).toFixed(3)}`.padEnd(9), `${((s.latencyMs ?? 0) / 1000).toFixed(0)} s`.padEnd(8), (s.searches ?? 0).toFixed(1).padEnd(9), (s.fetches ?? 0).toFixed(1)].join(" "),
    );
  }
  const a = summaries.find((s) => s.arm === "A");
  const c = summaries.find((s) => s.arm === "C");
  if (a && c) {
    const d = decide(a, c);
    console.log(`\nDecision (code metrics): ${d.keepA ? "arm A stays the default" : "arm C is ahead"}: ${d.reasons.join("; ")}.`);
    console.log("Complete the rule with the judges' scores for accuracy, coverage, source fidelity and materials fit.");
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
