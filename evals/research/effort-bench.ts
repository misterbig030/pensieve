/**
 * Runs the whole research phase (workers, candidate step, gate) for one brief at several reasoning-effort levels on
 * the research model, outside the app: the same code path as a draft, nothing written to the database.
 *
 *   npx tsx evals/research/effort-bench.ts --export ~/Downloads/model-calls-<ts>.json --dry-run
 *   npx tsx evals/research/effort-bench.ts --export ~/Downloads/model-calls-<ts>.json --efforts low,medium,high
 *   npx tsx evals/research/effort-bench.ts --topic "AI engineer interview preparation" --days 90 --hours 6
 *
 * Options: --efforts a,b  --arm W|A  --out path. Env (.env.local): AI_GATEWAY_API_KEY, TAVILY_API_KEY.
 * Output: one block per effort (workers, candidate step, gate, list) and a JSON file with every call and every list.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "dotenv";
import type { ModelCall } from "@/lib/ai/logged";
import { AVAILABLE_MODELS, DEFAULT_RESEARCH_MODEL, type AiModelId } from "@/lib/ai/models";
import { createAgentArm, type ResearchArm, type ResearchBrief } from "@/lib/ai/research/agent";
import { researchMaterials, type ResearchOutcome } from "@/lib/ai/research/pipeline";
import { searchProviderFromEnv } from "@/lib/ai/research/tools";
import { createWorkersArm } from "@/lib/ai/research/workers";
import { EFFORTS, type Effort, type ExportedCall, briefFromPrompt, pickCall } from "./bench";

config({ path: ".env.local" });

const { values } = parseArgs({
  options: {
    export: { type: "string" },
    topic: { type: "string" },
    days: { type: "string" },
    hours: { type: "string" },
    efforts: { type: "string", default: "low,medium,high" },
    model: { type: "string", default: DEFAULT_RESEARCH_MODEL },
    arm: { type: "string", default: "W" },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const SECTIONS = ["The learner's sources:", "Backbone research:", "Canonical materials:", "Canonical and recent material:", "Recent material:", "Now list the materials."];

/** Which sections of the candidate prompt carry a worker's written notes. */
function notesWritten(prompt: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const heading of SECTIONS.slice(0, -1)) {
    const start = prompt.indexOf(heading);
    if (start < 0) continue;
    const ends = SECTIONS.filter((h) => h !== heading).map((h) => prompt.indexOf(h, start + heading.length)).filter((i) => i > start);
    const end = ends.length > 0 ? Math.min(...ends) : prompt.length;
    out[heading.replace(/:$/, "")] = prompt.slice(start, end).includes("Your notes while researching:");
  }
  return out;
}

function brief(): ResearchBrief {
  if (values.export) {
    const calls = JSON.parse(readFileSync(values.export, "utf8")) as ExportedCall[];
    return briefFromPrompt(pickCall(calls, "Research · candidates").prompt);
  }
  if (!values.topic || !values.days) throw new Error("Pass --export <model-calls JSON>, or --topic and --days (and --hours)");
  return { topic: values.topic, days: Number(values.days), hoursPerWeek: values.hours ? Number(values.hours) : undefined, sources: [] };
}

interface EffortRun {
  effort: Effort;
  researchMs: number;
  costUsd: number;
  stoppedBy: string | null;
  counts: { steps: number; searches: number; fetches: number } | null;
  workers: NonNullable<ResearchOutcome["arm"]>["workers"] | null;
  notes: Record<string, boolean>;
  candidateStep: { latencyMs: number; outputTokens: number | null; reasoningTokens: number | null } | null;
  proposed: number;
  verified: number;
  materials: ResearchOutcome["materials"];
  dropped: ResearchOutcome["dropped"];
  coverage: ResearchOutcome["coverage"];
  calls: Omit<ModelCall, "prompt" | "system">[];
  candidatePrompt: string | null;
  candidateResponse: string | null;
}

async function runAt(effort: Effort, b: ResearchBrief, model: AiModelId): Promise<EffortRun> {
  const provider = searchProviderFromEnv();
  if (!provider) throw new Error("TAVILY_API_KEY is not set (.env.local)");
  const arm: ResearchArm = values.arm === "A" ? createAgentArm({ provider, effort, model }) : createWorkersArm({ provider, effort, model });
  const calls: ModelCall[] = [];
  const started = performance.now();
  const gen = researchMaterials({ brief: b, arm, log: { onCall: (c) => void calls.push(c) } });
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  const outcome = next.value;
  const researchMs = Math.round(performance.now() - started);
  const candidates = calls.find((c) => c.label === "Research · candidates");
  return {
    effort,
    researchMs,
    costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
    stoppedBy: outcome.arm?.stoppedBy ?? null,
    counts: outcome.arm?.counts ?? null,
    workers: outcome.arm?.workers ?? null,
    notes: candidates ? notesWritten(candidates.prompt) : {},
    candidateStep: candidates ? { latencyMs: candidates.latencyMs, outputTokens: candidates.outputTokens, reasoningTokens: candidates.reasoningTokens } : null,
    proposed: outcome.proposed,
    verified: outcome.verified,
    materials: outcome.materials,
    dropped: outcome.dropped,
    coverage: outcome.coverage,
    calls: calls.map((c) => Object.fromEntries(Object.entries(c).filter(([key]) => key !== "prompt" && key !== "system")) as Omit<ModelCall, "prompt" | "system">),
    candidatePrompt: candidates?.prompt ?? null,
    candidateResponse: candidates?.response ?? null,
  };
}

function report(r: EffortRun) {
  console.log(`\n=== effort ${r.effort}: research ${(r.researchMs / 1000).toFixed(1)} s, $${r.costUsd.toFixed(3)}, stopped by ${r.stoppedBy}`);
  for (const w of r.workers ?? []) console.log(`  ${w.direction.padEnd(9)} ${w.steps} steps, ${w.searches} searches, ${w.fetches} reads, ${w.stoppedBy}; notes written: ${r.notes[w.direction === "backbone" ? "Backbone research" : w.direction === "canonical" ? ("Canonical materials" in r.notes ? "Canonical materials" : "Canonical and recent material") : "Recent material"] ? "yes" : "no"}`);
  if (r.candidateStep) console.log(`  candidates: ${(r.candidateStep.latencyMs / 1000).toFixed(1)} s, ${r.candidateStep.outputTokens} out, ${r.candidateStep.reasoningTokens ?? 0} reasoning`);
  console.log(`  gate: ${r.verified}/${r.proposed} verified${r.dropped.length ? `; dropped: ${r.dropped.map((d) => `"${d.title}" (${d.reason})`).join(", ")}` : ""}`);
  for (const m of r.materials) console.log(`    [${m.kind}${m.backbone ? " · backbone" : ""}] "${m.title}" <${m.url}>${m.minutes ? ` · ${m.minutes} min` : ""}`);
  for (const c of r.calls) console.log(`    ${c.label.padEnd(34)} ${(c.latencyMs / 1000).toFixed(1).padStart(6)} s  out ${String(c.outputTokens).padStart(5)}  reason ${String(c.reasoningTokens ?? 0).padStart(5)}  $${c.costUsd.toFixed(4)}  ${c.facts.join(" · ")}`);
}

async function main() {
  const b = brief();
  const efforts = values.efforts!.split(",").map((e) => e.trim()) as Effort[];
  for (const e of efforts) if (!EFFORTS.includes(e)) throw new Error(`Unknown effort ${e}; use ${EFFORTS.join(", ")}`);
  if (values.arm !== "W" && values.arm !== "A") throw new Error("--arm is W or A");
  const model = values.model as AiModelId;
  if (!AVAILABLE_MODELS.some((m) => m.id === model)) throw new Error(`Unknown model ${values.model}; use one of ${AVAILABLE_MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Brief: "${b.topic}", ${b.days} days at ${b.hoursPerWeek ?? "default"} hours a week. Arm ${values.arm} on ${model} at ${efforts.join(", ")}.`);
  console.log(`${efforts.length} full research runs, one per effort, in sequence. On Sonnet 5.5 a run cost $0.08 at low and $0.17 at high; Opus 5.5 is twice the price per token.`);
  if (values["dry-run"]) {
    console.log("Dry run: nothing was called.");
    return;
  }
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is not set (.env.local)");

  const runs: EffortRun[] = [];
  for (const effort of efforts) {
    process.stdout.write(`\neffort ${effort} … `);
    try {
      const r = await runAt(effort, b, model);
      runs.push(r);
      console.log("done");
      report(r);
    } catch (error) {
      console.log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\neffort   research   cost    reads  candidates  reasoning  verified  notes(backbone)`);
  for (const r of runs) console.log(`${r.effort.padEnd(8)} ${(r.researchMs / 1000).toFixed(1).padStart(6)} s  $${r.costUsd.toFixed(3)}  ${String(r.counts?.fetches ?? "—").padStart(5)}  ${r.candidateStep ? `${(r.candidateStep.latencyMs / 1000).toFixed(1).padStart(8)} s` : "        —"}  ${String(r.candidateStep?.reasoningTokens ?? 0).padStart(9)}  ${`${r.verified}/${r.proposed}`.padStart(8)}  ${r.notes["Backbone research"] ? "yes" : "no"}`);

  const out = values.out ?? path.join("evals", "results", `effort-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), brief: b, arm: values.arm, model, efforts, runs }, null, 2));
  console.log(`\nWrote ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
