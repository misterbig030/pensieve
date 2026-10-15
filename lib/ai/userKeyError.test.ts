import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import type { ResolvedModels } from "./resolve";
import { UserKeyError, classifyProviderError, guardUserKey, guardUserKeyCall, userKeyMessage } from "./userKeyError";

function apiError(statusCode: number, responseBody: string) {
  return new APICallError({ message: `status ${statusCode}`, url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode, responseBody, isRetryable: false });
}
const userModel = { model: {} as never, id: "anthropic/claude-sonnet-5.5" as const, keyOwner: "user" as const };
const appModelR = { model: "anthropic/claude-sonnet-5.5" as const, id: "anthropic/claude-sonnet-5.5" as const, keyOwner: "app" as const };
const onUserKey: ResolvedModels = { outline: userModel, content: userModel, chat: userModel, research: userModel, keyErrors: {} };
const onApp: ResolvedModels = { outline: appModelR, content: appModelR, chat: appModelR, research: appModelR, keyErrors: {} };

describe("classifyProviderError", () => {
  it("reads the four kinds from the status and body, matching the credits message loosely", () => {
    expect(classifyProviderError(apiError(400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'))).toBe("credits");
    expect(classifyProviderError(apiError(400, "CREDIT BALANCE too low"))).toBe("credits");
    expect(classifyProviderError(apiError(401, '{"error":{"type":"authentication_error"}}'))).toBe("invalid");
    expect(classifyProviderError(apiError(403, ""))).toBe("invalid");
    expect(classifyProviderError(apiError(429, ""))).toBe("rate_limit");
    expect(classifyProviderError(apiError(400, "some other validation problem"))).toBe("other");
    expect(classifyProviderError(apiError(529, "overloaded"))).toBe("other");
    expect(classifyProviderError(new Error("not an API error"))).toBe("other");
  });

  it("writes the user's message per kind", () => {
    expect(userKeyMessage("anthropic", "credits")).toBe("Your Anthropic credits are exhausted, so this stopped. Add credits in the Console or remove your key in Settings to use Pensieve's.");
    expect(userKeyMessage("anthropic", "invalid")).toBe("Anthropic rejected your key. Replace it in Settings, or remove it to use Pensieve's.");
    expect(userKeyMessage("anthropic", "rate_limit")).toBe("Anthropic is rate-limiting your key. Try again in a minute.");
    expect(userKeyMessage("anthropic", "other", 529)).toBe("Anthropic returned an error for your key (status 529). Try again; if it keeps happening, check the Console.");
  });
});

describe("guardUserKey", () => {
  async function* failing(): AsyncGenerator<string> {
    yield "a";
    throw apiError(400, "credit balance is too low");
  }
  async function* fine(): AsyncGenerator<string> {
    yield "a";
  }

  it("turns a refusal on a user key into a UserKeyError and records it on the key", async () => {
    const record = vi.fn(async () => {});
    const seen: string[] = [];
    await expect(async () => {
      for await (const e of guardUserKey(failing(), { userId: "u1", models: onUserKey, record })) seen.push(e);
    }).rejects.toMatchObject({ code: "credits", provider: "anthropic", message: expect.stringContaining("credits are exhausted") });
    expect(seen).toEqual(["a"]);
    expect(record).toHaveBeenCalledWith("u1", "anthropic", "credits");
  });

  it("leaves a failure on the app's key untouched and records nothing", async () => {
    const record = vi.fn(async () => {});
    await expect(async () => {
      for await (const _ of guardUserKey(failing(), { userId: "u1", models: onApp, record })) void _;
    }).rejects.toSatisfy((e: unknown) => APICallError.isInstance(e) && !(e instanceof UserKeyError));
    expect(record).not.toHaveBeenCalled();
  });

  it("clears a recorded error once a request completes on the key, and only then", async () => {
    const clear = vi.fn(async () => {});
    for await (const _ of guardUserKey(fine(), { userId: "u1", models: { ...onUserKey, keyErrors: { anthropic: true } }, clear })) void _;
    expect(clear).toHaveBeenCalledWith("u1", "anthropic");
    clear.mockClear();
    for await (const _ of guardUserKey(fine(), { userId: "u1", models: onUserKey, clear })) void _;
    expect(clear).not.toHaveBeenCalled();
  });

  it("guards a plain promise the same way", async () => {
    const record = vi.fn(async () => {});
    await expect(
      guardUserKeyCall(async () => {
        throw apiError(401, "");
      }, { userId: "u1", models: onUserKey, record }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(record).toHaveBeenCalledWith("u1", "anthropic", "invalid");
    expect(await guardUserKeyCall(async () => 42, { userId: "u1", models: onUserKey, record })).toBe(42);
  });
});
