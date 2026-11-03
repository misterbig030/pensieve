import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/db/users", () => ({ signedUpAtFor: vi.fn(async () => new Date("2026-09-14T00:00:00Z")), userRowFor: vi.fn(async () => null) }));
vi.mock("@/lib/ai/resolve", () => ({ resolveModels: vi.fn() }));
vi.mock("@/lib/db/credits", () => ({ getAppSpendUsd: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/db/generationLog", () => ({ insertGenerationLog: vi.fn() }));
vi.mock("@/lib/ai/userKeyError", () => ({ guardUserKey: (events: AsyncIterable<unknown>) => events }));
vi.mock("@/lib/ai/planRedraft", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/planRedraft")>()),
  redraftPlan: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import { NothingToRedraftError, redraftPlan } from "@/lib/ai/planRedraft";
import { resolveModels, type ResolvedModel, type ResolvedModels } from "@/lib/ai/resolve";
import { getAppSpendUsd } from "@/lib/db/credits";
import { readNdjson } from "@/lib/ndjson";
import { makeRoot } from "@/lib/planTree";
import { POST } from "./route";

const app: ResolvedModel = { model: "anthropic/claude-haiku-4.5", id: "anthropic/claude-haiku-4.5", keyOwner: "app" };
const models = (over: Partial<ResolvedModels> = {}): ResolvedModels => ({
  outline: app,
  content: app,
  chat: app,
  research: app,
  allocate: app,
  keyErrors: {},
  ...over,
});
const request = () =>
  new Request("http://localhost/api/plan/redraft", {
    method: "POST",
    body: JSON.stringify({
      mode: "create",
      topic: "Git",
      granularity: "week",
      materials: [],
      hoursPerWeek: 8,
      tree: [{ id: "tmp-1", level: "week", title: "Commits", summary: "Stage and commit.", len: 5 }],
      scope: { kind: "plan" },
    }),
  });

const events = async (res: Response) => {
  const seen: { type: string; [k: string]: unknown }[] = [];
  await readNdjson(res, (e: { type: string }) => seen.push(e));
  return seen;
};

beforeEach(() => {
  vi.mocked(getAppSpendUsd).mockReset().mockResolvedValue(0);
  vi.mocked(resolveModels).mockResolvedValue(models());
  vi.mocked(redraftPlan).mockReset();
});

describe("POST /api/plan/redraft", () => {
  it("rejects an unauthenticated call", async () => {
    vi.mocked(auth).mockResolvedValueOnce({ userId: null } as unknown as Awaited<ReturnType<typeof auth>>);
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(redraftPlan).not.toHaveBeenCalled();
  });

  it("refuses at zero credits before any model call", async () => {
    vi.mocked(getAppSpendUsd).mockResolvedValue(5);
    const res = await POST(request());
    expect(res.status).toBe(402);
    expect(redraftPlan).not.toHaveBeenCalled();
  });

  it("re-drafts the whole open plan for the new hours and streams the result", async () => {
    const tree = makeRoot([]);
    vi.mocked(redraftPlan).mockResolvedValue({ tree, problems: ["Day 1 runs over."], costUsd: 0.02 });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await events(res)).toEqual([{ type: "redrafted", tree: JSON.parse(JSON.stringify(tree)), problems: ["Day 1 runs over."], costUsd: 0.02 }]);
    expect(redraftPlan).toHaveBeenCalledWith(
      expect.objectContaining({ hoursPerWeek: 8, scope: { kind: "plan" }, lockBefore: 0, weeks: 1, outlineModel: app, deadline: expect.any(Number) }),
    );
  });

  it("tells the learner when nothing is left to re-draft", async () => {
    vi.mocked(redraftPlan).mockRejectedValue(new NothingToRedraftError("Every unit of the plan is done or started, so there is nothing left to re-draft."));
    const res = await POST(request());
    expect(await events(res)).toEqual([{ type: "error", message: "Every unit of the plan is done or started, so there is nothing left to re-draft." }]);
  });
});
