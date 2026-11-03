import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { GatewayInternalServerError } from "@ai-sdk/gateway";
import { GATEWAY_FUNDS_LOG_LINE, GATEWAY_FUNDS_MESSAGE, GatewayFundsError } from "./gatewayFunds";
import type { ResolvedModels } from "./resolve";
import { UserKeyError, classifyProviderError, guardUserKey, guardUserKeyCall, refusalLogLine, userKeyMessage } from "./userKeyError";

function apiError(statusCode: number, responseBody: string) {
  return new APICallError({ message: `status ${statusCode}`, url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode, responseBody, isRetryable: false });
}
const userModel = { model: {} as never, id: "anthropic/claude-sonnet-5.5" as const, keyOwner: "user" as const };
const appModelR = { model: "anthropic/claude-sonnet-5.5" as const, id: "anthropic/claude-sonnet-5.5" as const, keyOwner: "app" as const };
const onUserKey: ResolvedModels = { outline: userModel, content: userModel, chat: userModel, research: userModel, allocate: userModel, keyErrors: {} };
const onApp: ResolvedModels = { outline: appModelR, content: appModelR, chat: appModelR, research: appModelR, allocate: appModelR, keyErrors: {} };

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

  it("counts the allocate role's key too", async () => {
    const record = vi.fn(async () => {});
    const onAllocateKey: ResolvedModels = { ...onApp, allocate: userModel };
    await expect(async () => {
      for await (const _ of guardUserKey(failing(), { userId: "u1", models: onAllocateKey, record })) void _;
    }).rejects.toBeInstanceOf(UserKeyError);
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

describe("provider errors as the SDK really throws them", () => {
  it("classifies a RetryError by its last attempt, and an error whose cause is the refusal", async () => {
    const { RetryError } = await import("ai");
    const retried = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [apiError(429, ""), apiError(429, ""), apiError(429, "")] });
    expect(classifyProviderError(retried)).toBe("rate_limit");
    const wrapped = Object.assign(new Error("research loop failed"), { cause: apiError(400, "Your credit balance is too low") });
    expect(classifyProviderError(wrapped)).toBe("credits");
    const record = vi.fn(async () => {});
    await expect(guardUserKeyCall(async () => { throw retried; }, { userId: "u1", models: onUserKey, record })).rejects.toMatchObject({ code: "rate_limit" });
    await expect(guardUserKeyCall(async () => { throw wrapped; }, { userId: "u1", models: onUserKey, record })).rejects.toMatchObject({ code: "credits" });
  });

  it("waits for the refusal to be recorded before the error reaches the caller", async () => {
    let recorded = false;
    const record = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      recorded = true;
    });
    await expect(guardUserKeyCall(async () => { throw apiError(401, ""); }, { userId: "u1", models: onUserKey, record })).rejects.toMatchObject({ code: "invalid" });
    expect(recorded).toBe(true);
  });
});

describe("the refusal in the server log", () => {
  it("names the provider, the kind, the status and what the provider said, on one line", () => {
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0.text: text content blocks must be non-empty"},\n  "request_id":"req_011"}';
    expect(refusalLogLine("anthropic", "other", apiError(400, body))).toBe(
      '[user key] Anthropic refused a request (other, status 400): {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0.text: text content blocks must be non-empty"}, "request_id":"req_011"}',
    );
  });

  it("says when the provider sent no body, and keeps a long one short", () => {
    expect(refusalLogLine("anthropic", "invalid", apiError(401, ""))).toBe("[user key] Anthropic refused a request (invalid, status 401): no body");
    const line = refusalLogLine("anthropic", "other", apiError(400, "x".repeat(5000)));
    expect(line.length).toBeLessThan(2100);
    expect(line.endsWith("…")).toBe(true);
  });

  it("is written when a user-key request is refused, and never for the app's key", async () => {
    const report = vi.fn();
    const record = vi.fn(async () => {});
    await expect(guardUserKeyCall(async () => { throw apiError(400, "bad request"); }, { userId: "u1", models: onUserKey, record, report })).rejects.toMatchObject({ code: "other" });
    expect(report).toHaveBeenCalledWith("[user key] Anthropic refused a request (other, status 400): bad request");
    report.mockClear();
    await expect(guardUserKeyCall(async () => { throw apiError(400, "bad request"); }, { userId: "u1", models: onApp, record, report })).rejects.toBeInstanceOf(APICallError);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("an empty gateway balance", () => {
  const refusal = new GatewayInternalServerError({ message: "A positive credit balance is required for all requests, including BYOK.", statusCode: 402 });
  async function* refused(): AsyncGenerator<string> {
    yield "a";
    throw refusal;
  }

  it("tells the user the service is unavailable, logs it for the operator and blames no key", async () => {
    const record = vi.fn(async () => {});
    const report = vi.fn();
    for (const models of [onApp, { ...onApp, outline: userModel }]) {
      await expect(async () => {
        for await (const _ of guardUserKey(refused(), { userId: "u1", models, record, report })) void _;
      }).rejects.toMatchObject({ name: "GatewayFundsError", message: GATEWAY_FUNDS_MESSAGE });
    }
    expect(record).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(GATEWAY_FUNDS_LOG_LINE);
  });

  it("says the same from a server action", async () => {
    const error = await guardUserKeyCall(
      async () => {
        throw refusal;
      },
      { userId: "u1", models: onApp, report: () => {} },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayFundsError);
    expect((error as Error).message).toBe(GATEWAY_FUNDS_MESSAGE);
  });
});
