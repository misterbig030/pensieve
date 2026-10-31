import { describe, expect, it } from "vitest";
import { doneCount, readTicks, taskTicked, ticksKey, toggleStep, toggleTask, writeTicks } from "./dayTicks";

const steps = ["read:a@0", "read:a@1"];
const stepsOf = (id: string) => (id === "read:a" ? steps : []);

describe("ticks", () => {
  it("ticks a task with steps once all its steps are", () => {
    expect(taskTicked("read:a", steps, new Set(["read:a@0"]))).toBe(false);
    expect(taskTicked("read:a", steps, new Set(steps))).toBe(true);
    expect(taskTicked("read:a", steps, new Set(["read:a"]))).toBe(false);
  });

  it("ticks a task without steps on its own", () => {
    expect(taskTicked("lesson", [], new Set(["lesson"]))).toBe(true);
    expect(taskTicked("lesson", [], new Set())).toBe(false);
  });

  it("ticking a task ticks all its steps, and unticking clears them", () => {
    const on = toggleTask(new Set(["read:a@0"]), "read:a", steps);
    expect(taskTicked("read:a", steps, on)).toBe(true);
    const off = toggleTask(on, "read:a", steps);
    expect([...off]).toEqual([]);
  });

  it("toggles one step", () => {
    expect([...toggleStep(new Set(), "read:a@1")]).toEqual(["read:a@1"]);
    expect([...toggleStep(new Set(["read:a@1"]), "read:a@1")]).toEqual([]);
  });

  it("counts done tasks, not steps", () => {
    expect(doneCount(["read:a", "lesson"], stepsOf, new Set([...steps, "lesson"]))).toBe(2);
    expect(doneCount(["read:a", "lesson"], stepsOf, new Set(["read:a@0", "lesson"]))).toBe(1);
  });
});

describe("storage", () => {
  const store = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("reads nothing from missing, throwing or junk storage", () => {
    expect(readTicks(null, "n1").size).toBe(0);
    expect(
      readTicks(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        "n1",
      ).size,
    ).toBe(0);
    for (const junk of ["{", '{"a":1}']) expect(readTicks({ getItem: () => junk }, "n1").size).toBe(0);
    expect([...readTicks({ getItem: () => '[1,"x"]' }, "n1")]).toEqual(["x"]);
  });

  it("writes and reads back the same ticks", () => {
    const s = store();
    writeTicks(s, "n1", new Set(["lesson", "read:a@0"]));
    expect([...readTicks(s, "n1")]).toEqual(["lesson", "read:a@0"]);
    expect(readTicks(s, "n2").size).toBe(0);
    expect(s.getItem(ticksKey("n1"))).not.toBeNull();
  });

  it("does not throw when storage refuses a write", () => {
    expect(() =>
      writeTicks(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        "n1",
        new Set(["x"]),
      ),
    ).not.toThrow();
    expect(() => writeTicks(null, "n1", new Set())).not.toThrow();
  });
});
