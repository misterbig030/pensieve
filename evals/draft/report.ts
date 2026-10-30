/**
 * The draft eval's markdown: one report per run (what passed, with the evidence behind each verdict) and one summary
 * per round (pass counts per criterion, runs that could not be scored, warnings, median time and cost). Pure text from
 * a saved record and its check result.
 */
import type { checkRun } from "./checks";
import type { RunRecord } from "./record";

type CheckResult = ReturnType<typeof checkRun>;

export interface SummaryRow {
  dir: string;
  result: CheckResult | null;
  error?: string;
  meta?: RunRecord["meta"];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function renderRunReport(record: RunRecord, result: CheckResult): string {
  const { meta } = record;
  const stages = Object.entries(meta.costByStage).map(([stage, cost]) => `${stage} ${usd(cost)}`);
  const models = Object.entries(meta.models).map(([role, id]) => `${role} ${id}${meta.effort?.[role] ? ` (${meta.effort[role]})` : ""}`);
  const request = meta.request;
  const lines = [
    `# Draft run: ${meta.topic}, run ${meta.run}`,
    "",
    `- Commit: ${meta.commit}`,
    `- Key: ${meta.key}`,
    `- Started: ${meta.startedAt}`,
    `- Time: ${seconds(meta.ms)}`,
    `- Cost: ${usd(meta.costUsd)}${stages.length > 0 ? ` (${stages.join(", ")})` : ""}`,
    ...(models.length > 0 ? [`- Models: ${models.join(", ")}`] : []),
    ...(request
      ? [`- Request: "${request.topic}", ${request.weeks} weeks × ${request.daysPerWeek} days, ${request.hoursPerWeek ?? "default"} h/week, by ${request.granularity}${request.materials.length > 0 ? `, ${request.materials.length} materials` : ""}`]
      : []),
    `- Result: ${result.passed ? "pass" : "fail"}`,
    "",
    "## Criteria",
    "",
  ];
  for (const v of result.verdicts) {
    lines.push(`- ${v.id}. ${v.name}: **${v.status}**`);
    for (const line of v.evidence) lines.push(`  - ${line}`);
  }
  lines.push("", "## Warnings", "");
  if (result.warnings.length === 0) lines.push("No warnings.");
  for (const w of result.warnings) lines.push(`- ${w.kind}: ${w.text}`);
  return lines.join("\n") + "\n";
}

export function renderSummary(rows: SummaryRow[]): string {
  const scored = rows.filter((r): r is SummaryRow & { result: CheckResult } => r.result !== null);
  const unscorable = rows.filter((r) => r.result === null);
  const lines = [`# Draft eval summary`, "", `${rows.length} run${rows.length === 1 ? "" : "s"}, ${scored.length} scored, ${unscorable.length} unscorable.`, "", "## Criteria", ""];

  const names = new Map<number, string>();
  for (const row of scored) for (const v of row.result.verdicts) names.set(v.id, v.name);
  for (const [id, name] of [...names].sort((a, b) => a[0] - b[0])) {
    const statuses = scored.flatMap((r) => r.result.verdicts.filter((v) => v.id === id).map((v) => v.status));
    const applicable = statuses.filter((s) => s !== "n/a");
    const passes = applicable.filter((s) => s === "pass").length;
    lines.push(`- ${id}. ${name}: ${applicable.length === 0 ? "n/a" : `${passes}/${applicable.length}`}`);
  }
  if (names.size === 0) lines.push("No run could be scored.");

  lines.push("", "## Runs", "");
  for (const row of rows) {
    if (!row.result) continue;
    const applicable = row.result.verdicts.filter((v) => v.status !== "n/a");
    const passes = applicable.filter((v) => v.status === "pass").length;
    const run = row.meta ? ` · ${seconds(row.meta.ms)} · ${usd(row.meta.costUsd)}` : "";
    lines.push(`- ${row.dir}: ${row.result.passed ? "pass" : "fail"} ${passes}/${applicable.length}${run}, ${row.result.warnings.length} warning${row.result.warnings.length === 1 ? "" : "s"}`);
  }

  lines.push("", "## Unscorable runs", "");
  if (unscorable.length === 0) lines.push("None.");
  for (const row of unscorable) lines.push(`- ${row.dir}: ${row.error ?? "could not be scored"}`);

  const byKind = new Map<string, number>();
  for (const row of scored) for (const w of row.result.warnings) byKind.set(w.kind, (byKind.get(w.kind) ?? 0) + 1);
  lines.push("", "## Warnings", "");
  if (byKind.size === 0) lines.push("None.");
  for (const [kind, count] of byKind) lines.push(`- ${kind}: ${count} warning${count === 1 ? "" : "s"}`);

  const metas = rows.flatMap((r) => (r.meta ? [r.meta] : []));
  const time = median(metas.map((m) => m.ms));
  const cost = median(metas.map((m) => m.costUsd));
  lines.push("", "## Median", "", time === null || cost === null ? "No run recorded its time and cost." : `${seconds(time)} · ${usd(cost)}`);
  return lines.join("\n") + "\n";
}
