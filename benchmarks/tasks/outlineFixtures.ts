/**
 * Outline fixtures: one per outline call a saved draft-eval run made, holding exactly what that call was given (the
 * request, the allocated materials, the split, the level, its spans and the tree around it), so every contestant gets
 * the same input. The input is rebuilt as the app builds it, then replayed through the app's own `draftLevel` with a
 * model that answers with the recorded response: the prompt that replay sends must be the recorded one, which proves the
 * rebuilt tree, reservation and spans are what the baseline saw. The prompt itself is not stored.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { ModelCall } from "@/lib/ai/logged";
import type { AiModelId, ReasoningEffort } from "@/lib/ai/models";
import { DRAFT_BUDGET_MS, STEP_MIN_MS, draftLevel, unitsAreLeaves, unitsPromptInput, weekLeafBlocks, type DraftLevelInput, type LevelPromptSource } from "@/lib/ai/planDraft";
import type { UnitsPromptInput } from "@/lib/ai/planPrompt";
import type { ResolvedModel } from "@/lib/ai/resolve";
import { childLevel, childSpans, cloneTree, fullLabelOf, layout, makeRoot, topLevelFor, topSpans, walk, DEFAULT_HOURS_PER_WEEK, type Granularity, type PlanLevel, type PlanNode } from "@/lib/planTree";
import { materialSchema, type Material } from "@/lib/schemas/material";
import { granularitySchema, planLevelSchema } from "@/lib/schemas/plan";
import { planSplitSchema, type PlanSplit } from "@/lib/studyTime";
import { DRAFT_TOPICS } from "@/evals/draft/topics";
import { readRun } from "@/evals/draft/record";
import { FIXTURES_ROOT } from "../fixtures";

/** The units the app could route to one model: top-level calls, middle headings, and leaves. */
export type CallGroup = "top" | "inner" | "leaves";

export interface OutlineFixture {
  /** "<run fixture id>/<slug>": "csapp-1/week-1". */
  id: string;
  /** A DRAFT_TOPICS key. */
  topic: string;
  /** The basename of the eval folder the fixture was captured from. */
  sourceRun: string;
  commit: string;
  /** The recorded call label, "Week 1 · 5 days". */
  label: string;
  group: CallGroup;
  /** Whether the call's units are the plan's finest (they get Read tables and practice rows). */
  leaf: boolean;
  request: { topic: string; instructions?: string; granularity: Granularity; weeks: number; daysPerWeek: number; hoursPerWeek: number };
  /** The allocated materials the draft wrote its units from. */
  materials: Material[];
  split: PlanSplit | null;
  level: PlanLevel;
  spans: number[];
  /** The tree as it stood before the call; absent at the top level. */
  tree?: PlanNode;
  /** The node the call plans inside; absent at the top level. */
  parentId?: string;
  /** What the source run had left when the call started, at least `STEP_MIN_MS`. */
  timeLimitMs: number;
  baseline: { inputTokens: number; outputTokens: number; ms: number };
}

/** The label the app's allocation step logs its model call under (also with `caller: "outline"`). */
const ALLOCATE_LABEL = "Allocate";
/** #48's block-heading call: "Top level · 8 weeks in 3 blocks". */
const BLOCK_HEADINGS = / in \d+ blocks$/;
/** #48's block call: "Week 4 · 1 week" or "Weeks 3–5 · 3 weeks". */
const BLOCK_LABEL = /^(?:Week (\d+) · 1 week|Weeks (\d+)–(\d+) · \d+ weeks)$/;

/** No parent: top; a parent and leaf units: leaves; a parent and heading units: inner. */
export function callGroup(f: { parentId?: string; leaf: boolean }): CallGroup {
  if (!f.parentId) return "top";
  return f.leaf ? "leaves" : "inner";
}

/**
 * The time the source run had left when the call started, at least `STEP_MIN_MS`: the call started at `endedAt −
 * latencyMs` (wall clock), and the draft's deadline is the run's start plus `DRAFT_BUDGET_MS`, as the eval sets it.
 */
export function timeLimitMs(call: { endedAt: number; latencyMs: number }, startedAt: string): number {
  return Math.max(STEP_MIN_MS, Date.parse(startedAt) + DRAFT_BUDGET_MS - (call.endedAt - call.latencyMs));
}

/** The file-name part of a fixture's id: "top" for any top-level call, otherwise where the call plans ("week-1", "weeks-3-5"). */
export function fixtureSlug(label: string): string {
  const where = label.split(" · ")[0];
  if (where === "Top level") return "top";
  return where
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The draft's input for the fixture's call, on `outlineModel` at `effort`: what the app passes, the model and effort aside. */
export function levelInput(f: OutlineFixture, outlineModel: ResolvedModel, effort?: ReasoningEffort): DraftLevelInput {
  const source = levelSource(f);
  return { ...source, ctx: { ...source.ctx, outlineModel, ...(effort ? { effort } : {}) }, label: f.label };
}

/** The fixture's call as its prompt is built from it, with no model: what `levelInput` passes, the model aside. */
function levelSource(f: OutlineFixture): LevelPromptSource {
  return {
    ctx: {
      topic: f.request.topic,
      ...(f.request.instructions ? { instructions: f.request.instructions } : {}),
      materials: f.materials,
      granularity: f.request.granularity,
      weeks: f.request.weeks,
      daysPerWeek: f.request.daysPerWeek,
      hoursPerWeek: f.request.hoursPerWeek,
      split: f.split,
    },
    level: f.level,
    spans: [...f.spans],
    ...(f.tree ? { tree: cloneTree(f.tree) } : {}),
    ...(f.parentId ? { parentId: f.parentId } : {}),
  };
}

/** The input the fixture's units prompt was built from, as the draft builds it. */
export function promptInputOf(f: OutlineFixture): UnitsPromptInput {
  return unitsPromptInput(levelSource(f));
}

/** The user text of a prompt as a model receives it. */
function promptText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** A model that streams `response` as its whole answer and keeps the prompts it was sent. */
function replayModel(call: ModelCall): { model: ResolvedModel; prompts: string[] } {
  const prompts: string[] = [];
  const mock = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(promptText(options));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "replay" });
            controller.enqueue({ type: "text-delta", id: "replay", delta: call.response });
            controller.enqueue({ type: "text-end", id: "replay" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: call.inputTokens ?? 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: call.outputTokens ?? 0, text: undefined, reasoning: undefined },
              },
              // A replay costs nothing; saying so keeps the log quiet about a missing gateway cost.
              providerMetadata: { gateway: { cost: "0" } },
            });
            controller.close();
          },
        }),
      };
    },
  });
  return { model: { model: mock, id: call.model as AiModelId, keyOwner: "app" }, prompts };
}

/**
 * Runs the fixture's call through the app's `draftLevel` with the recorded response, and returns the level's final
 * nodes. Throws, naming the call, when the prompt the app builds from the fixture is not the recorded one.
 */
async function replay(f: OutlineFixture, call: ModelCall): Promise<PlanNode[]> {
  const { model, prompts } = replayModel(call);
  let nodes: PlanNode[] = [];
  let failure: { error: unknown } | null = null;
  try {
    for await (const event of draftLevel(levelInput(f, model))) {
      if (event.type === "done") nodes = event.nodes;
    }
  } catch (error) {
    failure = { error };
  }
  const why = failure ? `; draftLevel threw: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}` : "";
  // The prompt is checked first: a response that no longer parses matters only once the input is the recorded one.
  if (prompts.length !== 1) throw new Error(`${call.label}: the replay sent ${prompts.length} prompts, not 1${why}`);
  if (prompts[0] !== call.prompt) throw new Error(`${call.label}: the rebuilt prompt differs from the recorded one${why}`);
  if (failure) throw new Error(`${call.label}: the recorded response did not replay: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
  return nodes;
}

/** A level call's label: where it plans and how many units it asked for ("Week 1 · 5 days"). */
const LEVEL_LABEL = /^(.+) · (\d+) (day|week|month)s?$/;

/**
 * The node in `tree` whose children the call labelled `label` planned ("Week 1 · 5 days" is Week 1, planned as days),
 * and how many units the call asked for. Matched by where the call plans, not by the count: a level that came back with
 * another count was re-split, and `layout` then changed the parent's length in the saved plan.
 */
function plannedNode(tree: PlanNode, label: string): { node: PlanNode; asked: number } {
  const match = LEVEL_LABEL.exec(label);
  if (!match) throw new Error(`${label}: not a level call's label`);
  const [, where, count, level] = match;
  const found: PlanNode[] = [];
  walk(tree, (node) => {
    if (node.id !== tree.id && node.children !== null && childLevel(node.level) === level && fullLabelOf(tree, node) === where) found.push(node);
  });
  if (found.length === 0) throw new Error(`${label}: no unit in the plan matches the call`);
  if (found.length > 1) throw new Error(`${label}: ${found.length} units in the plan match the call`);
  return { node: found[0], asked: Number(count) };
}

/** The block heading a block call wrote, by the week range in its label: blocks are recorded as they finish, not in order. */
function blockHead(heads: PlanNode[], label: string, daysPerWeek: number): PlanNode {
  const match = BLOCK_LABEL.exec(label);
  if (!match) throw new Error(`${label}: not a block of weeks under the block headings`);
  const from = Number(match[1] ?? match[2]);
  const to = Number(match[1] ?? match[3]);
  let first = 1;
  for (const head of heads) {
    const last = first + childSpans(head, daysPerWeek).length - 1;
    if (first === from && last === to) return head;
    first = last + 1;
  }
  throw new Error(`${label}: no block heading holds weeks ${from}–${to}`);
}

/** The labels the app gives #48's block calls, one per block heading, in order: "Week 4 · 1 week", "Weeks 1–3 · 3 weeks". */
function blockLabels(heads: PlanNode[], daysPerWeek: number): string[] {
  let first = 1;
  return heads.map((head) => {
    const n = childSpans(head, daysPerWeek).length;
    const last = first + n - 1;
    const label = n === 1 ? `Week ${first} · 1 week` : `Weeks ${first}–${last} · ${n} weeks`;
    first = last + 1;
    return label;
  });
}

/**
 * The levels the run planned that no recorded call did: the top level and each unit with children in the saved plan,
 * by where they plan ("Top level", "Week 1"), then any of `blocks` (#48's block calls) with no call. A call that failed
 * or was cut off records nothing, so it has no fixture; capture names it instead of skipping it in silence.
 */
function unrecorded(plan: PlanNode | null, calls: ModelCall[], blocks: string[]): string[] {
  const planned = new Set<string>();
  for (const call of calls) {
    const match = LEVEL_LABEL.exec(call.label);
    if (match) planned.add(`${match[1]}|${match[3]}`);
  }
  const out: string[] = [];
  if (plan?.children?.length && !calls.some((call) => call.label.startsWith("Top level · "))) out.push("Top level");
  if (plan) {
    walk(plan, (node) => {
      if (node.id === plan.id || !node.children?.length) return;
      const where = fullLabelOf(plan, node);
      if (!planned.has(`${where}|${childLevel(node.level)}`)) out.push(where);
    });
  }
  const labels = new Set(calls.map((call) => call.label));
  return [...out, ...blocks.filter((label) => !labels.has(label))];
}

/**
 * Rebuilds every outline call a saved draft-eval run made (in recorded order, the allocation's call left out) as a
 * fixture under `runFixtureId`, each replayed through the app to check its prompt, and names the planned levels that
 * have no recorded call (`skipped`), which get no fixture. Throws, naming the call, when one cannot be rebuilt or its
 * prompt differs; writes nothing.
 */
export async function captureOutline(runDir: string, runFixtureId: string): Promise<{ fixtures: OutlineFixture[]; skipped: string[] }> {
  const record = readRun(runDir);
  const { meta } = record;
  const calls = record.calls.filter((call) => call.caller === "outline" && call.label !== ALLOCATE_LABEL);
  if (calls.length === 0) return { fixtures: [], skipped: unrecorded(record.plan, calls, []) };

  const asked = meta.request ?? DRAFT_TOPICS[meta.topic]?.request;
  if (!asked) throw new Error(`Run folder ${runDir} has no request, and topic "${meta.topic}" has none to fall back on`);
  const request: OutlineFixture["request"] = {
    topic: asked.topic,
    ...(asked.instructions ? { instructions: asked.instructions } : {}),
    granularity: asked.granularity,
    weeks: asked.weeks,
    daysPerWeek: asked.daysPerWeek,
    hoursPerWeek: asked.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK,
  };
  const splitEvent = record.events.find((event) => event.type === "split");
  const split = splitEvent && splitEvent.type === "split" ? splitEvent.split : record.split;
  const materials = record.materials.allocated ?? [];
  const { daysPerWeek } = request;

  const fixtureFor = (call: ModelCall, level: PlanLevel, spans: number[], tree?: PlanNode, parentId?: string): OutlineFixture => {
    if (call.endedAt === undefined) throw new Error(`${call.label}: the call has no endedAt, so its time limit is unknown`);
    const leaf = unitsAreLeaves(level, request.granularity);
    return {
      id: `${runFixtureId}/${fixtureSlug(call.label)}`,
      topic: meta.topic,
      sourceRun: basename(runDir),
      commit: meta.commit,
      label: call.label,
      group: callGroup({ parentId, leaf }),
      leaf,
      request,
      materials,
      split,
      level,
      spans,
      ...(tree ? { tree } : {}),
      ...(parentId ? { parentId } : {}),
      timeLimitMs: timeLimitMs({ endedAt: call.endedAt, latencyMs: call.latencyMs }, meta.startedAt),
      baseline: { inputTokens: call.inputTokens ?? 0, outputTokens: call.outputTokens ?? 0, ms: call.latencyMs },
    };
  };

  // #48: the block headings are dropped from the plan, so they come from replaying the call that wrote them.
  const headingsCall = calls.find((call) => BLOCK_HEADINGS.test(call.label));
  const headingsFixture = headingsCall ? fixtureFor(headingsCall, "month", weekLeafBlocks(request.weeks).map((w) => w * daysPerWeek)) : null;
  const heads = headingsCall && headingsFixture ? await replay(headingsFixture, headingsCall) : null;

  const fixtures: OutlineFixture[] = [];
  for (const call of calls) {
    if (call === headingsCall) {
      fixtures.push(headingsFixture!);
      continue;
    }
    let fixture: OutlineFixture;
    if (heads) {
      const tree = layout(makeRoot(heads.map((head) => cloneTree(head))));
      const head = blockHead(tree.children!, call.label, daysPerWeek);
      fixture = fixtureFor(call, "week", childSpans(head, daysPerWeek), tree, head.id);
    } else if (call.label.startsWith("Top level · ")) {
      fixture = fixtureFor(call, topLevelFor(request.weeks), topSpans(request.weeks, daysPerWeek));
    } else {
      if (!record.plan) throw new Error(`${call.label}: the run has no plan to rebuild the call's tree from`);
      const tree = cloneTree(record.plan);
      const { node: parent, asked } = plannedNode(tree, call.label);
      // The tree as it stood before the call: the parent not yet planned, so without its children and their problems,
      // and its length the one the call was asked to fill (a re-split level changed it).
      parent.children = null;
      delete parent.problems;
      parent.len = parent.level === "week" ? asked : asked * daysPerWeek;
      layout(tree);
      fixture = fixtureFor(call, childLevel(parent.level)!, childSpans(parent, daysPerWeek), tree, parent.id);
    }
    await replay(fixture, call);
    fixtures.push(fixture);
  }

  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) throw new Error(`${fixture.label}: a second call named ${fixture.id}`);
    ids.add(fixture.id);
  }
  const blocks = heads ? blockLabels(layout(makeRoot(heads.map((head) => cloneTree(head)))).children!, daysPerWeek) : [];
  return { fixtures, skipped: unrecorded(record.plan, calls, blocks) };
}

// ---------------------------------------------------------------------------------------------------------------
// Saved fixtures

/** A plan node as saved: the fields the prompt reads checked, the rest kept as written. */
const planNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.looseObject({
    id: z.string().min(1),
    level: planLevelSchema,
    title: z.string(),
    summary: z.string(),
    len: z.number().int(),
    status: z.enum(["pending", "generated", "completed"]),
    budgetHours: z.number().nullable(),
    manualSplit: z.boolean(),
    children: z.array(planNodeSchema).nullable(),
    start: z.number().int(),
    end: z.number().int(),
  }),
) as unknown as z.ZodType<PlanNode>;

const outlineFixtureSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  sourceRun: z.string().min(1),
  commit: z.string(),
  label: z.string().min(1),
  group: z.enum(["top", "inner", "leaves"]),
  leaf: z.boolean(),
  request: z.object({
    topic: z.string().min(1),
    instructions: z.string().optional(),
    granularity: granularitySchema,
    weeks: z.number().int().min(1),
    daysPerWeek: z.number().int().min(1),
    hoursPerWeek: z.number().positive(),
  }),
  materials: z.array(materialSchema.loose()),
  split: planSplitSchema.nullable(),
  level: planLevelSchema,
  spans: z.array(z.number().int().min(1)).min(1),
  tree: planNodeSchema.optional(),
  parentId: z.string().min(1).optional(),
  timeLimitMs: z.number().int().min(STEP_MIN_MS),
  baseline: z.object({ inputTokens: z.number(), outputTokens: z.number(), ms: z.number() }),
});

/** Where a fixture is saved: "csapp-1/week-1" is `<root>/csapp-1/outline-week-1.json`. */
export function outlineFixturePath(id: string, root: string = FIXTURES_ROOT): string {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) throw new Error(`Outline fixture id "${id}" is not "<fixture>/<call>"`);
  return join(root, id.slice(0, slash), `outline-${id.slice(slash + 1)}.json`);
}

/** Reads an outline fixture back by id. Throws an `Error` naming the id when there is none or it no longer parses. */
export function loadOutlineFixture(id: string, root: string = FIXTURES_ROOT): OutlineFixture {
  const path = outlineFixturePath(id, root);
  if (!existsSync(path)) throw new Error(`No outline fixture "${id}" under ${root}`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Outline fixture "${id}" is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = outlineFixtureSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Outline fixture "${id}" does not match today's schema (recapture it): ${z.prettifyError(parsed.error)}`);
  return parsed.data as OutlineFixture;
}
