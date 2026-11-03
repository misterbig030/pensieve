import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRedraftRequest } from "@/lib/planChat";
import { makeNode, makeRoot, type PlanNode } from "@/lib/planTree";
import { applyRedraft, createRedraftScheduler, REDRAFT_DEBOUNCE_MS, redraftedText, requestRedraft, type RedraftChange } from "./redraft";

const week = (id: string, title: string) => makeNode({ id, level: "week", title, summary: `${title}.`, len: 5 });
const before = () => makeRoot([week("w1", "Commits"), week("w2", "Branches")]);
const after = () => makeRoot([week("w1", "Commits"), week("w3", "Rebasing")]);

const body = (hoursPerWeek: number): PlanRedraftRequest => ({
  mode: "create",
  topic: "Git",
  weeks: 2,
  daysPerWeek: 5,
  granularity: "week",
  materials: [],
  hoursPerWeek,
  split: null,
  tree: [],
  scope: { kind: "plan" },
});

const ndjson = (...events: unknown[]) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n");

describe("REDRAFT_DEBOUNCE_MS", () => {
  it("waits a second and a half for the learner to settle", () => {
    expect(REDRAFT_DEBOUNCE_MS).toBe(1500);
  });
});

describe("createRedraftScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("6 → 7 → 8 within a second sends one request, for 8 h a week, and hands back the response's tree", async () => {
    const tree = after();
    const fetchMock = vi.fn<typeof fetch>(async () => ndjson({ type: "redrafted", tree, problems: [], costUsd: 0.01 }));
    const onDone = vi.fn();
    const scheduler = createRedraftScheduler<number, Awaited<ReturnType<typeof requestRedraft>>>({
      run: (hours, signal) => requestRedraft(body(hours), { signal, fetch: fetchMock }),
      onDone,
      onFail: (_v, e) => {
        throw e;
      },
      onBusy: () => {},
    });
    scheduler.schedule(6);
    await vi.advanceTimersByTimeAsync(400);
    scheduler.schedule(7);
    await vi.advanceTimersByTimeAsync(400);
    scheduler.schedule(8);
    await vi.advanceTimersByTimeAsync(REDRAFT_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/plan/redraft");
    expect(JSON.parse(String(init?.body))).toMatchObject({ hoursPerWeek: 8, scope: { kind: "plan" } });
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0]).toBe(8);
    expect(onDone.mock.calls[0][1].tree).toEqual(JSON.parse(JSON.stringify(tree)));
  });

  it("a change while a re-draft runs aborts it, ignores its answer and re-drafts for the latest value", async () => {
    const runs: { value: number; signal: AbortSignal; resolve: (r: string) => void }[] = [];
    const onDone = vi.fn();
    const onFail = vi.fn();
    const busy: boolean[] = [];
    const scheduler = createRedraftScheduler<number, string>({
      run: (value, signal) => new Promise((resolve) => runs.push({ value, signal, resolve })),
      onDone,
      onFail,
      onBusy: (b) => busy.push(b),
    });
    scheduler.schedule(7);
    await vi.advanceTimersByTimeAsync(REDRAFT_DEBOUNCE_MS);
    expect(runs).toHaveLength(1);

    scheduler.schedule(8);
    expect(runs[0].signal.aborted).toBe(true);
    runs[0].resolve("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(onDone).not.toHaveBeenCalled();
    expect(busy.at(-1)).toBe(true);

    await vi.advanceTimersByTimeAsync(REDRAFT_DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    expect(runs[1].value).toBe(8);
    runs[1].resolve("fresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith(8, "fresh");
    expect(onFail).not.toHaveBeenCalled();
    expect(busy.at(-1)).toBe(false);
  });

  it("an aborted run's failure is ignored too", async () => {
    const onFail = vi.fn();
    const scheduler = createRedraftScheduler<number, string>({
      run: (_v, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      onDone: () => {},
      onFail,
      onBusy: () => {},
    });
    scheduler.schedule(7);
    await vi.advanceTimersByTimeAsync(REDRAFT_DEBOUNCE_MS);
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("is busy from the change until the re-draft settles", async () => {
    const busy: boolean[] = [];
    const scheduler = createRedraftScheduler<number, string>({
      run: async () => "ok",
      onDone: () => {},
      onFail: () => {},
      onBusy: (b) => busy.push(b),
    });
    scheduler.schedule(7);
    expect(busy).toEqual([true]);
    await vi.advanceTimersByTimeAsync(REDRAFT_DEBOUNCE_MS);
    expect(busy.at(-1)).toBe(false);
  });

  it("is no longer busy when putting the answer in, or the failure, throws; the error is reported", async () => {
    for (const fails of [false, true]) {
      const busy: boolean[] = [];
      const onError = vi.fn();
      const broken = new Error("render failed");
      const scheduler = createRedraftScheduler<number, string>({
        run: async () => {
          if (fails) throw new Error("server down");
          return "ok";
        },
        onDone: () => {
          throw broken;
        },
        onFail: () => {
          throw broken;
        },
        onBusy: (b) => busy.push(b),
        onError,
      });
      scheduler.schedule(7);
      await vi.advanceTimersByTimeAsync(REDRAFT_DEBOUNCE_MS);
      expect(busy).toEqual([true, false]);
      expect(onError).toHaveBeenCalledWith(broken);
    }
  });
});

describe("requestRedraft", () => {
  it("fails with the error event's message", async () => {
    const message = "Every unit of the plan is done or started, so there is nothing left to re-draft.";
    const fetchMock = vi.fn(async () => ndjson({ type: "error", message }));
    await expect(requestRedraft(body(8), { signal: new AbortController().signal, fetch: fetchMock })).rejects.toThrow(message);
  });

  it("passes call events on and fails when the stream ends without a plan", async () => {
    const call = { id: "c1" };
    const onCall = vi.fn();
    const fetchMock = vi.fn(async () => ndjson({ type: "call", call }));
    await expect(requestRedraft(body(8), { signal: new AbortController().signal, fetch: fetchMock, onCall })).rejects.toThrow();
    expect(onCall).toHaveBeenCalledWith(call);
  });
});

describe("applyRedraft", () => {
  const hours: RedraftChange = { kind: "hours", hours: 8 };

  it("replaces the workspace tree with the response's", () => {
    const next = after();
    const applied = applyRedraft({ tree: before(), summaryNote: "" }, hours, { tree: next, problems: [], costUsd: 0 });
    expect(applied.tree.children?.map((c) => c.id)).toEqual(["w1", "w3"]);
  });

  it("records an undoable change that holds the tree before, then the problems", () => {
    const prev: PlanNode = before();
    const applied = applyRedraft({ tree: prev, summaryNote: "Latest change: swapped weeks." }, hours, {
      tree: after(),
      problems: ["Week 2 runs over its hours."],
      costUsd: 0,
    });
    const [change, sys] = applied.messages;
    expect(change).toMatchObject({ kind: "change", text: "Re-drafted the open weeks for 8 h a week.", prevTree: prev, prevNote: "Latest change: swapped weeks.", undone: false, streaming: false });
    expect(change.kind === "change" && change.nodeIds).toEqual(["w3"]);
    expect(sys).toMatchObject({ kind: "sys" });
    expect(sys.kind === "sys" && sys.text).toContain("- Week 2 runs over its hours.");
    expect(applied.highlight).toEqual(["w3"]);
    expect(applied.summaryNote).toBe("Latest change: re-drafted the open weeks for 8 h a week.");
  });

  it("adds no problems line when the checks found none", () => {
    const applied = applyRedraft({ tree: before(), summaryNote: "" }, hours, { tree: after(), problems: [], costUsd: 0 });
    expect(applied.messages).toHaveLength(1);
  });
});

describe("redraftedText", () => {
  it("names the hours, or the split", () => {
    expect(redraftedText({ kind: "hours", hours: 8 })).toBe("Re-drafted the open weeks for 8 h a week.");
    expect(redraftedText({ kind: "split" })).toBe("Re-drafted the open weeks for the new time split.");
  });
});
