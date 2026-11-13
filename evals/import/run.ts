/**
 * The import eval: runs `runImport` on each fixture in `fixtures/` with the app's key, checks the answer in code,
 * and writes `evals/results/import-<date>.json`. It spends real money (about $1), so run it on demand; never in CI.
 *
 *   npx tsx evals/import/run.ts
 *
 * Env (.env.local): AI_GATEWAY_API_KEY.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import "../draft/env";
import { runImport } from "@/lib/import/run";
import { resolveWith } from "@/lib/ai/resolve";
import { IMPORT_FIXTURES, checkImport, type ImportCheck, type ImportFixture } from "./checks";

const FIXTURES_DIR = path.join("evals", "import", "fixtures");
const RESULTS_DIR = path.join("evals", "results");

interface FixtureRun {
  fixture: ImportFixture;
  check: ImportCheck | null;
  costUsd: number;
  ms: number;
  error?: string;
  result?: unknown;
}

async function main() {
  const model = resolveWith({}).outline;
  const runs: FixtureRun[] = [];
  for (const fixture of IMPORT_FIXTURES) {
    const fileName = `${fixture}.md`;
    const text = readFileSync(path.join(FIXTURES_DIR, fileName), "utf8");
    const started = Date.now();
    try {
      const { result, costUsd } = await runImport({ fileName, text, model });
      const check = checkImport(fixture, result);
      runs.push({ fixture, check, costUsd, ms: Date.now() - started, result });
      console.log(`${check.passed ? "pass" : "FAIL"} ${fixture} · ${Math.round((Date.now() - started) / 1000)} s · $${costUsd.toFixed(2)}`);
      for (const v of check.verdicts) console.log(`  ${v.pass ? "ok  " : "FAIL"} ${v.name}: ${v.detail}`);
      for (const note of check.notes) console.log(`  note ${note}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runs.push({ fixture, check: null, costUsd: 0, ms: Date.now() - started, error: message });
      console.log(`ERROR ${fixture}: ${message}`);
    }
  }
  const total = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const file = path.join(RESULTS_DIR, `import-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ model: model.id, totalCostUsd: total, runs }, null, 2));
  console.log(`\nTotal $${total.toFixed(2)}. Wrote ${file}`);
  if (runs.some((r) => !r.check?.passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
