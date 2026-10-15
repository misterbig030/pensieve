/**
 * Helpers for `candidates-bench.ts`: one recorded candidate-step prompt replayed on several models at several
 * effort levels. Pure functions, so the CLI stays thin and this file is what the tests cover.
 */
import { z } from "zod";
import type { ResearchBrief } from "@/lib/ai/research/agent";
import { candidateListSchema } from "@/lib/ai/research/verify";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** List prices per million tokens through the gateway (Oct 2026). Output includes reasoning tokens. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10 },
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10 },
  "anthropic/claude-opus-5.5": { input: 4, output: 20 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for ${model}; add it to PRICES in evals/research/bench.ts`);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ---------------------------------------------------------------------------------------------------------------
// The recorded call

/** One entry of the admin panel's model-calls export. Only the fields the bench reads. */
export interface ExportedCall {
  label?: string;
  prompt?: unknown;
  system?: unknown;
  inputTokens?: number | null;
}

export interface RecordedCall {
  prompt: string;
  system: string | null;
}

/** The prompt and system text of the call with this label; the candidate step's prompt is a single string. */
export function pickCall(calls: ExportedCall[], label: string): RecordedCall {
  const call = calls.find((c) => c.label === label);
  if (!call) throw new Error(`No call labelled "${label}" in the export (labels: ${calls.map((c) => c.label).join(", ")})`);
  if (typeof call.prompt !== "string") throw new Error(`The "${label}" call's prompt is not text; the bench replays single-prompt calls only`);
  return { prompt: call.prompt, system: typeof call.system === "string" && call.system.length > 0 ? call.system : null };
}

/**
 * The brief a recorded candidate prompt was built from: its topic and plan length. Sources and instructions are not
 * recovered; a brief with either is not what this reads.
 */
export function briefFromPrompt(prompt: string): ResearchBrief {
  const topic = prompt.match(/^Topic: (.+)$/m)?.[1]?.trim();
  const plan = prompt.match(/^Plan length: (\d+) days at about (\d+) hours? a week/m);
  if (!topic || !plan) throw new Error('The prompt has no "Topic:" and "Plan length:" header to rebuild the brief from');
  return { topic, days: Number(plan[1]), hoursPerWeek: Number(plan[2]), sources: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// What the notes can vouch for

function canonical(url: string): string | null {
  try {
    const u = new URL(url.replace(/[>)\].,;:'"]+$/, ""));
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Every URL that appears anywhere in the prompt, read or not. */
export function notesUrls(prompt: string): Set<string> {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const c = canonical(m[0]);
    if (c) out.add(c);
  }
  return out;
}

/** url (and final url) → the title the notes recorded for each page that was read. */
export function readTitles(prompt: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of prompt.matchAll(/^Read <([^>]+)>(?: → <([^>]+)>)?: title "([^"]*)"/gm)) {
    const [, url, finalUrl, title] = m;
    for (const u of [url, finalUrl]) {
      const c = u ? canonical(u) : null;
      if (c) out.set(c, title);
    }
  }
  return out;
}

/** The hour cap the instructions state, when they do. */
export function hoursCap(prompt: string): number | null {
  const m = prompt.match(/must not exceed (\d+) hours/);
  return m ? Number(m[1]) : null;
}

export type CandidateList = z.infer<typeof candidateListSchema>;

export interface ObjectChecks {
  candidates: number;
  backbones: number;
  backboneIsBook: boolean;
  totalMinutes: number;
  unsized: number;
  overCap: boolean;
  /** Candidate URLs that appear nowhere in the notes (allowed for a book's publisher page, suspect otherwise). */
  urlsOutsideNotes: string[];
  /** recommendedBy entries that appear nowhere in the notes; the gate drops these. */
  recommendersOutsideNotes: number;
  /** Candidates whose page the notes read under a different title; the gate drops these. */
  retitled: string[];
}

/** Cheap, deterministic checks against the notes the model was given. Not the gate: no fetching, no catalogue. */
export function checkObject(object: CandidateList, prompt: string): ObjectChecks {
  const urls = notesUrls(prompt);
  const titles = readTitles(prompt);
  const cap = hoursCap(prompt);
  const backbones = object.candidates.filter((c) => c.backbone);
  const totalMinutes = object.candidates.reduce((sum, c) => sum + (c.minutes ?? 0), 0);
  const urlsOutsideNotes: string[] = [];
  const retitled: string[] = [];
  let recommendersOutsideNotes = 0;
  for (const c of object.candidates) {
    const u = canonical(c.url);
    if (!u || !urls.has(u)) urlsOutsideNotes.push(c.url);
    const recorded = u ? titles.get(u) : undefined;
    if (recorded !== undefined && recorded !== c.title) retitled.push(c.url);
    for (const r of c.recommendedBy) {
      const ru = canonical(r);
      if (!ru || !urls.has(ru)) recommendersOutsideNotes += 1;
    }
  }
  return {
    candidates: object.candidates.length,
    backbones: backbones.length,
    backboneIsBook: backbones.length > 0 && backbones.every((b) => b.kind === "book"),
    totalMinutes,
    unsized: object.candidates.filter((c) => c.minutes == null).length,
    overCap: cap !== null && totalMinutes > cap * 60,
    urlsOutsideNotes,
    recommendersOutsideNotes,
    retitled,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The matrix

export interface Pair {
  model: string;
  effort: Effort;
}

export function pairs(models: string[], efforts: Effort[]): Pair[] {
  return models.flatMap((model) => efforts.map((effort) => ({ model, effort })));
}

export interface BenchRun extends Pair {
  ok: boolean;
  error?: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  checks: ObjectChecks | null;
  object: CandidateList | null;
  /** The raw text when the output failed the schema. */
  text?: string;
}

export function formatRow(r: BenchRun): string {
  const s = (n: number | null, w: number) => String(n ?? "—").padStart(w);
  const c = r.checks;
  const quality = c
    ? `${String(c.candidates).padStart(2)} cand  bb ${c.backbones}${c.backbones > 0 && !c.backboneIsBook ? "!" : " "}  ${String(Math.round(c.totalMinutes / 60)).padStart(3)} h${c.overCap ? "!" : " "}  ${c.urlsOutsideNotes.length} new-url  ${c.recommendersOutsideNotes} bad-rec  ${c.retitled.length} retitled`
    : `failed: ${r.error ?? "?"}`;
  return [
    r.model.replace("anthropic/claude-", "").padEnd(11),
    r.effort.padEnd(7),
    `${(r.latencyMs / 1000).toFixed(1).padStart(6)} s`,
    s(r.inputTokens, 6),
    s(r.outputTokens, 6),
    s(r.reasoningTokens, 6),
    r.costUsd === null ? "     —" : `$${r.costUsd.toFixed(3)}`,
    quality,
  ].join("  ");
}

export const HEADER = ["model".padEnd(11), "effort ", "latency ", " input", "output", "reason", "  cost", "quality (cheap checks; the gate and a reader decide)"].join("  ");
