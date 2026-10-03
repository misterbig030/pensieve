/**
 * Runs golden records through the real plan generators and writes each output for open coding.
 *
 *   npx tsx evals/scripts/sample-plans.ts [--trials 1] [--start 1] [--only <id substring>] [--concurrency 4]
 *
 * Output: evals/samples/<record-id>-<trial>.json (tree, rendered text, log rows) and evals/samples/_all-t<start>.md,
 * the rendered plans in one file for reading. `--start` numbers the first trial, so later runs add trials instead
 * of overwriting the ones already read. Nothing here scores an output; that is Task 4.
 *
 * Drafting only: the learner's sources become materials offline (`learnerMaterials`), research never runs and no
 * run touches the network. The research step has its own eval in `evals/research/`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import type { GenerationLogRow, ModelCall } from "@/lib/ai/logged";
import { DEFAULT_OUTLINE_MODEL } from "@/lib/ai/models";
import { streamPlanDraft } from "@/lib/ai/planDraft";
import { renderMaterials, renderTree } from "@/lib/ai/planPrompt";
import { LockedNodeError, revisePlanTree } from "@/lib/ai/planRevision";
import { aliasMaterials, learnerMaterials } from "@/lib/materials";
import { diffChangedNodes } from "@/lib/planSummary";
import { childSpans, layout, leavesOf, topSpans, type PlanNode } from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import type { SourceInput } from "@/lib/schemas/source";
import { GOLDEN_V1, isMandarin, type GoldenRecord } from "../golden/plan.v1";

config({ path: ".env.local", quiet: true });

const SAMPLES_DIR = path.join("evals", "samples");

interface Sample {
  id: string;
  trial: number;
  kind: GoldenRecord["kind"];
  model: string;
  ranAt: string;
  ok: boolean;
  /** Set when the generator threw; `LockedNodeError` is an expected outcome for some revise records. */
  error: { name: string; message: string } | null;
  input: GoldenRecord["input"];
  expect: GoldenRecord["expect"];
  /** The materials list the model drafted against: the learner's sources, unverified, as `M1…Mn`. */
  materials: Material[];
  tree: PlanNode | null;
  /** The tree as the judge reads it, with each unit's material references. */
  text: string;
  /** Revise records only: the input tree as the model saw it, and what `diffChangedNodes` reports. */
  before?: string;
  changed?: { level: string | null; tags: string[] };
  calls: GenerationLogRow[];
  /** What the generators' own checks reported per call (unknown ids, over-budget leaves, chapter order, …). */
  checkFacts: string[];
  costUsd: number;
  latencyMs: number;
  /** One-line facts for the stdout summary; not a verdict. */
  facts: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Share of CJK characters among the letters the model wrote, for spotting a Chinese request answered in English. */
function cjkShare(root: PlanNode): number {
  let text = "";
  const visit = (node: PlanNode) => {
    text += node.title + node.summary;
    node.children?.forEach(visit);
  };
  root.children?.forEach(visit);
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cjk + latin === 0 ? 0 : cjk / (cjk + latin);
}

/** Node ids that appear more than once; a valid tree has none. */
function duplicateIds(root: PlanNode): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  const visit = (node: PlanNode) => {
    if (seen.has(node.id)) dup.add(node.id);
    seen.add(node.id);
    node.children?.forEach(visit);
  };
  visit(root);
  return [...dup];
}

/** Counts along the first branch next to what the span rules asked for, e.g. "top 4/4 · week 7/7". */
function draftFacts(root: PlanNode, days: number): string {
  const parts = [`top ${root.children?.length ?? 0}/${topSpans(days).length}`];
  let node = root.children?.[0];
  while (node?.children) {
    parts.push(`${node.level} ${node.children.length}/${childSpans(node).length}`);
    node = node.children[0];
  }
  parts.push(`len ${root.len}/${days}`);
  return parts.join(" · ");
}

/** The record's input as the generators take it: `sources` replaced by the materials list built from them. */
function withMaterials<T extends { sources: SourceInput[] }>(input: T, materials: Material[]): Omit<T, "sources"> & { materials: Material[] } {
  const rest = { ...input } as Omit<T, "sources"> & { sources?: SourceInput[] };
  delete rest.sources;
  return { ...rest, materials };
}

async function runOne(record: GoldenRecord, trial: number): Promise<Sample> {
  const calls: GenerationLogRow[] = [];
  const checkFacts: string[] = [];
  const log = {
    onLog: (row: GenerationLogRow) => void calls.push(row),
    onCall: (call: ModelCall) => checkFacts.push(...call.facts.map((f) => `${call.label}: ${f}`)),
  };
  const materials = learnerMaterials(record.input.sources);
  const aliases = aliasMaterials(materials);
  const startedAt = performance.now();
  const base = {
    id: record.id,
    trial,
    kind: record.kind,
    model: DEFAULT_OUTLINE_MODEL,
    ranAt: new Date().toISOString(),
    input: record.input,
    expect: record.expect,
    materials,
  };
  let tree: PlanNode | null = null;
  let error: Sample["error"] = null;
  let before: string | undefined;
  let changed: Sample["changed"];
  let facts = "";

  try {
    if (record.kind === "draft") {
      for await (const event of streamPlanDraft({ ...withMaterials(record.input, materials), log })) {
        if (event.type === "finish") tree = event.root;
        if (event.type === "error") throw new Error(event.message);
      }
      if (!tree) throw new Error("streamPlanDraft ended without a finish event");
      facts = draftFacts(tree, record.input.days);
      if (isMandarin(record)) facts += ` · cjk ${Math.round(cjkShare(tree) * 100)}%`;
    } else {
      const original = layout(record.input.tree);
      before = renderTree(original, { lockBefore: record.input.lockBefore, aliases });
      const result = await revisePlanTree({ ...withMaterials(record.input, materials), log });
      tree = result.tree;
      const diff = diffChangedNodes(original, tree);
      changed = { level: diff.level, tags: diff.tags };
      facts = `changed ${diff.level ?? "nothing"} [${diff.tags.join(", ")}] · len ${original.len}→${tree.len} · leaves ${leavesOf(original).length}→${leavesOf(tree).length}`;
      const dup = duplicateIds(tree);
      if (dup.length > 0) facts += ` · DUPLICATE IDS ${dup.join(",")}`;
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    error = { name: err instanceof LockedNodeError ? "LockedNodeError" : err.name, message: err.message };
    facts = `${error.name}: ${error.message.slice(0, 100)}`;
  }
  if (checkFacts.length > 0) facts += ` · checks ${checkFacts.length}`;

  return {
    ...base,
    ok: error === null,
    error,
    tree,
    text: tree ? renderTree(tree, { aliases, ...(record.kind === "revise" ? { lockBefore: record.input.lockBefore } : {}) }) : "",
    before,
    changed,
    calls,
    checkFacts,
    costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
    latencyMs: Math.round(performance.now() - startedAt),
    facts,
  };
}

function describeInput(record: GoldenRecord, materials: Material[]): string {
  const lines: string[] = [];
  if (record.kind === "revise") lines.push(`Request: ${record.input.changeRequest} (lockBefore ${record.input.lockBefore})`);
  else {
    const { topic, days, granularity, instructions } = record.input;
    lines.push(`Topic: ${topic} · ${days} days · unit ${granularity}`);
    if (instructions) lines.push(`Instructions: ${instructions}`);
  }
  if (materials.length > 0) lines.push("Materials (as the model saw them):", renderMaterials(materials));
  return lines.join("\n");
}

function toMarkdown(record: GoldenRecord, sample: Sample): string {
  const parts = [`## ${sample.id} · trial ${sample.trial}`, "", `> ${record.why}`, "", describeInput(record, sample.materials), "", `Facts: ${sample.facts} · $${sample.costUsd.toFixed(4)} · ${(sample.latencyMs / 1000).toFixed(1)}s`];
  if (sample.checkFacts.length > 0) parts.push("", "Checks:", ...sample.checkFacts.map((f) => `- ${f}`));
  if (sample.before) parts.push("", "Before:", "```", sample.before, "```", "After:");
  parts.push("```", sample.text || "(no tree)", "```", "");
  return parts.join("\n");
}

async function main() {
  const trials = Number(arg("trials") ?? 1);
  const start = Number(arg("start") ?? 1);
  const only = arg("only");
  const concurrency = Number(arg("concurrency") ?? 4);
  const records = GOLDEN_V1.filter((r) => !only || r.id.includes(only));
  const jobs = records.flatMap((record) => Array.from({ length: trials }, (_, i) => ({ record, trial: start + i })));
  await mkdir(SAMPLES_DIR, { recursive: true });
  console.log(`${jobs.length} runs · model ${DEFAULT_OUTLINE_MODEL} · concurrency ${concurrency}`);

  const done: { record: GoldenRecord; sample: Sample }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { record, trial } = jobs[next++];
      const sample = await runOne(record, trial);
      await writeFile(path.join(SAMPLES_DIR, `${sample.id}-${trial}.json`), JSON.stringify(sample, null, 2));
      done.push({ record, sample });
      console.log(`${sample.ok ? "ok " : "ERR"} ${`${sample.id}-${trial}`.padEnd(34)} ${sample.facts} · $${sample.costUsd.toFixed(4)} · ${(sample.latencyMs / 1000).toFixed(1)}s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const order = new Map(GOLDEN_V1.map((r, i) => [r.id, i]));
  done.sort((a, b) => order.get(a.record.id)! - order.get(b.record.id)! || a.sample.trial - b.sample.trial);
  await writeFile(path.join(SAMPLES_DIR, `_all-t${start}.md`), done.map((d) => toMarkdown(d.record, d.sample)).join("\n"));

  const cost = done.reduce((sum, d) => sum + d.sample.costUsd, 0);
  const calls = done.reduce((sum, d) => sum + d.sample.calls.length, 0);
  console.log(`\n${done.length} outputs · ${calls} model calls · $${cost.toFixed(4)} · ${done.filter((d) => !d.sample.ok).length} threw`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
