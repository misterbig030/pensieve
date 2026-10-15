import { describe, expect, it, vi } from "vitest";
import { PROVIDER_NAMES, detectProvider, verifyProviderKey } from "./providerKeys";

describe("detectProvider", () => {
  it("reads the vendor from the key's prefix, Anthropic before OpenAI, and trims first", () => {
    expect(detectProvider("sk-ant-api03-abc")).toBe("anthropic");
    expect(detectProvider("  sk-ant-api03-abc\n")).toBe("anthropic");
    expect(detectProvider("sk-proj-abc")).toBe("openai");
    expect(detectProvider("sk-abc")).toBe("openai");
    expect(detectProvider("AIzaSyAbc")).toBe("google");
    expect(detectProvider("hello")).toBeNull();
    expect(detectProvider("")).toBeNull();
    expect(PROVIDER_NAMES.anthropic).toBe("Anthropic");
  });
});

describe("verifyProviderKey", () => {
  const withStatus = (status: number) => vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

  it("calls Anthropic's models endpoint with the key and reads the status", async () => {
    const fetchImpl = withStatus(200);
    expect(await verifyProviderKey("anthropic", "sk-ant-x", fetchImpl)).toEqual({ ok: true });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-x");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(await verifyProviderKey("anthropic", "sk-ant-x", withStatus(401))).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyProviderKey("anthropic", "sk-ant-x", withStatus(403))).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyProviderKey("anthropic", "sk-ant-x", withStatus(503))).toEqual({ ok: false, reason: "unreachable" });
  });

  it("treats a network failure as unreachable and an unrouted provider as invalid", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await verifyProviderKey("anthropic", "sk-ant-x", failing)).toEqual({ ok: false, reason: "unreachable" });
    expect(await verifyProviderKey("openai", "sk-x", withStatus(200))).toEqual({ ok: false, reason: "invalid" });
  });
});
