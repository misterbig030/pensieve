/**
 * Finds the provider refusal inside an error as the SDK or the app actually throws it: the AI SDK retries 429s and 5xx
 * and then throws a RetryError whose last attempt is the APICallError; the research loop wraps failures with a cause.
 * Dependency-free so the research modules can ask "was this the provider refusing?" without pulling in the database.
 */
import { APICallError, RetryError } from "ai";
import type { KeyErrorKind } from "./models";

export function providerError(error: unknown, depth = 4): APICallError | null {
  if (depth < 0 || error == null) return null;
  if (APICallError.isInstance(error)) return error;
  if (RetryError.isInstance(error)) return providerError(error.lastError ?? error.errors.at(-1), depth - 1);
  if (error instanceof Error && "cause" in error) return providerError(error.cause, depth - 1);
  return null;
}

/** How a provider says a key has run out of credits: Anthropic answers a 400 whose body (and message) says so. */
export const CREDITS_REFUSAL = /credit balance/i;

/** The kind of refusal, read from the APICallError inside whatever was thrown (a RetryError, a wrapped loop error). */
export function classifyProviderError(error: unknown): KeyErrorKind {
  const api = providerError(error);
  if (!api) return "other";
  const status = api.statusCode;
  if (status === 401 || status === 403) return "invalid";
  if (status === 429) return "rate_limit";
  if (status === 400 && CREDITS_REFUSAL.test(api.responseBody ?? "")) return "credits";
  return "other";
}
