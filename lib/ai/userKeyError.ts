/**
 * A refusal on a user's own key, told to the user in their words and recorded on the key's row. Gateway calls are not
 * touched: the guard only acts when a model in the request runs on the user's key.
 */
import { APICallError } from "ai";
import { clearUserApiKeyError, recordUserApiKeyError } from "@/lib/db/userApiKeys";
import { providerOf, type KeyErrorKind, type ModelProvider } from "./models";
import { PROVIDER_NAMES } from "./providerKeys";
import type { ResolvedModels } from "./resolve";

export class UserKeyError extends Error {
  constructor(
    readonly provider: ModelProvider,
    readonly code: KeyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "UserKeyError";
  }
}

export function classifyProviderError(error: unknown): KeyErrorKind {
  if (!APICallError.isInstance(error)) return "other";
  const status = error.statusCode;
  if (status === 401 || status === 403) return "invalid";
  if (status === 429) return "rate_limit";
  if (status === 400 && (error.responseBody ?? "").toLowerCase().includes("credit balance")) return "credits";
  return "other";
}

export function userKeyMessage(provider: ModelProvider, kind: KeyErrorKind, status?: number): string {
  const name = PROVIDER_NAMES[provider];
  switch (kind) {
    case "credits":
      return `Your ${name} credits are exhausted, so this stopped. Add credits in the Console or remove your key in Settings to use Pensieve's.`;
    case "invalid":
      return `${name} rejected your key. Replace it in Settings, or remove it to use Pensieve's.`;
    case "rate_limit":
      return `${name} is rate-limiting your key. Try again in a minute.`;
    case "other":
      return `${name} returned an error for your key${status ? ` (status ${status})` : ""}. Try again; if it keeps happening, check the Console.`;
  }
}

export interface UserKeyGuard {
  userId: string;
  models: ResolvedModels;
  record?: typeof recordUserApiKeyError;
  clear?: typeof clearUserApiKeyError;
}

/** The providers whose key the request runs on; empty when everything is on the app's gateway key. */
function userProviders(models: ResolvedModels): ModelProvider[] {
  const roles = [models.outline, models.content, models.chat, models.research];
  return [...new Set(roles.filter((m) => m.keyOwner === "user").map((m) => providerOf(m.id)))];
}

function translate(error: unknown, guard: UserKeyGuard): unknown {
  const providers = userProviders(guard.models);
  if (providers.length === 0 || !APICallError.isInstance(error)) return error;
  const provider = providers[0];
  const kind = classifyProviderError(error);
  void (guard.record ?? recordUserApiKeyError)(guard.userId, provider, kind).catch(() => undefined);
  return new UserKeyError(provider, kind, userKeyMessage(provider, kind, error.statusCode));
}

function clearIfRecorded(guard: UserKeyGuard): void {
  for (const provider of userProviders(guard.models)) {
    if (guard.models.keyErrors[provider]) void (guard.clear ?? clearUserApiKeyError)(guard.userId, provider).catch(() => undefined);
  }
}

/** Wraps a request's event stream: a refusal on the user's key becomes a UserKeyError; a completed stream clears a recorded one. */
export async function* guardUserKey<T>(events: AsyncIterable<T>, guard: UserKeyGuard): AsyncGenerator<T> {
  try {
    for await (const event of events) yield event;
  } catch (error) {
    throw translate(error, guard);
  }
  clearIfRecorded(guard);
}

/** The same for a server action's single promise. */
export async function guardUserKeyCall<T>(run: () => Promise<T>, guard: UserKeyGuard): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    throw translate(error, guard);
  }
  clearIfRecorded(guard);
  return result;
}
