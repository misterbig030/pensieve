import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sealSecret } from "@/lib/secrets";
import { AVAILABLE_MODELS, providerOf } from "./models";

vi.mock("@/lib/db/userApiKeys", () => ({ getUserApiKeys: vi.fn() }));

import { getUserApiKeys } from "@/lib/db/userApiKeys";
import { ANTHROPIC_API_IDS, DEFAULT_MODEL_IDS, appModel, keyCoversAll, onGatewayProviders, resolveModels, resolveWith, routeWith } from "./resolve";

const mockedKeys = vi.mocked(getUserApiKeys);
const SECRET = randomBytes(32).toString("base64");

function instance(m: unknown): { modelId: string; provider: string } {
  if (typeof m === "string") throw new Error("expected a model instance, got a gateway id");
  return m as { modelId: string; provider: string };
}

describe("resolveWith", () => {
  it("returns the gateway ids, paid by the app, when the user has no key", () => {
    const set = resolveWith({});
    expect(set.outline).toEqual(appModel(DEFAULT_MODEL_IDS.outline));
    expect(set.research).toEqual({ model: DEFAULT_MODEL_IDS.research, id: DEFAULT_MODEL_IDS.research, keyOwner: "app" });
  });

  it("builds direct Anthropic instances, paid by the user, for every role when they hold an Anthropic key", () => {
    const set = resolveWith({ anthropic: "sk-ant-test" });
    for (const role of ["outline", "content", "chat", "research", "allocate"] as const) {
      expect(set[role].keyOwner).toBe("user");
      expect(set[role].id).toBe(DEFAULT_MODEL_IDS[role]);
      expect(instance(set[role].model).modelId).toBe(ANTHROPIC_API_IDS[DEFAULT_MODEL_IDS[role]]);
      expect(instance(set[role].model).provider).toContain("anthropic");
    }
  });

  it("ignores a key for a provider without a direct route", () => {
    const set = resolveWith({ google: "AIza-test", openai: "sk-test" });
    expect(set.research).toEqual(appModel(DEFAULT_MODEL_IDS.research));
  });

  it("maps every Anthropic model in the list to an API id", () => {
    for (const m of AVAILABLE_MODELS) if (providerOf(m.id) === "anthropic") expect(ANTHROPIC_API_IDS[m.id], m.id).toMatch(/^claude-/);
    expect(ANTHROPIC_API_IDS["anthropic/claude-sonnet-5.5"]).toBe("claude-sonnet-5-5");
  });

  it("resolves the allocate role to Opus 5.5, on the learner's Anthropic key when they have one", () => {
    expect(DEFAULT_MODEL_IDS.allocate).toBe("anthropic/claude-opus-5.5");
    expect(resolveWith({}).allocate).toEqual({ model: "anthropic/claude-opus-5.5", id: "anthropic/claude-opus-5.5", keyOwner: "app" });
    expect(resolveWith({ anthropic: "sk-ant-test" }).allocate).toMatchObject({ id: "anthropic/claude-opus-5.5", keyOwner: "user" });
  });
});

describe("routeWith", () => {
  it("calls an Anthropic model on the user's key and any other model on the app's", () => {
    const route = routeWith({ anthropic: "sk-ant-test" });
    expect(route("anthropic/claude-haiku-5.5")).toMatchObject({ id: "anthropic/claude-haiku-5.5", keyOwner: "user" });
    expect(instance(route("anthropic/claude-haiku-5.5").model).modelId).toBe("claude-haiku-5-5");
    expect(route("openai/gpt-5.4")).toEqual(appModel("openai/gpt-5.4"));
  });
});

describe("resolveModels", () => {
  beforeEach(() => {
    mockedKeys.mockReset();
    process.env.USER_KEY_ENCRYPTION_SECRET = SECRET;
  });

  it("reads the user's rows afresh on every call, decrypts in memory and reports recorded errors", async () => {
    const sealed = sealSecret("sk-ant-live", { USER_KEY_ENCRYPTION_SECRET: SECRET });
    mockedKeys.mockResolvedValueOnce([
      { userId: "u1", provider: "anthropic", ciphertext: sealed.ciphertext, last4: "live", secretVersion: sealed.version, lastError: "credits", lastErrorAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    ]);
    const first = await resolveModels("u1");
    expect(first.research.keyOwner).toBe("user");
    expect(instance(first.research.model).modelId).toBe("claude-sonnet-5-5");
    expect(first.keyErrors).toEqual({ anthropic: true });

    mockedKeys.mockResolvedValueOnce([]); // the key was removed between requests
    const second = await resolveModels("u1");
    expect(second.research.keyOwner).toBe("app");
    expect(second.keyErrors).toEqual({});
    expect(mockedKeys).toHaveBeenCalledTimes(2);
    const typeCheck: LanguageModel | string = second.research.model;
    void typeCheck;
  });
});

describe("keyCoversAll", () => {
  it("is true only when every role's provider has a usable stored key", () => {
    expect(keyCoversAll(["anthropic"])).toBe(true); // every default today is Anthropic
    expect(keyCoversAll([])).toBe(false);
    expect(keyCoversAll(["anthropic"], ["anthropic/claude-sonnet-5.5", "google/gemini-3-flash"])).toBe(false);
  });
});

describe("onGatewayProviders", () => {
  it("sends every call only to the named providers, keeping the call's other options", async () => {
    const seen: unknown[] = [];
    const inner = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(options.providerOptions);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: undefined, reasoning: undefined } },
          warnings: [],
        };
      },
    });
    const routed = onGatewayProviders(inner, ["azure", "alibaba"]) as unknown as MockLanguageModelV4;
    await routed.doGenerate({ prompt: [], providerOptions: { gateway: { order: ["azure"] }, anthropic: { effort: "high" } } });
    expect(seen).toEqual([{ gateway: { order: ["azure"], only: ["azure", "alibaba"] }, anthropic: { effort: "high" } }]);
  });
});

describe("appModel", () => {
  it("keeps a plain gateway id for a model the gateway may route as it likes", () => {
    expect(appModel("anthropic/claude-opus-5.5").model).toBe("anthropic/claude-opus-5.5");
  });

  it("wraps a model with listed gateway providers, under its own id", () => {
    const resolved = appModel("deepseek/deepseek-v4-pro");
    expect(resolved.id).toBe("deepseek/deepseek-v4-pro");
    expect(resolved.keyOwner).toBe("app");
    expect(instance(resolved.model).modelId).toBe("deepseek/deepseek-v4-pro");
  });
});
