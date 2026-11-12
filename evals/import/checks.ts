/**
 * The import eval's checks: pure functions of a `ConvertResult` for one fixture. Each fixture states what must hold
 * of any correct answer; where a model may reasonably differ (the category of a row the file leaves open), the check
 * reports it as a note instead of failing.
 */
import type { ConvertResult, ImportedPlan } from "@/lib/import/convert";

export const IMPORT_FIXTURES = ["weekly-plan", "month-plan", "syllabus", "reading-list", "odd-section"] as const;
export type ImportFixture = (typeof IMPORT_FIXTURES)[number];

export interface Verdict {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ImportCheck {
  passed: boolean;
  verdicts: Verdict[];
  /** What the answer did where a different answer would also be right. Never fails a run. */
  notes: string[];
}

const HEAP_PROBLEMS = ["703", "1046", "973", "215", "621", "355", "295"];

function verdict(name: string, pass: boolean, detail: string): Verdict {
  return { name, pass, detail };
}

function done(verdicts: Verdict[], notes: string[] = []): ImportCheck {
  return { passed: verdicts.every((v) => v.pass), verdicts, notes };
}

/** The one check every no-plan fixture has: the converter refused with `no_plan`. */
function expectNoPlan(result: ConvertResult): ImportCheck {
  const got = result.ok ? "a plan" : result.reason;
  return done([verdict("no_plan", !result.ok && result.reason === "no_plan", `got ${got}`)]);
}

function expectPlan(result: ConvertResult): { plan: ImportedPlan } | { failed: ImportCheck } {
  if (result.ok) return { plan: result.plan };
  return { failed: done([verdict("a plan", false, `got ${result.reason}: ${result.message}`)]) };
}

function checkWeeklyPlan(result: ConvertResult): ImportCheck {
  const got = expectPlan(result);
  if ("failed" in got) return got.failed;
  const { tree, materials } = got.plan;
  const verdicts: Verdict[] = [];
  verdicts.push(verdict("8 weeks", tree.length === 8 && tree.every((n) => n.level === "week"), `${tree.length} top-level units: ${tree.map((n) => n.level).join(",")}`));

  const week = tree[0];
  const byId = new Map(materials.map((m) => [m.id, m]));
  const reads = (week?.materials ?? []).map((ref) => byId.get(ref.id)).filter((m) => m && /system design interview/i.test(m.title));
  verdicts.push(verdict("vol. 1 reading", reads.some((m) => /vol\.? ?1/i.test(m!.title)), `Week 1 reads: ${reads.map((m) => m!.title).join("; ") || "none"}`));

  const practice = week?.practice ?? [];
  const problemRows = practice.filter((p) => p.format === "problem-set");
  const titles = problemRows.map((p) => {
    const items = p.id ? byId.get(p.id)?.practice?.list?.items : undefined;
    return p.itemFrom && items ? (items[p.itemFrom - 1]?.title ?? "?") : "?";
  });
  verdicts.push(verdict("7 heap problem rows in order", titles.length === 7 && titles.every((t, i) => t === HEAP_PROBLEMS[i]), `problem-set rows: ${titles.join(", ") || "none"}`));

  const design = practice.filter((p) => p.format === "design-exercise" && /rate limiter/i.test(p.task));
  verdicts.push(verdict("rate limiter design-exercise row", design.length >= 1, `${design.length} matching row(s)`));

  // weekly-plan.md fills all 8 weeks: each must keep a row (a reading or a practice row), Week 7's light one included.
  const empty = tree.flatMap((n, i) => ((n.materials?.length ?? 0) + (n.practice?.length ?? 0) > 0 ? [] : [`Week ${i + 1}`]));
  verdicts.push(verdict("every week has rows", tree.length > 0 && empty.length === 0, empty.length > 0 ? `no rows in ${empty.join(", ")}` : `${tree.length} weeks, each with rows`));

  const counts: Record<string, number> = {};
  for (const p of practice.filter((row) => row.format !== "problem-set")) counts[p.format] = (counts[p.format] ?? 0) + 1;
  const notes = [`Week 1 rows beyond the heap problems: ${Object.entries(counts).map(([f, n]) => `${n} ${f}`).join(", ") || "none"}`];
  return done(verdicts, notes);
}

function checkMonthPlan(result: ConvertResult): ImportCheck {
  const got = expectPlan(result);
  if ("failed" in got) return got.failed;
  const { tree } = got.plan;
  return done([
    verdict("3 month headings", tree.length === 3 && tree.every((n) => n.level === "month"), `${tree.length} units: ${tree.map((n) => n.level).join(",")}`),
    verdict("no children", tree.every((n) => !n.children || n.children.length === 0), `children: ${tree.map((n) => n.children?.length ?? "null").join(",")}`),
  ]);
}

function checkOddSection(result: ConvertResult): ImportCheck {
  const got = expectPlan(result);
  if ("failed" in got) return got.failed;
  const { tree, skipped } = got.plan;
  return done([
    verdict("4 weeks", tree.length === 4 && tree.every((n) => n.level === "week"), `${tree.length} units: ${tree.map((n) => n.level).join(",")}`),
    verdict("1 skipped section", skipped.length === 1, `skipped: ${skipped.map((s) => s.heading).join("; ") || "none"}`),
  ]);
}

export function checkImport(fixture: ImportFixture, result: ConvertResult): ImportCheck {
  switch (fixture) {
    case "weekly-plan":
      return checkWeeklyPlan(result);
    case "month-plan":
      return checkMonthPlan(result);
    case "syllabus":
    case "reading-list":
      return expectNoPlan(result);
    case "odd-section":
      return checkOddSection(result);
  }
}
