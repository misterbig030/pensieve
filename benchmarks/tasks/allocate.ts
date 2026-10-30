/**
 * The allocate task: one sample runs the app's own allocation step on a frozen fixture with a contestant's model and
 * effort, decides whether the sample counts, and checks what the model kept against the criteria code can decide.
 */
import { allocatePlan } from "@/lib/ai/allocate";
import type { ModelCall } from "@/lib/ai/logged";
import { ALLOCATE_TIMEOUT_MS } from "@/lib/ai/planDraft";
import type { Coverage, DroppedMaterial } from "@/lib/ai/research/events";
import { appModel } from "@/lib/ai/resolve";
import type { ServiceEvent } from "@/lib/ai/serviceEvents";
import { isPracticeOnly } from "@/lib/materials";
import type { Material } from "@/lib/schemas/material";
import { totalHours, type PlanSplit } from "@/lib/studyTime";
import { authorMatches, bookMatches, isNamedList, practiceTimeFindings, titleMatches } from "@/evals/draft/checks";
import type { DraftTopic } from "@/evals/draft/topics";
import { BASELINE } from "../contestants";
import type { AllocateFixture } from "../fixtures";
import type { Contestant, Criterion, CriterionResult, Gate, Sample } from "../types";

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

const describeBook = (m: Material) => `"${m.title}" by ${m.author ?? "no author"}`;

const backbones = (ctx: AllocateCtx) => ctx.topic?.labels?.backbones ?? [];
const expectedBooks = (ctx: AllocateCtx) => ctx.topic?.labels?.expectedBooks ?? [];
const practiceNames = (ctx: AllocateCtx) => ctx.topic?.labels?.practiceNames ?? [];
const learnerMaterials = (ctx: AllocateCtx) => ctx.fixture.input.materials.filter((m) => m.origin === "learner");

/** The code criteria; the judge criteria are appended to this list by the judging task. */
export const ALLOCATE_CRITERIA: Criterion<AllocateOutput, AllocateCtx>[] = [
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
    applies: (ctx) => practiceNames(ctx).length > 0,
    check: (output, ctx) => {
      const hit = output.materials.find((m) => isNamedList(m, practiceNames(ctx)) && (m.practice?.list?.items.length ?? 0) > 0);
      return hit ? { met: true, evidence: `"${hit.title}" kept with ${hit.practice?.list?.items.length} items` } : { met: false, evidence: `none of ${practiceNames(ctx).join(", ")} kept with items` };
    },
  },
  {
    id: "formats-served",
    group: "practice",
    weight: 3,
    text: "Every practice format the split picks that cannot be generated has a material that serves it.",
    grader: "code",
    check: (output, ctx) => {
      const { unserved } = practiceTimeFindings(output.split, output.materials, ctx.fixture.input);
      return { met: unserved.length === 0, evidence: unserved.length === 0 ? "every picked format served or generated" : unserved.join("; ") };
    },
  },
  {
    id: "format-minutes",
    group: "practice",
    weight: 4,
    text: "Each practice format with a serving material gets at least half its share of the practice time.",
    grader: "code",
    check: (output, ctx) => {
      const { short } = practiceTimeFindings(output.split, output.materials, ctx.fixture.input);
      return { met: short.length === 0, evidence: short.length === 0 ? "every served format has its minutes" : short.join("; ") };
    },
  },
  {
    id: "fits-hours",
    group: "structure",
    weight: 3,
    text: "The reading fits the time the split gives it, within a fifth.",
    grader: "code",
    check: (output, ctx) => {
      const limit = Math.round((1.2 * planMinutes(ctx) * output.split.readingShare) / 100);
      const minutes = readingMinutes(output);
      return { met: minutes <= limit, evidence: `${minutes} min of reading against a limit of ${limit} min` };
    },
  },
  {
    id: "overfull",
    group: "structure",
    weight: -5,
    text: "The reading is more than one and a half times all the plan's time.",
    grader: "code",
    check: (output, ctx) => {
      const limit = Math.round(1.5 * planMinutes(ctx));
      const minutes = readingMinutes(output);
      return { met: minutes > limit, evidence: `${minutes} min of reading against ${limit} min` };
    },
  },
  {
    id: "coverage-stated",
    group: "structure",
    weight: 1,
    text: "The plan states at least one area it covers.",
    grader: "code",
    check: (output) => {
      const covered = output.coverage?.covered ?? [];
      return { met: covered.length > 0, evidence: covered.length > 0 ? `covers ${covered.join("; ")}` : "no covered area stated" };
    },
  },
];

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
 * otherwise.
 */
export async function runAllocateSample(
  fixture: AllocateFixture,
  contestant: Contestant,
  deps: { allocate?: typeof allocatePlan } = {},
): Promise<Pick<Sample<AllocateOutput>, "gate" | "output" | "calls" | "costUsd" | "ms">> {
  const allocate = deps.allocate ?? allocatePlan;
  const roleModel = contestant.roles.allocate ?? BASELINE.roles.allocate!;
  const calls: ModelCall[] = [];
  const events: ServiceEvent[] = [];
  const startedAt = performance.now();
  const { split, materials, dropped, coverage, fallback } = await allocate({
    ...fixture.input,
    model: appModel(roleModel.model),
    effort: roleModel.effort,
    timeoutMs: ALLOCATE_TIMEOUT_MS,
    log: { onCall: (call) => calls.push(call), onService: (event) => events.push(event) },
  });
  const ms = Math.round(performance.now() - startedAt);
  const costUsd = calls.reduce((sum, call) => sum + call.costUsd, 0);
  const output: AllocateOutput = { split, materials, dropped, coverage };

  let gate: Gate = { status: "completed" };
  if (fallback) {
    const outside = voidReason(events);
    const lastFailure = events.filter((e) => !e.ok && e.final).at(-1);
    gate = outside !== null ? { status: "void", reason: outside } : { status: "failed", reason: `fallback: ${lastFailure?.reason ?? "no time"}` };
  }
  return { gate, output, calls, costUsd, ms };
}
