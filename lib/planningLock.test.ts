import { afterEach, describe, expect, it } from "vitest";
import { othersPlanning, setPlanning } from "./planningLock";

afterEach(() => {
  setPlanning("outline", false);
  setPlanning("pane", false);
});

describe("planningLock", () => {
  it("tells a planner when another one is under way, but not about itself", () => {
    expect(othersPlanning("pane")).toBe(false);
    setPlanning("outline", true);
    expect(othersPlanning("pane")).toBe(true);
    expect(othersPlanning("outline")).toBe(false);
    setPlanning("outline", false);
    expect(othersPlanning("pane")).toBe(false);
  });
});
