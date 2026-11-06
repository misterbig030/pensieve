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
import { DRAFT_BUDGET_MS, STEP_MIN_MS, draftLevel, unitsAreLeaves, weekLeafBlocks, type DraftLevelInput } from "@/lib/ai/planDraft";
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
      outlineModel,
      ...(effort ? { effort } : {}),
    },
    level: f.level,
    spans: [...f.spans],
    ...(f.tree ? { tree: cloneTree(f.tree) } : {}),
    ...(f.parentId ? { parentId: f.parentId } : {}),
    label: f.label,
  };
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
  // The prompt is checked first: a response that no longer parses matters only once the input is the recorded one.
  if (prompts.length !== 1 || prompts[0] !== call.prompt) throw new Error(`${call.label}: the rebuilt prompt differs from the recorded one`);
  if (failure) throw new Error(`${call.label}: the recorded response did not replay: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
  return nodes;
}

/** The node in `tree` whose children the call labelled `label` planned: "Week 1 · 5 days" is Week 1, planned as 5 days. */
function plannedNode(tree: PlanNode, label: string, daysPerWeek: number): PlanNode | null {
  let found: PlanNode | null = null;
  walk(tree, (node) => {
    if (found || node.id === tree.id) return;
    const level = childLevel(node.level);
    if (!level) return;
    const n = childSpans(node, daysPerWeek).length;
    if (`${fullLabelOf(tree, node)} · ${n} ${level}${n === 1 ? "" : "s"}` === label) found = node;
  });
  return found;
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

/**
 * Rebuilds every outline call a saved draft-eval run made (in recorded order, the allocation's call left out) as a
 * fixture under `runFixtureId`, each replayed through the app to check its prompt. Throws, naming the call, when one
 * cannot be rebuilt or its prompt differs; writes nothing.
 */
export async function captureOutline(runDir: string, runFixtureId: string): Promise<OutlineFixture[]> {
  const record = readRun(runDir);
  const { meta } = record;
  const calls = record.calls.filter((call) => call.caller === "outline" && call.label !== ALLOCATE_LABEL);
  if (calls.length === 0) return [];

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
      const parent = plannedNode(tree, call.label, daysPerWeek);
      if (!parent) throw new Error(`${call.label}: no unit in the plan matches the call`);
      // The tree as it stood before the call: the parent not yet planned, so without its children and their problems.
      parent.children = null;
      delete parent.problems;
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
  return fixtures;
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
