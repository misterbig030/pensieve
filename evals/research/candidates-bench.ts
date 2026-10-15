/**
 * Replays one recorded candidate-step prompt on several models at several effort levels and reports latency,
 * tokens, cost and a few cheap checks on each list. Same schema, same route (the gateway) as the app, so the
 * numbers are the app's numbers; only the prompt is frozen.
 *
 *   npx tsx evals/research/candidates-bench.ts --export ~/Downloads/model-calls-<ts>.json --dry-run
 *   npx tsx evals/research/candidates-bench.ts --export ~/Downloads/model-calls-<ts>.json
 *
 * Options: --models a,b  --efforts low,medium,high  --label "Research · candidates"  --concurrency 3  --out path
 * Env (.env.local): AI_GATEWAY_API_KEY. Output: a table, and a JSON file with every run's object for a reader to judge.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { NoObjectGeneratedError, generateObject } from "ai";
import { config } from "dotenv";
import { candidateListSchema, mapLimit } from "@/lib/ai/research/verify";
import { type BenchRun, EFFORTS, type Effort, type ExportedCall, HEADER, PRICES, checkObject, estimateCostUsd, formatRow, pairs, pickCall } from "./bench";

config({ path: ".env.local" });

const { values } = parseArgs({
  options: {
    export: { type: "string" },
    models: { type: "string", default: "anthropic/claude-haiku-5.5,anthropic/claude-sonnet-5.5,anthropic/claude-opus-5.5,anthropic/claude-sonnet-5" },
    efforts: { type: "string", default: "low,medium,high" },
    label: { type: "string", default: "Research · candidates" },
    concurrency: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" },
  },
});

/** An upper bound for the dry run: the recorded call wrote about 11k tokens; a model that thinks longer would stop here. */
const OUTPUT_TOKENS_BOUND = 16_000;

async function runPair(model: string, effort: Effort, prompt: string, system: string | null): Promise<BenchRun> {
  const started = performance.now();
  const base = { model, effort, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, checks: null, object: null };
  try {
    const { object, usage } = await generateObject({
      model,
      schema: candidateListSchema,
      prompt,
      ...(system ? { system } : {}),
      providerOptions: { anthropic: { effort } },
    });
    const inputTokens = usage.inputTokens ?? null;
    const outputTokens = usage.outputTokens ?? null;
    return {
      ...base,
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      inputTokens,
      outputTokens,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
      costUsd: inputTokens !== null && outputTokens !== null ? estimateCostUsd(model, inputTokens, outputTokens) : null,
      checks: checkObject(object, prompt),
      object,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    if (NoObjectGeneratedError.isInstance(error)) {
      const inputTokens = error.usage?.inputTokens ?? null;
      const outputTokens = error.usage?.outputTokens ?? null;
      return {
        ...base,
        ok: false,
        error: `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`.slice(0, 200),
        latencyMs,
        inputTokens,
        outputTokens,
        reasoningTokens: error.usage?.outputTokenDetails?.reasoningTokens ?? null,
        costUsd: inputTokens !== null && outputTokens !== null ? estimateCostUsd(model, inputTokens, outputTokens) : null,
        text: error.text,
      };
    }
    return { ...base, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 200), latencyMs };
  }
}

async function main() {
  if (!values.export) throw new Error("Pass --export <path to the admin panel's model-calls JSON>");
  const models = values.models!.split(",").map((m) => m.trim()).filter(Boolean);
  const efforts = values.efforts!.split(",").map((e) => e.trim()) as Effort[];
  for (const m of models) if (!PRICES[m]) throw new Error(`Unknown model ${m}; the bench prices ${Object.keys(PRICES).join(", ")}`);
  for (const e of efforts) if (!EFFORTS.includes(e)) throw new Error(`Unknown effort ${e}; use ${EFFORTS.join(", ")}`);
  const concurrency = Math.max(1, Number(values.concurrency));

  const calls = JSON.parse(readFileSync(values.export, "utf8")) as ExportedCall[];
  const { prompt, system } = pickCall(calls, values.label!);
  const recorded = calls.find((c) => c.label === values.label);
  const promptTokens = recorded?.inputTokens ?? Math.round(prompt.length / 4);
  const matrix = pairs(models, efforts);

  const bound = matrix.reduce((sum, p) => sum + estimateCostUsd(p.model, promptTokens, OUTPUT_TOKENS_BOUND), 0);
  console.log(`Prompt: "${values.label}" from ${values.export} (${prompt.length} chars, ${promptTokens} input tokens recorded${system ? ", with system text" : ""}).`);
  console.log(`${matrix.length} calls: ${models.join(", ")} × ${efforts.join(", ")}. Cost at most about $${bound.toFixed(2)} if every call wrote ${OUTPUT_TOKENS_BOUND} tokens.`);
  if (values["dry-run"]) {
    for (const p of matrix) console.log(`  ${p.model} · ${p.effort}  ≤ $${estimateCostUsd(p.model, promptTokens, OUTPUT_TOKENS_BOUND).toFixed(3)}`);
    console.log("Dry run: nothing was called.");
    return;
  }
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is not set (.env.local)");

  const started = performance.now();
  console.log(`\n${HEADER}`);
  const runs = await mapLimit(matrix, concurrency, async (p) => {
    const run = await runPair(p.model, p.effort, prompt, system);
    console.log(formatRow(run));
    return run;
  });

  console.log(`\nIn matrix order:\n${HEADER}`);
  for (const r of runs) console.log(formatRow(r));
  const spent = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  console.log(`\nSpent $${spent.toFixed(3)} in ${((performance.now() - started) / 1000).toFixed(0)} s wall time.`);

  const out = values.out ?? path.join("evals", "results", `candidates-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), export: values.export, label: values.label, promptChars: prompt.length, promptTokens, models, efforts, runs }, null, 2));
  console.log(`Wrote ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
