import { describe, expect, it } from "vitest";
import { APICallError, RetryError } from "ai";
import { GatewayInternalServerError } from "@ai-sdk/gateway";
import { isGatewayOutOfFunds } from "./gatewayFunds";

const SAID =
  "A positive credit balance is required for all requests, including BYOK, so fallback providers remain available. Add credits at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up to continue.";

describe("isGatewayOutOfFunds", () => {
  it("recognises the gateway's refusal as it is thrown, retried or wrapped", () => {
    const refusal = new GatewayInternalServerError({ message: SAID, statusCode: 402 });
    expect(isGatewayOutOfFunds(refusal)).toBe(true);
    expect(isGatewayOutOfFunds(new RetryError({ message: "failed", reason: "errorNotRetryable", errors: [refusal] }))).toBe(true);
    expect(isGatewayOutOfFunds(new Error("research failed", { cause: refusal }))).toBe(true);
    expect(isGatewayOutOfFunds(new Error(SAID))).toBe(true);
  });

  it("recognises a 402 from the gateway whatever its wording", () => {
    expect(isGatewayOutOfFunds(new GatewayInternalServerError({ message: "Payment required", statusCode: 402 }))).toBe(true);
  });

  it("leaves a provider's own credit refusal and other failures alone", () => {
    const anthropic = new APICallError({
      message: "Your credit balance is too low to access the Anthropic API.",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
    });
    expect(isGatewayOutOfFunds(anthropic)).toBe(false);
    expect(isGatewayOutOfFunds(new GatewayInternalServerError({ message: "Internal server error", statusCode: 500 }))).toBe(false);
    expect(isGatewayOutOfFunds(new Error("stream failed"))).toBe(false);
    expect(isGatewayOutOfFunds(null)).toBe(false);
  });
});
