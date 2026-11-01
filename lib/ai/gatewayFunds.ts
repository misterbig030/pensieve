/**
 * Pensieve's own Vercel AI Gateway balance running out: the gateway then refuses every call on Pensieve's key, the
 * user's free credits notwithstanding. Users cannot fix that, so they are told the service is unavailable and how to
 * keep going; admins are told what to top up. Dependency-free like `providerError`, so any module can ask.
 */
import { GatewayError } from "@ai-sdk/gateway";
import { APICallError, RetryError } from "ai";

/** What the gateway says when the team's balance is empty. */
const OUT_OF_FUNDS = /positive credit balance is required/i;

export const GATEWAY_FUNDS_MESSAGE =
  "Pensieve's AI service is unavailable right now, so this stopped. Try again later, or add your own API key in Settings to keep going.";
export const GATEWAY_FUNDS_ADMIN_MESSAGE =
  "Pensieve's Vercel AI Gateway balance is empty, so every call on Pensieve's key fails. Top it up in the Vercel dashboard (AI Gateway), then try again.";
export const GATEWAY_FUNDS_LOG_LINE = "[gateway] The Vercel AI Gateway balance is empty: calls on Pensieve's key fail until it is topped up.";

/** Thrown in place of the gateway's refusal, with the message the person should see. */
export class GatewayFundsError extends Error {
  constructor(message: string = GATEWAY_FUNDS_MESSAGE) {
    super(message);
    this.name = "GatewayFundsError";
  }
}

/** Whether the gateway refused for want of funds, looking through retries and wrapped causes. */
export function isGatewayOutOfFunds(error: unknown, depth = 4): boolean {
  if (depth < 0 || error == null) return false;
  if (GatewayError.isInstance(error) && error.statusCode === 402) return true;
  if (APICallError.isInstance(error) && OUT_OF_FUNDS.test(error.responseBody ?? "")) return true;
  if (error instanceof Error && OUT_OF_FUNDS.test(error.message)) return true;
  if (RetryError.isInstance(error)) return isGatewayOutOfFunds(error.lastError ?? error.errors.at(-1), depth - 1);
  if (error instanceof Error && "cause" in error) return isGatewayOutOfFunds(error.cause, depth - 1);
  return false;
}
