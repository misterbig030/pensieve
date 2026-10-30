/**
 * The allocate task: one sample runs the app's own allocation step on a frozen fixture with a contestant's model and
 * effort, decides whether the sample counts, and checks what the model kept against the criteria code can decide.
 */
import { allocatePlan, type AllocationInput } from "@/lib/ai/allocate";
import type { ModelCall } from "@/lib/ai/logged";
import { estimateCostUsd } from "@/lib/ai/models";
import { ALLOCATE_TIMEOUT_MS } from "@/lib/ai/planDraft";
import { renderMaterials } from "@/lib/ai/planPrompt";
import type { Coverage, DroppedMaterial } from "@/lib/ai/research/events";
import { appModel } from "@/lib/ai/resolve";
import type { ServiceEvent } from "@/lib/ai/serviceEvents";
import { isPracticeOnly } from "@/lib/materials";
import { PRACTICE_REGISTRY } from "@/lib/practice";
import type { Material } from "@/lib/schemas/material";
import { totalHours, type PlanSplit } from "@/lib/studyTime";
import { authorMatches, bookMatches, isNamedList, practiceTimeFindings, servedMinutes, titleMatches } from "@/evals/draft/checks";
import type { DraftTopic } from "@/evals/draft/topics";
import { BASELINE } from "../contestants";
import type { AllocateFixture } from "../fixtures";
import type { CodeCriterion, Contestant, Criterion, CriterionResult, Gate, JudgeCriterion, Sample } from "../types";

export type AllocateOutput = { split: PlanSplit; materials: Material[]; dropped: DroppedMaterial[]; coverage: Coverage | null };

/** What a criterion is judged against: the fixture the model was given and its topic's labels, when the topic has any. */
export interface AllocateCtx {
  fixture: AllocateFixture;
  topic: DraftTopic | undefined;
}

/** A reason that names our own time limit or a request that was cut off, which is not the service failing. */
const TIMEOUT_REASON = /timeout|timed out|aborted/i;

/**
 * Why the sample says nothing about the model: the last final failure the outside service itself caused (a 5xx, a 429,
 * or an error with no status that is not a timeout). A client error or a timeout is the contestant's to answer for.
 */
export function voidReason(events: ServiceEvent[]): string | null {
  const caused = events.filter((e) => !e.ok && e.final && (e.status === undefined ? !TIMEOUT_REASON.test(e.reason ?? "") : e.status >= 500 || e.status === 429));
  const last = caused.at(-1);
  if (!last) return null;
  return `${last.name} ${last.status ?? "error"}${last.reason ? `: ${last.reason}` : ""}`;
}

/** Plan minutes: the whole plan's study time. */
function planMinutes({ fixture }: AllocateCtx): number {
  return totalHours(fixture.input.weeks, fixture.input.hoursPerWeek) * 60;
}

/** Minutes of reading or watching the kept materials give, practice-only sources left out. */
function readingMinutes(output: AllocateOutput): number {
  return output.materials.filter((m) => !isPracticeOnly(m)).reduce((sum, m) => sum + (m.minutes ?? 0), 0);
}

/** Minutes of doing the kept practice sources give, every format together. */
function practiceMinutes(output: AllocateOutput): number {
  const formats = new Set(output.materials.flatMap((m) => (m.practice ? [m.practice.format] : [])));
  return [...formats].reduce((sum, format) => sum + servedMinutes(output.materials, format), 0);
}

/** How much over the plan's whole time the kept reading and practice may run before the plan is overfull: room for estimates. */
const OVERFULL_SLACK = 1.1;

/** At least this many covered areas: the allocation is asked for the topic's main areas, so one is not a statement. */
const MIN_COVERED = 2;

/** Lower case, words only, for telling an area from the topic. */
const plainWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const describeBook = (m: Material) => `"${m.title}" by ${m.author ?? "no author"}`;

const backbones = (ctx: AllocateCtx) => ctx.topic?.labels?.backbones ?? [];
const expectedBooks = (ctx: AllocateCtx) => ctx.topic?.labels?.expectedBooks ?? [];
const practiceNames = (ctx: AllocateCtx) => ctx.topic?.labels?.practiceNames ?? [];
const learnerMaterials = (ctx: AllocateCtx) => ctx.fixture.input.materials.filter((m) => m.origin === "learner");
/** A practice list the topic's labels name, carrying its items. */
const namedListWithItems = (m: Material, ctx: AllocateCtx) => isNamedList(m, practiceNames(ctx)) && (m.practice?.list?.items.length ?? 0) > 0;

/** The criteria a function decides. */
const CODE_CRITERIA: CodeCriterion<AllocateOutput, AllocateCtx>[] = [
  {
    id: "backbone-labelled",
    group: "materials",
    weight: 5,
    text: "The plan follows one of the books the topic's labels name as its backbone.",
    grader: "code",
    applies: (ctx) => backbones(ctx).length > 0,
    check: (output, ctx) => {
      const chosen = output.materials.filter((m) => m.backbone);
      if (chosen.length === 0) return { met: false, evidence: "no backbone chosen" };
      const hit = chosen.find((m) => backbones(ctx).some((l) => bookMatches(l.title, m) && authorMatches(l.author, m.author)));
      return hit ? { met: true, evidence: `backbone ${describeBook(hit)}` } : { met: false, evidence: `backbone ${chosen.map(describeBook).join("; ")} is not a labelled book` };
    },
  },
  {
    id: "backbone-chosen",
    group: "materials",
    weight: 2,
    text: "The plan follows one book in order.",
    grader: "code",
    check: (output) => {
      const chosen = output.materials.filter((m) => m.backbone);
      return { met: chosen.length > 0, evidence: chosen.length > 0 ? `backbone ${chosen.map(describeBook).join("; ")}` : "no backbone chosen" };
    },
  },
  {
    id: "expected-books",
    group: "materials",
    weight: 2,
    text: "At least two of the books the topic is expected to bring up are kept.",
    grader: "code",
    applies: (ctx) => expectedBooks(ctx).length > 0,
    check: (output, ctx) => {
      const kept = expectedBooks(ctx).filter((label) => output.materials.some((m) => titleMatches(label, m.title)));
      return { met: kept.length >= 2, evidence: `${kept.length} of ${expectedBooks(ctx).length} expected books kept${kept.length > 0 ? `: ${kept.join("; ")}` : ""}` };
    },
  },
  {
    id: "learner-dropped",
    group: "materials",
    weight: -10,
    text: "The plan drops a material the learner added.",
    grader: "code",
    applies: (ctx) => learnerMaterials(ctx).length > 0,
    check: (output, ctx) => {
      const keptIds = new Set(output.materials.map((m) => m.id));
      const missing = learnerMaterials(ctx).filter((m) => !keptIds.has(m.id));
      return { met: missing.length > 0, evidence: missing.length > 0 ? `learner's material dropped: ${missing.map((m) => `"${m.title}"`).join("; ")}` : "every learner's material kept" };
    },
  },
  {
    id: "named-list-kept",
    group: "practice",
    weight: 5,
    text: "A practice list the topic's labels name is kept, with its items.",
    grader: "code",
    // Only when research handed the allocation such a list: otherwise no model could keep one.
    applies: (ctx) => ctx.fixture.input.materials.some((m) => namedListWithItems(m, ctx)),
    check: (output, ctx) => {
      const hit = output.materials.find((m) => namedListWithItems(m, ctx));
      return hit ? { met: true, evidence: `"${hit.title}" kept with ${hit.practice?.list?.items.length} items` } : { met: false, evidence: `none of ${practiceNames(ctx).join(", ")} kept with items` };
    },
  },
  {
    id: "format-minutes",
    group: "practice",
    weight: 4,
    text: "The plan keeps time for practice, and each practice format with a serving material gets at least half its share of it.",
    grader: "code",
    check: (output, ctx) => {
      // With no practice time every share is 0 minutes, which any format meets: that is not a pass.
      const practising = output.split.readingShare < 100 && (output.split.formats ?? []).some((p) => p.share > 0);
      if (!practising) return { met: false, evidence: "no practice time" };
      const { short } = practiceTimeFindings(output.split, output.materials, ctx.fixture.input);
      return { met: short.length === 0, evidence: short.length === 0 ? "every served format has its minutes" : short.join("; ") };
    },
  },
  {
    id: "overfull",
    group: "structure",
    weight: -5,
    text: "The kept reading and practice together take more than 1.1 times the plan's whole time.",
    grader: "code",
    check: (output, ctx) => {
      const limit = Math.round(OVERFULL_SLACK * planMinutes(ctx));
      const reading = readingMinutes(output);
      const practice = practiceMinutes(output);
      return { met: reading + practice > limit, evidence: `${reading} min of reading and ${practice} min of practice against ${limit} min` };
    },
  },
  {
    id: "coverage-stated",
    group: "structure",
    weight: 1,
    text: "The plan names at least two areas it covers, none of them the topic itself.",
    grader: "code",
    check: (output, ctx) => {
      const covered = output.coverage?.covered ?? [];
      if (covered.length === 0) return { met: false, evidence: "no covered area stated" };
      const topic = plainWords(ctx.fixture.input.topic);
      const restated = covered.filter((area) => plainWords(area) === topic);
      const named = covered.length - restated.length;
      const evidence = `covers ${covered.join("; ")}${restated.length > 0 ? ` (the topic itself: ${restated.join("; ")})` : ""}`;
      return { met: named >= MIN_COVERED, evidence };
    },
  },
];

/**
 * The criteria a judge decides, from the rubric's coverage, fit and fidelity dimensions (the rubric's plan-leaf
 * dimension belongs to the outline task). A first draft, for the owner's review.
 */
const JUDGE_CRITERIA: JudgeCriterion[] = [
  { id: "cov-claims", dimension: "coverage", weight: 3, text: "The coverage names the areas it covers, and the kept materials teach every one of them." },
  {
    id: "cov-core",
    dimension: "coverage",
    weight: 3,
    text: "The kept materials cover the topic's core areas for a learner at this level; nothing a subject expert would call essential is missing without being listed as open.",
  },
  { id: "cov-open-honest", dimension: "coverage", weight: 1, text: "Every area listed as open is really not covered by a kept material." },
  { id: "fit-share", dimension: "fit", weight: 3, text: "The reading share suits the kind of topic and the learner's instructions." },
  { id: "fit-formats", dimension: "fit", weight: 3, text: "The practice formats are the right kind of work for this topic." },
  { id: "src-proportion", dimension: "fidelity", weight: 3, text: "Each kept material's minutes are in proportion to how much of the topic it covers." },
  { id: "src-offtopic", dimension: "fidelity", weight: -5, text: "A kept material is off the topic." },
  { id: "src-better-dropped", dimension: "fidelity", weight: -2, text: "A dropped material is clearly better for a purpose than the kept material that serves it." },
].map((c) => ({ ...c, group: "quality" as const, grader: "judge" as const }));

/** Every allocate criterion: the ones code decides, then the ones the judge does. */
export const ALLOCATE_CRITERIA: Criterion<AllocateOutput, AllocateCtx>[] = [...CODE_CRITERIA, ...JUDGE_CRITERIA];

/**
 * The allocation as the judge reads it: the request, the split, the kept materials, the dropped ones with their reasons
 * and the coverage. It names no model, so the judge cannot tell who wrote it.
 */
export function renderAllocation(output: AllocateOutput, input: AllocationInput): string {
  const { split, materials, dropped, coverage } = output;
  const formats = (split.formats ?? []).map((p) => `- ${PRACTICE_REGISTRY[p.format].label}, ${p.share}% of the practice time, aimed at ${p.focus}. ${p.reason}`.trim());
  const hours = `${input.hoursPerWeek} hour${input.hoursPerWeek === 1 ? "" : "s"} a week`;
  return [
    "The request",
    `Topic: ${input.topic}`,
    `Learner's instructions: ${input.instructions?.trim() || "none"}`,
    `Time: ${input.weeks} weeks, ${input.daysPerWeek} study days a week, about ${hours}`,
    "",
    "How the time is split",
    `Reading or watching the materials: ${split.readingShare}%`,
    `Practice: ${split.practice}`,
    ...(formats.length > 0 ? ["Practice formats:", ...formats] : []),
    `Why: ${split.reason || "none given"}`,
    "",
    "Kept materials",
    materials.length > 0 ? renderMaterials(materials) : "none",
    "",
    "Dropped materials",
    ...(dropped.length > 0 ? dropped.map((d) => `- "${d.title}": ${d.reason}`) : ["none"]),
    "",
    "Coverage",
    ...(coverage ? [`Covered: ${coverage.covered.join("; ") || "none"}`, `Open: ${coverage.open.join("; ") || "none"}`] : ["none stated"]),
  ].join("\n");
}

/** The results of the code criteria that apply to this fixture, each with what it found. */
export function codeResults(output: AllocateOutput, ctx: AllocateCtx): CriterionResult[] {
  return ALLOCATE_CRITERIA.flatMap((criterion) => {
    if (criterion.grader !== "code" || (criterion.applies && !criterion.applies(ctx))) return [];
    const { met, evidence } = criterion.check(output, ctx);
    return [{ id: criterion.id, met, evidence, grader: "code" as const }];
  });
}

/**
 * Runs the allocation once on the fixture's input with the contestant's allocate model and effort, under the app's own
 * time limit. A fallback is the code's allocation, not the model's: void when the outside service caused it, failed
 * otherwise. A fallback whose call reported no usage is charged an estimate (`estimatedCostUsd`), so it is not free.
 */
export async function runAllocateSample(
  fixture: AllocateFixture,
  contestant: Contestant,
  deps: { allocate?: typeof allocatePlan } = {},
): Promise<Pick<Sample<AllocateOutput>, "gate" | "output" | "calls" | "costUsd" | "estimatedCostUsd" | "ms">> {
  const allocate = deps.allocate ?? allocatePlan;
  const roleModel = contestant.roles.allocate ?? BASELINE.roles.allocate!;
  const calls: ModelCall[] = [];
  const events: ServiceEvent[] = [];
  const startedAt = performance.now();
  const { split, materials, dropped, coverage, fallback, fallbackReason } = await allocate({
    ...fixture.input,
    model: appModel(roleModel.model),
    effort: roleModel.effort,
    timeoutMs: ALLOCATE_TIMEOUT_MS,
    log: { onCall: (call) => calls.push(call), onService: (event) => events.push(event) },
  });
  const ms = Math.round(performance.now() - startedAt);
  const output: AllocateOutput = { split, materials, dropped, coverage };

  let gate: Gate = { status: "completed" };
  // A call that ends without usage (our own timeout, an error that carries none) reports no cost, so a slow contestant
  // would look free: charge what the fixture's own call used, at this contestant's price.
  let estimatedCostUsd = 0;
  if (fallback) {
    const outside = voidReason(events);
    const lastFailure = events.filter((e) => !e.ok && e.final).at(-1);
    const cause = lastFailure?.reason ?? fallbackReason ?? "no time";
    // Our limit can land while the SDK waits to retry ("Delay was aborted"): name the limit, keep the message.
    const why = TIMEOUT_REASON.test(cause) ? `timed out after ${ALLOCATE_TIMEOUT_MS / 1000} s (${cause})` : cause;
    gate = outside !== null ? { status: "void", reason: outside } : { status: "failed", reason: `fallback: ${why}` };
    if (!calls.some((call) => call.label === "Allocate") && fixture.baseline) {
      estimatedCostUsd = estimateCostUsd(roleModel.model, fixture.baseline);
    }
  }
  const costUsd = calls.reduce((sum, call) => sum + call.costUsd, 0) + estimatedCostUsd;
  return { gate, output, calls, costUsd, ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}), ms };
}
