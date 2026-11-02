import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanChatEvent } from "@/lib/planChat";

// The model's turn is scripted: streamText calls the tools it is told to and streams their results as the SDK does.
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamText: vi.fn() }));
vi.mock("./planRedraft", async (importOriginal) => ({ ...(await importOriginal<typeof import("./planRedraft")>()), redraftPlan: vi.fn() }));
vi.mock("./planRevision", async (importOriginal) => ({ ...(await importOriginal<typeof import("./planRevision")>()), revisePlanTree: vi.fn() }));

import { streamText } from "ai";
import type { ModelCall } from "./logged";
import { runPlanChat, type PlanChatInput } from "./planChat";
import { NothingToRedraftError, redraftPlan } from "./planRedraft";
import { LockedNodeError, revisePlanTree } from "./planRevision";
import type { ResolvedModel } from "./resolve";
import { cloneTree, layout, makeNode, makeRoot, type PlanNode } from "@/lib/planTree";

const mockedStream = vi.mocked(streamText);
const mockedRedraft = vi.mocked(redraftPlan);
const mockedRevise = vi.mocked(revisePlanTree);

const chat: ResolvedModel = { model: "anthropic/claude-haiku-4.5", id: "anthropic/claude-haiku-4.5", keyOwner: "app" };
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokenDetails: {}, outputTokenDetails: {} };

type Call = { tool: "redraftPlan" | "revisePlan"; input: unknown };

/** A turn in which the model makes `calls` in order, then answers `answer`. */
function script(calls: Call[], answer = "Done.") {
  mockedStream.mockImplementationOnce(((opts: { tools: Record<string, { execute: (input: unknown, o: unknown) => Promise<unknown> }> }) => ({
    fullStream: (async function* () {
      for (const [i, c] of calls.entries()) {
        const toolCallId = `c${i}`;
        yield { type: "tool-call", toolCallId, toolName: c.tool, input: c.input };
        try {
          const output = await opts.tools[c.tool].execute(c.input, { toolCallId, messages: [] });
          yield { type: "tool-result", toolCallId, toolName: c.tool, input: c.input, output };
        } catch (error) {
          yield { type: "tool-error", toolCallId, toolName: c.tool, input: c.input, error };
        }
      }
      yield { type: "text-delta", id: "t", text: answer };
      yield { type: "finish-step", providerMetadata: undefined };
      yield { type: "finish", totalUsage: usage, finishReason: "stop" };
    })(),
  })) as never);
}

const week = (id: string, title: string, children: PlanNode[] | null = null) => makeNode({ id, level: "week", title, summary: "s", len: 2, children });
const day = (id: string, title: string) => makeNode({ id, level: "day", title, summary: "s", len: 1 });

function weeksTree(): PlanNode {
  return layout(makeRoot([week("w1", "One"), week("w2", "Two"), week("w3", "Three", [day("d1", "Old a"), day("d2", "Old b")]), week("w4", "Four")]));
}
function monthsTree(): PlanNode {
  const month = (id: string, title: string) => makeNode({ id, level: "month", title, summary: "s", len: 4, children: [week(`${id}a`, "A"), week(`${id}b`, "B")] });
  return layout(makeRoot([month("m1", "First"), month("m2", "Second")]));
}

const request = (tree: PlanNode, over: Partial<PlanChatInput> = {}): PlanChatInput => ({
  mode: "create",
  topic: "Git",
  weeks: 4,
  daysPerWeek: 2,
  granularity: "day",
  materials: [],
  tree,
  transcript: [{ role: "user", content: "Redo it" }],
  ...over,
});

async function run(req: PlanChatInput, log?: { onCall?: (c: ModelCall) => void }): Promise<PlanChatEvent[]> {
  const events: PlanChatEvent[] = [];
  for await (const e of runPlanChat(req, { model: chat, log })) events.push(e);
  return events;
}

/** The re-draft's answer: Week 3's days replaced. */
function redrafted(tree: PlanNode): PlanNode {
  const next = cloneTree(tree);
  const w3 = next.children![2];
  w3.children = [day("n1", "New a"), day("n2", "New b")];
  return layout(next);
}

beforeEach(() => {
  mockedStream.mockReset();
  mockedRedraft.mockReset();
  mockedRevise.mockReset();
});

describe("the redraftPlan tool", () => {
  it("re-drafts a unit's level and emits revised with the new children and problems", async () => {
    const tree = weeksTree();
    mockedRedraft.mockResolvedValue({ tree: redrafted(tree), problems: ["Day 1 is too long."], costUsd: 0.25 });
    script([{ tool: "redraftPlan", input: { scope: "level", unit: "Week 3" } }]);
    const events = await run(request(tree));
    expect(mockedRedraft).toHaveBeenCalledOnce();
    expect(mockedRedraft.mock.calls[0][0]).toMatchObject({ scope: { kind: "level", parentId: "w3" }, lockBefore: 0, weeks: 4, topic: "Git" });
    const revised = events.filter((e) => e.type === "revised");
    expect(revised).toHaveLength(1);
    const ev = revised[0] as Extract<PlanChatEvent, { type: "revised" }>;
    expect(ev.tree.children![2].children!.map((d) => d.title)).toEqual(["New a", "New b"]);
    expect(ev.problems).toEqual(["Day 1 is too long."]);
    expect(ev.changed.tags.length).toBeGreaterThan(0);
    expect(ev.costUsd).toBe(0.25);
    expect(events.some((e) => e.type === "revising")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "finish" });
  });

  it("maps plan scope to the whole plan, ignoring the unit, and the top level to a null parent", async () => {
    const tree = weeksTree();
    mockedRedraft.mockResolvedValue({ tree: redrafted(tree), problems: [], costUsd: 0 });
    script([{ tool: "redraftPlan", input: { scope: "plan", unit: "Week 99" } }]);
    await run(request(tree));
    expect(mockedRedraft.mock.calls[0][0].scope).toEqual({ kind: "plan" });
    script([{ tool: "redraftPlan", input: { scope: "level", unit: null } }]);
    await run(request(tree));
    expect(mockedRedraft.mock.calls[1][0].scope).toEqual({ kind: "level", parentId: null });
  });

  it("passes the request's lockBefore in adjust mode", async () => {
    const tree = weeksTree();
    mockedRedraft.mockResolvedValue({ tree: redrafted(tree), problems: [], costUsd: 0 });
    script([{ tool: "redraftPlan", input: { scope: "plan", unit: null } }]);
    await run(request(tree, { mode: "adjust", lockBefore: 2 }));
    expect(mockedRedraft.mock.calls[0][0].lockBefore).toBe(2);
  });

  it("yields no revised, and makes no model call, for an unknown unit", async () => {
    mockedStream.mockClear();
    script([{ tool: "redraftPlan", input: { scope: "level", unit: "Week 99" } }]);
    const events = await run(request(weeksTree()));
    expect(mockedRedraft).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "revised")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("says what is wrong when the unit is a day or a unit without a level below it", async () => {
    const tree = weeksTree();
    let result: unknown;
    mockedStream.mockImplementationOnce(((opts: { tools: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }> }) => ({
      fullStream: (async function* () {
        result = [
          await opts.tools.redraftPlan.execute({ scope: "level", unit: "Week 3 · Day 1" }, { toolCallId: "a", messages: [] }),
          await opts.tools.redraftPlan.execute({ scope: "level", unit: "Week 99" }, { toolCallId: "b", messages: [] }),
        ];
        yield { type: "finish", totalUsage: usage, finishReason: "stop" };
      })(),
    })) as never);
    await run(request(tree, { granularity: "week" }));
    expect(result).toEqual([expect.stringMatching(/Day 1.*no level below/), expect.stringMatching(/No unit "Week 99"/)]);
    expect(mockedRedraft).not.toHaveBeenCalled();
  });

  it("resolves a unit by its path in a plan with months, and asks which when the label alone is ambiguous", async () => {
    const tree = monthsTree();
    mockedRedraft.mockResolvedValue({ tree, problems: [], costUsd: 0 });
    script([{ tool: "redraftPlan", input: { scope: "level", unit: "Month 2" } }]);
    await run(request(tree));
    expect(mockedRedraft.mock.calls[0][0].scope).toEqual({ kind: "level", parentId: "m2" });
    mockedRedraft.mockClear();
    let result: unknown;
    mockedStream.mockImplementationOnce(((opts: { tools: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }> }) => ({
      fullStream: (async function* () {
        result = await opts.tools.redraftPlan.execute({ scope: "level", unit: "Week 1" }, { toolCallId: "a", messages: [] });
        yield { type: "finish", totalUsage: usage, finishReason: "stop" };
      })(),
    })) as never);
    await run(request(tree, { granularity: "week" }));
    expect(result).toMatch(/more than one.*Month 1 · Week 1.*Month 2 · Week 1/);
    expect(mockedRedraft).not.toHaveBeenCalled();
  });

  it("relays a locked unit or nothing left to re-draft as the tool's answer, with no revised and no error", async () => {
    const tree = weeksTree();
    for (const err of [new LockedNodeError('"Three"'), new NothingToRedraftError("Every unit of the plan is done or started, so there is nothing left to re-draft.")]) {
      mockedRedraft.mockRejectedValueOnce(err);
      let result: unknown;
      mockedStream.mockImplementationOnce(((opts: { tools: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }> }) => ({
        fullStream: (async function* () {
          result = await opts.tools.redraftPlan.execute({ scope: "plan", unit: null }, { toolCallId: "a", messages: [] });
          yield { type: "tool-result", toolCallId: "a", toolName: "redraftPlan", input: {}, output: result };
          yield { type: "finish", totalUsage: usage, finishReason: "stop" };
        })(),
      })) as never);
      const events = await run(request(tree));
      expect(result).toContain(err.message);
      expect(events.some((e) => e.type === "revised" || e.type === "error")).toBe(false);
    }
  });

  it("lets other failures surface as the turn's error", async () => {
    mockedRedraft.mockRejectedValue(new Error("model down"));
    script([{ tool: "redraftPlan", input: { scope: "plan", unit: null } }]);
    const events = await run(request(weeksTree()));
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: "model down" });
    expect(events.some((e) => e.type === "revised")).toBe(false);
  });

  it("labels the turn's call redraftPlan in the admin log", async () => {
    const tree = weeksTree();
    mockedRedraft.mockResolvedValue({ tree: redrafted(tree), problems: [], costUsd: 0 });
    script([{ tool: "redraftPlan", input: { scope: "level", unit: "Week 3" } }]);
    const calls: ModelCall[] = [];
    await run(request(tree), { onCall: (c) => void calls.push(c) });
    expect(calls[0].label).toBe("Answer · redraftPlan");
    expect(calls[0].response).toContain("[tool call] redraftPlan: level Week 3");
    expect(calls[0].facts).toContain("tool: redraftPlan");
  });

  it("when both tools are called, the later result is the one revised tree, and a failed later call leaves the first standing", async () => {
    const tree = weeksTree();
    const first = redrafted(tree);
    const second = cloneTree(first);
    second.children![0].title = "Renamed";
    mockedRedraft.mockResolvedValue({ tree: first, problems: [], costUsd: 0.1 });
    mockedRevise.mockResolvedValue({ tree: second, problems: [], costUsd: 0.2 });
    script([
      { tool: "redraftPlan", input: { scope: "plan", unit: null } },
      { tool: "revisePlan", input: { changeRequest: "rename week 1" } },
    ]);
    const events = await run(request(tree));
    const revised = events.filter((e) => e.type === "revised") as Extract<PlanChatEvent, { type: "revised" }>[];
    expect(revised.at(-1)!.tree.children![0].title).toBe("Renamed");
    expect(events.at(-1)).toMatchObject({ type: "finish" });
  });
});
