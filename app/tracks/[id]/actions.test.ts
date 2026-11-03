import { beforeEach, describe, expect, it, vi } from "vitest";
import { day, sampleDayPlan } from "@/lib/testPlans";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/ai/resolve", () => ({ resolveModels: vi.fn(async () => ({ outline: { keyOwner: "app" } })) }));
vi.mock("@/lib/ai/userKeyError", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/ai/userKeyError")>()),
  guardUserKey: (events: AsyncIterable<unknown>) => events,
}));
vi.mock("@/lib/db/generationLog", () => ({ insertGenerationLog: vi.fn() }));
vi.mock("@/lib/planSummary", () => ({ summarizePlan: vi.fn(() => "summary") }));
vi.mock("@/lib/ai/planDraft", () => ({ streamExpandNode: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  getTrackDetail: vi.fn(),
  updateTrackProblems: vi.fn(),
  updateTrackStudyTime: vi.fn(),
  updateTrackSummary: vi.fn(),
}));
vi.mock("@/lib/db/planQueries", () => ({
  insertChildren: vi.fn(),
  logSession: vi.fn(),
  markLeafComplete: vi.fn(),
  replacePlanTree: vi.fn(),
}));

import { streamExpandNode } from "@/lib/ai/planDraft";
import { insertChildren, replacePlanTree } from "@/lib/db/planQueries";
import { getTrackDetail, updateTrackProblems, updateTrackStudyTime } from "@/lib/db/queries";
import { toTreeInput } from "@/lib/planInput";
import { walk } from "@/lib/planTree";
import { confirmRevisionAction, expandNodeAction } from "./actions";

const problems = ["Week 3 plans 2 h 10 min of reading in a week that gave itself 1 h for it."];

beforeEach(() => {
  vi.mocked(insertChildren).mockReset();
  vi.mocked(getTrackDetail).mockResolvedValue({
    track: { title: "Git", daysPerWeek: 5, granularity: "day", instructions: null, hoursPerWeek: 10, split: null },
    root: sampleDayPlan(),
    materials: [],
  } as never);
  vi.mocked(streamExpandNode).mockImplementation((async function* () {
    yield { type: "finish", children: [day("c1"), day("c2"), day("c3")], problems, costUsd: 0 };
  }) as never);
});

describe("expandNodeAction", () => {
  it("saves the planned week's problems with its days", async () => {
    await expandNodeAction({ trackId: "t", nodeId: "w3", reason: "expand" });
    expect(insertChildren).toHaveBeenCalledWith("t", "u1", "w3", expect.any(Array), false, problems);
  });

  it("saves them for a split too", async () => {
    await expandNodeAction({ trackId: "t", nodeId: "w3", reason: "split" });
    expect(insertChildren).toHaveBeenCalledWith("t", "u1", "w3", expect.any(Array), true, problems);
  });
});

describe("confirmRevisionAction", () => {
  beforeEach(() => {
    vi.mocked(replacePlanTree).mockReset();
    vi.mocked(updateTrackProblems).mockReset();
    vi.mocked(updateTrackStudyTime).mockReset();
  });
  /** The sample plan as the browser sends it back: every unit with a summary. */
  const tree = () => {
    const root = sampleDayPlan();
    walk(root, (n) => void (n.summary = "s"));
    return toTreeInput(root);
  };
  const confirm = (extra: Record<string, unknown>) => confirmRevisionAction({ trackId: "t", tree: tree(), materialIds: [], hoursPerWeek: 8, ...extra });

  it("writes nothing when an input is out of bounds, so the plan is never half-saved", async () => {
    await expect(confirm({ problems: Array.from({ length: 41 }, (_, i) => `Problem ${i + 1}.`) })).rejects.toThrow();
    await expect(confirm({ daysPerWeek: 0 })).rejects.toThrow();
    expect(replacePlanTree).not.toHaveBeenCalled();
    expect(updateTrackProblems).not.toHaveBeenCalled();
    expect(updateTrackStudyTime).not.toHaveBeenCalled();
  });

  it("saves the tree, its problems and the study time when every input is in bounds", async () => {
    await confirm({ problems: ["Week 1 has no time set for its activities."], daysPerWeek: 5 });
    expect(replacePlanTree).toHaveBeenCalledOnce();
    expect(updateTrackProblems).toHaveBeenCalledWith("t", "u1", ["Week 1 has no time set for its activities."]);
    expect(updateTrackStudyTime).toHaveBeenCalledWith("t", "u1", { hoursPerWeek: 8, daysPerWeek: 5, split: null });
  });
});
