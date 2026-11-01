import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/db/users", () => ({ signedUpAtFor: vi.fn(async () => new Date("2026-09-14T00:00:00Z")) }));
vi.mock("@/lib/ai/resolve", () => ({ resolveModels: vi.fn() }));
vi.mock("@/lib/db/credits", () => ({ getAppSpendUsd: vi.fn() }));
vi.mock("@/lib/db/generationLog", () => ({ insertGenerationLog: vi.fn() }));
vi.mock("@/lib/ai/userKeyError", () => ({ guardUserKey: (events: AsyncIterable<unknown>) => events }));
vi.mock("@/lib/ai/draftRequest", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/ai/draftRequest")>()),
  researchedDraftInput: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/planDraft", () => ({
  DRAFT_BUDGET_MS: 1000,
  streamResearchedPlanDraft: vi.fn(async function* () {}),
}));

import { streamResearchedPlanDraft } from "@/lib/ai/planDraft";
import { resolveModels, type ResolvedModel, type ResolvedModels } from "@/lib/ai/resolve";
import { getAppSpendUsd } from "@/lib/db/credits";
import { POST } from "./route";

const app: ResolvedModel = { model: "anthropic/claude-haiku-4.5", id: "anthropic/claude-haiku-4.5", keyOwner: "app" };
const user: ResolvedModel = { ...app, keyOwner: "user" };
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
  new Request("http://localhost/api/plan/draft", {
    method: "POST",
    body: JSON.stringify({ topic: "Git", weeks: 1, daysPerWeek: 5, granularity: "day", materials: [] }),
  });

beforeEach(() => {
  vi.mocked(getAppSpendUsd).mockReset();
  vi.mocked(streamResearchedPlanDraft).mockClear();
});

describe("POST /api/plan/draft", () => {
  it("refuses a new draft at zero credits before any model call", async () => {
    vi.mocked(resolveModels).mockResolvedValue(models());
    vi.mocked(getAppSpendUsd).mockResolvedValue(5);
    const res = await POST(request());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "out_of_credits" });
    expect(streamResearchedPlanDraft).not.toHaveBeenCalled();
  });

  it("drafts with credits left", async () => {
    vi.mocked(resolveModels).mockResolvedValue(models());
    vi.mocked(getAppSpendUsd).mockResolvedValue(1);
    const res = await POST(request());
    expect(res.status).toBe(200);
    await res.text();
    expect(streamResearchedPlanDraft).toHaveBeenCalledOnce();
  });

  it("counts only the roles a draft runs: the user's key paying for those is enough", async () => {
    vi.mocked(resolveModels).mockResolvedValue(models({ research: user, outline: user, allocate: user }));
    vi.mocked(getAppSpendUsd).mockResolvedValue(5);
    expect((await POST(request())).status).toBe(200);
    expect(getAppSpendUsd).not.toHaveBeenCalled();
  });
});
