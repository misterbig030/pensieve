import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/db/users", () => ({ signedUpAtFor: vi.fn(async () => new Date("2026-09-14T00:00:00Z")), userRowFor: vi.fn(async () => null) }));
vi.mock("@/lib/ai/resolve", () => ({ resolveModels: vi.fn() }));
vi.mock("@/lib/db/credits", () => ({ getAppSpendUsd: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/db/generationLog", () => ({ insertGenerationLog: vi.fn() }));
vi.mock("@/lib/ai/userKeyError", () => ({ guardUserKey: (events: AsyncIterable<unknown>) => events }));
vi.mock("@/lib/ai/planChat", () => ({ runPlanChat: vi.fn(async function* () {}) }));

import { runPlanChat } from "@/lib/ai/planChat";
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
  new Request("http://localhost/api/plan/chat", {
    method: "POST",
    body: JSON.stringify({
      mode: "create",
      topic: "Git",
      granularity: "day",
      materials: [],
      tree: [{ id: "tmp-1", level: "day", title: "Commits", summary: "Stage and commit.", len: 1 }],
      transcript: [{ role: "user", content: "Why this order?" }],
    }),
  });

beforeEach(() => {
  vi.mocked(getAppSpendUsd).mockReset();
  vi.mocked(runPlanChat).mockClear();
});

describe("POST /api/plan/chat", () => {
  it("refuses a chat turn at zero credits before any model call", async () => {
    vi.mocked(resolveModels).mockResolvedValue(models());
    vi.mocked(getAppSpendUsd).mockResolvedValue(5);
    const res = await POST(request());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "out_of_credits" });
    expect(runPlanChat).not.toHaveBeenCalled();
  });

  it("answers with credits left", async () => {
    vi.mocked(resolveModels).mockResolvedValue(models());
    vi.mocked(getAppSpendUsd).mockResolvedValue(1);
    const res = await POST(request());
    expect(res.status).toBe(200);
    await res.text();
    expect(runPlanChat).toHaveBeenCalledOnce();
  });

  it("is not checked when the user's key pays for chat and outline", async () => {
    vi.mocked(resolveModels).mockResolvedValue(models({ chat: user, outline: user }));
    vi.mocked(getAppSpendUsd).mockResolvedValue(5);
    expect((await POST(request())).status).toBe(200);
    expect(getAppSpendUsd).not.toHaveBeenCalled();
  });
});
