/**
 * The outline task: one sample runs the app's own `draftLevel` on a frozen outline fixture (one level of a saved draft)
 * with a contestant's outline model and effort, under the time the source run had left, decides whether the sample
 * counts, and checks the level against the criteria code can decide. A leaf call (days, week leaves) and a heading call
 * (units split later) each have their own criteria; only the fixture's kind applies.
 */
import { GatewayError } from "@ai-sdk/gateway";
import { APICallError, JSONParseError, NoContentGeneratedError, NoObjectGeneratedError, RetryError, StreamProviderError, TypeValidationError } from "ai";
import { isGatewayOutOfFunds } from "@/lib/ai/gatewayFunds";
import type { ModelCall } from "@/lib/ai/logged";
import { draftLevel } from "@/lib/ai/planDraft";
import { renderMaterials, renderTree } from "@/lib/ai/planPrompt";
import { appModel } from "@/lib/ai/resolve";
import { isPracticeOnly, type Breach, type BreachKind } from "@/lib/materials";
import { cloneTree, findNode, layout, makeRoot, type PlanNode } from "@/lib/planTree";
import { PRACTICE_REGISTRY } from "@/lib/practice";
import { chapterAt, type CoverRef, type Material, type MaterialRef, type PracticeCover, type PracticeRef } from "@/lib/schemas/material";
import type { UnitDraft } from "@/lib/schemas/plan";
import { dayMinutes, formatDayTime, formatUnitTime, isAllReading, totalHours } from "@/lib/studyTime";
import { BASELINE } from "../contestants";
import { listPriceUsd } from "../price";
import type { CodeCriterion, Contestant, Criterion, CriterionResult, Gate, JudgeCriterion, Sample } from "../types";
import { breachesOf, idsInText, minutesOffSize, orderBreaks, setAsideOffSize, unreserved } from "./outlineChecks";
import { levelInput, type OutlineFixture } from "./outlineFixtures";

/** The level as the draft returned it: the app's nodes, the units as the model wrote them, and the checks' findings. */
export type OutlineOutput = { nodes: PlanNode[]; units: UnitDraft[]; breaches: Breach[]; problems: string[] };

export interface OutlineCtx {
  fixture: OutlineFixture;
}

type OutlineCriterion = Criterion<OutlineOutput, OutlineCtx>;

/** A criterion and, where whether it applies depends on what the level wrote, the test for that. */
interface Entry {
  criterion: OutlineCriterion;
  when?: (output: OutlineOutput, ctx: OutlineCtx) => boolean;
}

const isTop = (ctx: OutlineCtx) => ctx.fixture.group === "top";
const isLeaf = (ctx: OutlineCtx) => ctx.fixture.leaf;
const isHeading = (ctx: OutlineCtx) => !ctx.fixture.leaf;

/** "met" when there are no findings, else the findings themselves. */
function findings(found: string[], none: string): { met: boolean; evidence: string } {
  return found.length === 0 ? { met: true, evidence: none } : { met: false, evidence: found.join("; ") };
}

const breachTexts = (output: OutlineOutput, kinds: BreachKind[]) => breachesOf(output.breaches, kinds).map((b) => b.text);
const named = (materials: Material[]) => materials.map((m) => `"${m.title}" set aside nowhere`);

const code = (c: Omit<CodeCriterion<OutlineOutput, OutlineCtx>, "grader">): CodeCriterion<OutlineOutput, OutlineCtx> => ({ ...c, grader: "code" });
const judge = (dimension: "leaf" | "heading", c: Omit<JudgeCriterion, "grader" | "group" | "dimension">): JudgeCriterion => ({ ...c, group: "quality", grader: "judge", dimension });

const LEAF_TIME: BreachKind[] = ["over-budget", "over-capacity", "parent-miss"];
const TOP_TIME: BreachKind[] = ["budget-miss", "format-total-miss"];
const LEAF_ORDER: BreachKind[] = ["outside", "overlap", "whole-book", "review-before-read", "practice-outside", "practice-overlap"];
const HEAD_TIME: BreachKind[] = ["over-capacity", "no-time", "budget-miss", "format-total-miss", "parent-miss"];
const HEAD_ORDER: BreachKind[] = ["outside", "overlap", "whole-book"];

/**
 * Whether the level was given a material with no chapter list to read, whose order only a reader can follow: inside a
 * parent, one the parent set aside; at the top level, any reading material. Decided by the fixture alone, so every
 * contestant on it is judged on the same criteria.
 */
function givenUnlisted(ctx: OutlineCtx): boolean {
  const { fixture } = ctx;
  const parent = fixture.tree && fixture.parentId ? findNode(fixture.tree, fixture.parentId) : null;
  if (!parent) return fixture.materials.some((m) => !m.toc && !isPracticeOnly(m));
  const byId = new Map(fixture.materials.map((m) => [m.id, m]));
  return (parent.covers ?? []).some((c) => (c.activity ?? "read") === "read" && byId.has(c.id) && !byId.get(c.id)!.toc);
}

const LEAF_CRITERIA: Entry[] = [
  {
    criterion: code({
      id: "leaf-time",
      group: "structure",
      weight: 4,
      text: "Each unit's reading and practice fit its budget, and the units together match what the parent set aside; at the top level, the split's budgets.",
      applies: isLeaf,
      check: (output, ctx) => findings(breachTexts(output, isTop(ctx) ? [...LEAF_TIME, ...TOP_TIME] : LEAF_TIME), "every unit fits its time"),
    }),
  },
  {
    criterion: code({
      id: "leaf-minutes-code",
      group: "structure",
      weight: 1.5,
      text: "Rows whose material gives a size have minutes within half to one and a half times that size.",
      applies: isLeaf,
      check: (output, ctx) => {
        const { sized, off } = minutesOffSize(output.units, ctx.fixture.materials);
        return findings(off, `${sized} sized row${sized === 1 ? "" : "s"} within their size`);
      },
    }),
    when: (output, ctx) => minutesOffSize(output.units, ctx.fixture.materials).sized > 0,
  },
  {
    criterion: judge("leaf", { id: "leaf-minutes-judge", weight: 1.5, text: "Rows whose material gives no size have minutes that fit what they read or do." }),
    when: (output, ctx) => minutesOffSize(output.units, ctx.fixture.materials).unsized > 0,
  },
  {
    criterion: judge("leaf", {
      id: "leaf-note",
      weight: 3,
      text: "Each Read row's note lets the learner open the material and find where to start and stop; a book without a chapter list is named by topic only.",
    }),
  },
  {
    criterion: code({
      id: "leaf-order-code",
      group: "materials",
      weight: 1,
      text: "Only what the parent set aside, listed chapters and items in order across the units, nothing set aside left unread; at the top level, every material used.",
      applies: isLeaf,
      check: (output, ctx) => {
        const kinds: BreachKind[] = isTop(ctx) ? LEAF_ORDER : [...LEAF_ORDER, "unread-reservation"];
        const missing = isTop(ctx) ? named(unreserved(output.nodes, ctx.fixture.materials, true)) : [];
        return findings([...breachTexts(output, kinds), ...orderBreaks(output.nodes, ctx.fixture.materials, true), ...missing], "in order, nothing outside or left unread");
      },
    }),
  },
  {
    criterion: judge("leaf", { id: "leaf-order-judge", weight: 1, text: "Units reading a book without a chapter list each continue where the one before stopped." }),
    when: (_output, ctx) => givenUnlisted(ctx),
  },
  { criterion: judge("leaf", { id: "leaf-title", weight: 2, text: "Each unit's title and summary match its rows." }) },
  { criterion: judge("leaf", { id: "leaf-practice-read", weight: 1, text: "Practice uses only what has been read by then." }) },
  { criterion: judge("leaf", { id: "leaf-done", weight: 1, text: "Each practice task says what done looks like." }) },
  { criterion: judge("leaf", { id: "leaf-focus", weight: 1, text: "Each unit has one focus." }) },
  // Ids are leaf-words-code's: the judge reads the level after the app has put them in words.
  { criterion: judge("leaf", { id: "leaf-words-judge", weight: 0.5, text: "Written for the learner: no chapter or section names it was not given, no filler." }) },
  {
    criterion: code({
      id: "leaf-words-code",
      group: "quality",
      weight: 0.5,
      text: "The units' prose names no material id.",
      applies: isLeaf,
      check: (output) => findings(idsInText(output.units), "no ids in the text"),
    }),
  },
];

const HEAD_CRITERIA: Entry[] = [
  {
    criterion: code({
      id: "head-time",
      group: "structure",
      weight: 4,
      text: "Each unit states its minutes and they fit its hours; at the top level, the totals per activity match the split's budgets.",
      applies: isHeading,
      check: (output) => findings(breachTexts(output, HEAD_TIME), "every unit states time that fits"),
    }),
  },
  { criterion: judge("heading", { id: "head-title", weight: 3, text: "Each unit's title and summary match what it has: its minutes per activity and its set-aside items." }) },
  {
    criterion: code({
      id: "head-set-aside-code",
      group: "materials",
      weight: 1.5,
      text: "What each unit sets aside fits its reading time, where the material gives a size.",
      applies: isHeading,
      check: (output, ctx) => {
        const { sized, off } = setAsideOffSize(output.nodes, ctx.fixture.materials);
        return findings([...breachTexts(output, ["reading-over-stated"]), ...off], `${sized} sized unit${sized === 1 ? "" : "s"} fit their reading time`);
      },
    }),
    // Only with something to grade: a heading with no covers or no time sets nothing aside to measure.
    when: (output, ctx) => setAsideOffSize(output.nodes, ctx.fixture.materials).sized > 0,
  },
  {
    criterion: judge("heading", { id: "head-set-aside-judge", weight: 1.5, text: "What each unit sets aside fits its reading time." }),
    when: (output, ctx) => setAsideOffSize(output.nodes, ctx.fixture.materials).unsized > 0,
  },
  {
    criterion: code({
      id: "head-order",
      group: "materials",
      weight: 2,
      text: "Materials set aside in order, no gaps, no repeats; at the top level, every material set aside somewhere.",
      applies: isHeading,
      check: (output, ctx) => {
        const missing = isTop(ctx) ? named(unreserved(output.nodes, ctx.fixture.materials, false)) : [];
        return findings([...breachTexts(output, HEAD_ORDER), ...orderBreaks(output.nodes, ctx.fixture.materials, false), ...missing], "in order, each in one unit");
      },
    }),
  },
  { criterion: judge("heading", { id: "head-builds", weight: 2, text: "Each unit builds on the ones before it." }) },
  {
    criterion: judge("heading", {
      id: "head-words-judge",
      weight: 0.5,
      // Ids are head-words-code's: the judge reads the level after the app has put them in words.
      text: "Written for the learner: a book without a chapter list named by topic, never by chapter or section.",
    }),
  },
  {
    criterion: code({
      id: "head-words-code",
      group: "quality",
      weight: 0.5,
      text: "The units' prose names no material id.",
      applies: isHeading,
      check: (output) => findings(idsInText(output.units), "no ids in the text"),
    }),
  },
];

/** Every outline criterion: the leaf list, then the heading list. */
export const OUTLINE_CRITERIA: OutlineCriterion[] = [...LEAF_CRITERIA, ...HEAD_CRITERIA].map((e) => e.criterion);

/** The criteria of the fixture's kind that apply to this level. */
function applicable(output: OutlineOutput, ctx: OutlineCtx): OutlineCriterion[] {
  return (ctx.fixture.leaf ? LEAF_CRITERIA : HEAD_CRITERIA)
    .filter(({ criterion, when }) => (criterion.grader !== "code" || !criterion.applies || criterion.applies(ctx)) && (!when || when(output, ctx)))
    .map((e) => e.criterion);
}

/** The results of the code criteria that apply to this level, each with what it found. */
export function codeResults(output: OutlineOutput, ctx: OutlineCtx): CriterionResult[] {
  return applicable(output, ctx).flatMap((criterion) => {
    if (criterion.grader !== "code") return [];
    const { met, evidence } = criterion.check(output, ctx);
    return [{ id: criterion.id, met, evidence, grader: "code" as const }];
  });
}

/** The judge criteria of the fixture's kind that apply to this level. */
export function judgeCriteriaFor(output: OutlineOutput, ctx: OutlineCtx): JudgeCriterion[] {
  return applicable(output, ctx).filter((c): c is JudgeCriterion => c.grader === "judge");
}

// ---------------------------------------------------------------------------------------------------------------
// The judge's view

/** What the judge is told it grades: one level of an outline, written for the input shown with it. */
export const OUTLINE_JUDGE_INSTRUCTIONS = [
  "You are grading one level of a study plan's outline, shown above: the units under \"The level as written\", drafted for the request, materials, plan, set-aside and budgets shown with them.",
  "Judge each criterion on its own, from the outline shown alone, and say why in one sentence.",
  'A criterion that describes a harm (something the plan should not do) is "met" when the harm is present.',
  "Answer for every id given, once each.",
].join("\n");

const capitalize = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** '"Computer Systems", chapter 3 "Machine-Level Representation"': a material and its part in words, no id. */
function partName(byId: Map<string, Material>, id: string | null, chapter?: number | null): string {
  const m = id === null ? undefined : byId.get(id);
  if (!m) return id === null ? "no source" : "an unknown material";
  const ch = chapterAt(m.toc, chapter);
  return `"${m.title}"${ch ? `, chapter ${chapter} "${ch.title}"` : chapter ? `, chapter ${chapter}` : ""}`;
}

/** ", items 1–9" for a run of a practice source's list. */
function itemsText(from?: number | null, to?: number | null): string {
  if (!from) return "";
  return !to || to === from ? `, item ${from}` : `, items ${from}–${to}`;
}

const noteText = (note: string | null | undefined) => (note ? ` — ${note}` : "");

function coverLine(byId: Map<string, Material>, c: CoverRef): string {
  return `${(c.activity ?? "read") === "review" ? "Review" : "Read"} ${partName(byId, c.id, c.chapter)}${noteText(c.note)}`;
}

function practiceCoverLine(byId: Map<string, Material>, c: PracticeCover): string {
  const source = c.id === null ? ", no source (its rows are written later)" : ` from ${partName(byId, c.id)}${itemsText(c.itemFrom, c.itemTo)}`;
  return `${PRACTICE_REGISTRY[c.format].label}${source}${noteText(c.note)}`;
}

function readRow(byId: Map<string, Material>, r: MaterialRef): string {
  const what = (r.activity ?? "read") === "review" ? "Review" : "Read";
  return `${what} ${partName(byId, r.id, r.chapter)}, ${r.minutes ?? "no"} min, ${r.tier}${noteText(r.note)}`;
}

function practiceRow(byId: Map<string, Material>, r: PracticeRef): string {
  const source = r.id === null ? "" : ` (from ${partName(byId, r.id)}${itemsText(r.itemFrom, r.itemTo)})`;
  return `${PRACTICE_REGISTRY[r.format].label}, ${r.minutes} min: ${r.task}${source}. Done when: ${r.done}`;
}

/** The tree around the level, with the level's nodes under its parent (or at the top), and the parent marked. */
function treeWithLevel(output: OutlineOutput, fixture: OutlineFixture): string {
  const copies = output.nodes.map((n) => cloneTree(n));
  const { tree, parentId } = fixture;
  if (tree && parentId) {
    const root = cloneTree(tree);
    const parent = findNode(root, parentId);
    if (parent) {
      parent.children = copies;
      layout(root);
      return renderTree(root, { markId: parentId, daysPerWeek: fixture.request.daysPerWeek });
    }
  }
  return renderTree(makeRoot(copies), { daysPerWeek: fixture.request.daysPerWeek });
}

/** What the parent set aside for the level: its covers, its practice covers and its time. */
function setAsideLines(fixture: OutlineFixture, byId: Map<string, Material>): string[] {
  const parent = fixture.tree && fixture.parentId ? findNode(fixture.tree, fixture.parentId) : null;
  if (!parent) return ["Nothing: this is the plan's top level, so the whole plan's time and every material are the level's to place."];
  const covers = (parent.covers ?? []).map((c) => `- ${coverLine(byId, c)}`);
  const practice = (parent.practiceCovers ?? []).map((c) => `- ${practiceCoverLine(byId, c)}`);
  return [
    `Materials: ${covers.length > 0 ? "" : "none"}`.trimEnd(),
    ...covers,
    `Practice: ${practice.length > 0 ? "" : "none"}`.trimEnd(),
    ...practice,
    `Time: ${parent.time ? formatUnitTime(parent.time) : "none stated"}`,
  ];
}

/** The level's budgets: a week's time (and a day's, for days), the whole plan's, and how the time is split. */
function budgetLines(fixture: OutlineFixture): string[] {
  const { hoursPerWeek, daysPerWeek, weeks } = fixture.request;
  const { split, level } = fixture;
  const lines = [`Each week: about ${formatDayTime(hoursPerWeek * 60)} over ${plural(daysPerWeek, "study day")}`];
  if (level === "day") lines.push(`Each day: about ${formatDayTime(dayMinutes(hoursPerWeek, daysPerWeek))}`);
  lines.push(`The whole plan: ${plural(weeks, "week")}, about ${totalHours(weeks, hoursPerWeek)} h`);
  if (!split) lines.push("How the time is split: not set");
  else if (isAllReading(split)) lines.push("How the time is split: all of it reading or watching the materials");
  else {
    lines.push(`How the time is split: ${split.readingShare}% reading or watching the materials, the rest on ${split.practice}`);
    for (const p of split.formats ?? []) lines.push(`- ${PRACTICE_REGISTRY[p.format].label}: ${p.share}% of the practice time, aimed at ${p.focus}`);
  }
  return lines;
}

/** Each unit of the level as written: title, summary, then its rows (a leaf) or its time and what it sets aside (a heading). */
function levelLines(output: OutlineOutput, byId: Map<string, Material>): string[] {
  return output.nodes.flatMap((node, i) => {
    const head = `${capitalize(node.level)} ${i + 1}: "${node.title}" — ${node.summary}`;
    const lines = [
      ...(node.time ? [`Time: ${formatUnitTime(node.time)}`] : []),
      ...(node.covers ?? []).map((c) => `Sets aside: ${coverLine(byId, c)}`),
      ...(node.practiceCovers ?? []).map((c) => `Sets aside: ${practiceCoverLine(byId, c)}`),
      ...(node.materials ?? []).map((r) => readRow(byId, r)),
      ...(node.practice ?? []).map((r) => practiceRow(byId, r)),
    ];
    return [head, ...(lines.length > 0 ? lines.map((l) => `  ${l}`) : ["  (nothing)"]), ""];
  });
}

/**
 * The level as the judge reads it: the request, the materials, the plan around the level with its parent marked, what
 * the parent set aside, the level's budgets, and the level as written. It names no model, so the judge cannot tell who
 * wrote it, and shows no JSON.
 */
export function renderOutline(output: OutlineOutput, fixture: OutlineFixture): string {
  const { request } = fixture;
  const byId = new Map(fixture.materials.map((m) => [m.id, m]));
  return [
    "The request",
    `Topic: ${request.topic}`,
    `Learner's instructions: ${request.instructions?.trim() || "none"}`,
    `Time: ${plural(request.weeks, "week")}, ${plural(request.daysPerWeek, "study day")} a week, about ${plural(request.hoursPerWeek, "hour")} a week`,
    "",
    "The materials",
    fixture.materials.length > 0 ? renderMaterials(fixture.materials) : "none",
    "",
    `The plan around this level${fixture.parentId ? " (the unit being planned is marked >>)" : ""}`,
    treeWithLevel(output, fixture),
    "",
    "What the parent set aside",
    ...setAsideLines(fixture, byId),
    "",
    "The level's budgets",
    ...budgetLines(fixture),
    "",
    "The level as written",
    ...levelLines(output, byId),
  ]
    .join("\n")
    .trimEnd();
}

// ---------------------------------------------------------------------------------------------------------------
// The sample

/** The gateway refusing the app's key itself: invalid (401), out of budget (402) or not allowed (403). */
const ACCOUNT_STATUSES = new Set([401, 402, 403]);

/** The provider or gateway status inside an error, looking through retries and wrapped causes. */
function statusOf(error: unknown, depth = 4): number | undefined {
  if (depth < 0 || error == null) return undefined;
  if (APICallError.isInstance(error) || GatewayError.isInstance(error) || StreamProviderError.isInstance(error)) return error.statusCode;
  if (RetryError.isInstance(error)) return statusOf(error.lastError ?? error.errors.at(-1), depth - 1);
  if (error instanceof Error && "cause" in error) return statusOf(error.cause, depth - 1);
  return undefined;
}

/** Whether a signal ended the call (an abort, or our own deadline's timeout), looking through retries and causes. */
function aborted(error: unknown, depth = 4): boolean {
  if (depth < 0 || error == null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (RetryError.isInstance(error)) return aborted(error.lastError ?? error.errors.at(-1), depth - 1);
  if (error instanceof Error && "cause" in error) return aborted(error.cause, depth - 1);
  return false;
}

/** The tokens an error says its call used (`NoObjectGeneratedError` carries them), looking through retries and causes. */
function usageOf(error: unknown, depth = 4): { inputTokens: number; outputTokens: number; cacheReadTokens: number | null } | null {
  if (depth < 0 || error == null) return null;
  if (NoObjectGeneratedError.isInstance(error) && error.usage && (error.usage.inputTokens !== undefined || error.usage.outputTokens !== undefined)) {
    const { inputTokens, outputTokens, inputTokenDetails } = error.usage;
    return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, cacheReadTokens: inputTokenDetails?.cacheReadTokens ?? null };
  }
  if (RetryError.isInstance(error)) return usageOf(error.lastError ?? error.errors.at(-1), depth - 1);
  if (error instanceof Error && "cause" in error) return usageOf(error.cause, depth - 1);
  return null;
}

/**
 * Whether the model's own answer caused the error: the SDK found no object in it, could not parse it, found it did not
 * match the schema, or got no content. Looks through retries and causes. `draftLevel`'s own checks throw nothing (what
 * they find comes back as breaches), so these are the only errors a contestant's output raises.
 */
function modelCaused(error: unknown, depth = 4): boolean {
  if (depth < 0 || error == null) return false;
  if (NoObjectGeneratedError.isInstance(error) || TypeValidationError.isInstance(error) || JSONParseError.isInstance(error) || NoContentGeneratedError.isInstance(error)) return true;
  if (RetryError.isInstance(error)) return modelCaused(error.lastError ?? error.errors.at(-1), depth - 1);
  if (error instanceof Error && "cause" in error) return modelCaused(error.cause, depth - 1);
  return false;
}

/**
 * What an error says, readable whatever was thrown: an `Error`'s message, a string, an object's `message` (a stream's
 * error part arrives as a plain object), or else the value as JSON.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * The gate for a call that threw, by who caused it. The gateway out of funds voids it and halts the run, whatever else
 * the error says. Our deadline or an abort fails it. With a status: the gateway refusing the key voids and halts, an
 * outage (5xx, 429) voids, another client error fails. With none: an answer the model wrote that did not parse or
 * validate fails; anything else (a stream's error part, a network error, a provider error with no status) is the
 * outside service's and voids, as allocate's `voidReason` does.
 */
function thrownGate(error: unknown, timedOut: boolean, timeLimitMs: number): Gate {
  const message = messageOf(error);
  // A plain object is not an Error, so its message is checked as one.
  if (isGatewayOutOfFunds(error instanceof Error ? error : new Error(message))) return { status: "void", reason: `gateway out of funds: ${message}`, halt: true };
  if (timedOut || aborted(error)) return { status: "failed", reason: `timed out after ${timeLimitMs / 1000} s` };
  const status = statusOf(error);
  if (status !== undefined && ACCOUNT_STATUSES.has(status)) return { status: "void", reason: `gateway ${status}: ${message}`, halt: true };
  if (status !== undefined && (status >= 500 || status === 429)) return { status: "void", reason: `gateway ${status}: ${message}` };
  if (status !== undefined || modelCaused(error)) return { status: "failed", reason: message };
  return { status: "void", reason: message };
}

/** A unit past the app's own ceiling: a heading or week leaf over capacity, a day over its budget. */
const CEILING: BreachKind[] = ["over-capacity", "over-budget"];

/**
 * Runs the fixture's level once through the app's `draftLevel` with the contestant's outline model and effort (the
 * baseline's when the contestant leaves the role out), under the time the source run had left. A level with a unit past
 * the time ceiling fails, its output kept for the report. A call's cost is what the gateway charged, or the list price
 * where it reported none; a call that threw before reporting is charged an estimate (`estimatedCostUsd`), so it is not free.
 */
export async function runOutlineSample(
  fixture: OutlineFixture,
  contestant: Contestant,
  deps: { draft?: typeof draftLevel; now?: () => number } = {},
): Promise<Pick<Sample<OutlineOutput>, "gate" | "output" | "calls" | "costUsd" | "estimatedCostUsd" | "ms">> {
  const draft = deps.draft ?? draftLevel;
  const role = contestant.roles.outline ?? BASELINE.roles.outline!;
  const calls: ModelCall[] = [];
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const deadline = Date.now() + fixture.timeLimitMs;
  const input = levelInput(fixture, appModel(role.model), role.effort);

  let output: OutlineOutput | null = null;
  let gate: Gate = { status: "completed" };
  let thrown: unknown;
  try {
    for await (const event of draft({ ...input, ctx: { ...input.ctx, deadline }, log: { onCall: (call) => calls.push(call) } })) {
      if (event.type === "done") output = { nodes: event.nodes, units: event.units, breaches: event.breaches, problems: event.problems };
    }
    const over = output ? breachesOf(output.breaches, CEILING)[0] : undefined;
    if (!output) gate = { status: "failed", reason: "the draft returned no level" };
    else if (over) gate = { status: "failed", reason: `over the time ceiling: ${over.text}` };
  } catch (error) {
    thrown = error;
    gate = thrownGate(error, Date.now() >= deadline, fixture.timeLimitMs);
  }
  const ms = Math.round(now() - startedAt);
  // The draft reports a call only once its object resolves, so a call that threw (a timeout, an outage, an answer that
  // did not parse) reports no cost and a slow contestant would look free. Charge it what the error says it used, or else
  // the fixture's own call at this contestant's price, with as much more output as the baseline's pace would have
  // written in the extra time (a reasoning model that times out has been writing all along).
  let estimatedCostUsd = 0;
  if (gate.status !== "completed" && calls.length === 0) {
    const used = usageOf(thrown);
    if (used) estimatedCostUsd = listPriceUsd(role.model, used);
    else {
      const { inputTokens, outputTokens, ms: baselineMs } = fixture.baseline;
      const pace = baselineMs > 0 ? Math.max(1, ms / baselineMs) : 1;
      estimatedCostUsd = listPriceUsd(role.model, { inputTokens, outputTokens: outputTokens * pace });
    }
  }
  // A call's cost is what the gateway charged; one it reported no charge for is priced at the list rate.
  const costUsd = calls.reduce((sum, call) => sum + (call.costUsd ?? listPriceUsd(call.model, call)), 0) + estimatedCostUsd;
  return { gate, output, calls, costUsd, ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}), ms };
}
